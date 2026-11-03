/**
 * A fake Claude API behind the real SDK: a `fetch` that answers POST /v1/messages from a
 * script, as JSON or as a server-sent event stream (when the request has stream: true).
 * Records every request so tests can assert on what the adapter sent.
 */
import Anthropic from "@anthropic-ai/sdk";

export type FakeBlock =
	| { readonly text: string }
	| { readonly tool: string; readonly input: unknown; readonly id?: string };

export interface FakeTurn {
	readonly blocks: readonly FakeBlock[];
	readonly stop_reason: "end_turn" | "tool_use" | "max_tokens" | "refusal";
	readonly refusalCategory?: string;
}

export interface RecordedRequest {
	readonly headers: Headers;
	readonly body: Record<string, unknown> & {
		messages: Array<{ role: string; content: unknown }>;
		stream?: boolean;
	};
}

export class FakeAnthropic {
	readonly requests: RecordedRequest[] = [];
	readonly turns: Array<FakeTurn | "hang"> = [];
	#n = 0;

	client(): Anthropic {
		// A short SDK timeout so a request that is never aborted cannot hang the test process.
		return new Anthropic({
			apiKey: "test-key",
			maxRetries: 0,
			timeout: 3_000,
			fetch: (url, init) => this.#fetch(url, init),
		});
	}

	async #fetch(_url: unknown, init?: RequestInit): Promise<Response> {
		const body = JSON.parse(String(init?.body)) as RecordedRequest["body"];
		this.requests.push({ headers: new Headers(init?.headers), body });
		const turn = this.turns.shift();
		if (turn === undefined)
			throw new Error(`fake: no scripted turn for request ${this.requests.length}`);
		if (turn === "hang") {
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason ?? new Error("aborted")),
				);
			});
		}
		return body.stream === true ? this.#sse(turn) : this.#json(turn);
	}

	#content(turn: FakeTurn) {
		return turn.blocks.map((b) =>
			"text" in b
				? { type: "text", text: b.text }
				: { type: "tool_use", id: b.id ?? `toolu_${++this.#n}`, name: b.tool, input: b.input },
		);
	}

	#message(turn: FakeTurn, content: unknown[]) {
		return {
			id: `msg_${++this.#n}`,
			type: "message",
			role: "assistant",
			model: "claude-opus-5-5",
			content,
			stop_reason: turn.stop_reason,
			stop_sequence: null,
			stop_details:
				turn.stop_reason === "refusal"
					? { type: "refusal", category: turn.refusalCategory ?? null, explanation: "declined" }
					: null,
			usage: { input_tokens: 10, output_tokens: 5 },
		};
	}

	#json(turn: FakeTurn): Response {
		return Response.json(this.#message(turn, this.#content(turn)), {
			headers: { "request-id": "req_fake" },
		});
	}

	#sse(turn: FakeTurn): Response {
		const events: Array<[string, unknown]> = [];
		const content = this.#content(turn);
		const start = this.#message(turn, []);
		events.push([
			"message_start",
			{ type: "message_start", message: { ...start, stop_reason: null } },
		]);
		content.forEach((block, index) => {
			if (block.type === "text") {
				events.push([
					"content_block_start",
					{ type: "content_block_start", index, content_block: { type: "text", text: "" } },
				]);
				events.push([
					"content_block_delta",
					{ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
				]);
			} else {
				events.push([
					"content_block_start",
					{
						type: "content_block_start",
						index,
						content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
					},
				]);
				events.push([
					"content_block_delta",
					{
						type: "content_block_delta",
						index,
						delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
					},
				]);
			}
			events.push(["content_block_stop", { type: "content_block_stop", index }]);
		});
		events.push([
			"message_delta",
			{
				type: "message_delta",
				delta: {
					stop_reason: turn.stop_reason,
					stop_sequence: null,
					stop_details: start.stop_details,
				},
				usage: { output_tokens: 5 },
			},
		]);
		events.push(["message_stop", { type: "message_stop" }]);
		const text = events
			.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
			.join("");
		return new Response(text, {
			headers: { "content-type": "text/event-stream", "request-id": "req_fake" },
		});
	}
}
