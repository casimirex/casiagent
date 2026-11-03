import { describe, expect, test } from "bun:test";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ClaudeLlmAdapter, ModelRefusalError, toMessages } from "@casiagent/adapters";
import { EXECUTE_TASK_SYSTEM_PROMPT } from "@casiagent/application";
import type { TaskExecutionRequest } from "@casiagent/domain";
import { z } from "zod";
import { FakeAnthropic } from "./fakeAnthropic";

const VERDICT = { accepted: true, reason: "maintainer asked explicitly", priority: "high" };

function adapter(
	fake: FakeAnthropic,
	options: ConstructorParameters<typeof ClaudeLlmAdapter>[0] = {},
) {
	return new ClaudeLlmAdapter({ client: fake.client(), ...options });
}

const task: TaskExecutionRequest = {
	workItem: { id: "w1", triggerId: "t1", assignedWorkerId: "x", status: "RUNNING" },
	context: {
		messages: [
			{ role: "user", content: "TASK: fix the flaky test" },
			{ role: "system", content: "[context-spill] 3 earlier message(s)…" },
			{ role: "assistant", content: "Opened PR #12" },
			{ role: "user", content: "CI failure: test_checkout" },
		],
	},
};

/** The tools sent in request `i`; fails the test if that request or its tools are missing. */
function sentTools(
	fake: FakeAnthropic,
	i: number,
): Array<{ name: string; eager_input_streaming?: boolean }> {
	const tools = fake.requests[i]?.body.tools;
	if (!Array.isArray(tools)) throw new Error(`request ${i} has no tools`);
	return tools;
}

const submit = (input: unknown) => ({ tool: "submit_result", input });
const SUBMITTED = { output: "Fixed it", status: "DONE" };

describe("ClaudeLlmAdapter.evaluateTrigger", () => {
	test("sends the prompt with low effort, a verdict schema and refusal fallbacks; returns the verdict", async () => {
		const fake = new FakeAnthropic();
		fake.turns.push({ blocks: [{ text: JSON.stringify(VERDICT) }], stop_reason: "end_turn" });

		const verdict = await adapter(fake).evaluateTrigger({
			triggerId: "t1",
			promptVersion: "v2",
			prompt: "EVALUATE ME",
		});

		expect(verdict).toEqual(VERDICT as typeof verdict);
		const req = fake.requests[0];
		expect(req?.body).toMatchObject({
			model: "claude-opus-5-5",
			messages: [{ role: "user", content: "EVALUATE ME" }],
			output_config: { effort: "low", format: { type: "json_schema" } },
			fallbacks: "default",
		});
		expect(req?.body.stream).toBeUndefined();
		expect(req?.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
	});

	test("a refusal fails closed: rejected, with the category in the reason", async () => {
		const fake = new FakeAnthropic();
		fake.turns.push({ blocks: [], stop_reason: "refusal", refusalCategory: "cyber" });
		const verdict = await adapter(fake).evaluateTrigger({
			triggerId: "t1",
			promptVersion: "v2",
			prompt: "x",
		});
		expect(verdict.accepted).toBe(false);
		expect(verdict.reason).toContain("cyber");
	});

	test("a cut-off answer is an error (the use case returns the trigger to PENDING)", async () => {
		const fake = new FakeAnthropic();
		fake.turns.push({ blocks: [{ text: '{"accepted": tr' }], stop_reason: "max_tokens" });
		await expect(
			adapter(fake).evaluateTrigger({ triggerId: "t1", promptVersion: "v2", prompt: "x" }),
		).rejects.toThrow();
	});

	test("with refusal fallbacks off, neither the parameter nor the beta is sent", async () => {
		const fake = new FakeAnthropic();
		fake.turns.push({ blocks: [{ text: JSON.stringify(VERDICT) }], stop_reason: "end_turn" });
		await adapter(fake, { refusalFallbacks: false }).evaluateTrigger({
			triggerId: "t",
			promptVersion: "v",
			prompt: "x",
		});
		expect(fake.requests[0]?.body.fallbacks).toBeUndefined();
		expect(fake.requests[0]?.headers.get("anthropic-beta") ?? "").not.toContain(
			"server-side-fallback",
		);
	});
});

describe("ClaudeLlmAdapter.executeTask", () => {
	test("streams with a cached system prompt, high effort and a task budget; returns the submitted result", async () => {
		const fake = new FakeAnthropic();
		fake.turns.push(
			{
				blocks: [
					{ text: "Done." },
					submit({
						output: "Opened PR #13",
						status: "AWAITING_FEEDBACK",
						artifacts: [{ sourceId: "github:org/repo", threadId: "13", url: "https://x.test/13" }],
						attention: { kind: "REVIEW_REQUEST", message: "Please review #13" },
					}),
				],
				stop_reason: "tool_use",
			},
			{ blocks: [{ text: "Submitted." }], stop_reason: "end_turn" },
		);

		const result = await adapter(fake).executeTask(task);

		expect(result).toEqual({
			output: "Opened PR #13",
			status: "AWAITING_FEEDBACK",
			artifacts: [
				{ sourceId: "github:org/repo" as never, threadId: "13", url: "https://x.test/13" },
			],
			attention: { kind: "REVIEW_REQUEST", message: "Please review #13" },
		});
		const first = fake.requests[0]?.body;
		expect(first).toMatchObject({
			model: "claude-opus-5-5",
			stream: true,
			max_tokens: 64_000,
			system: [
				{ type: "text", text: EXECUTE_TASK_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
			],
			output_config: { effort: "high", task_budget: { type: "tokens", total: 200_000 } },
			fallbacks: "default",
		});
		expect(fake.requests[0]?.headers.get("anthropic-beta")).toContain("task-budgets-2026-03-13");
		expect(sentTools(fake, 0).at(-1)).toMatchObject({
			name: "submit_result",
			eager_input_streaming: true,
		});
		// The tool result went back once, and no turn ran after the model acknowledged it.
		expect(fake.requests).toHaveLength(2);
	});

	test("the Worker context is sent in order, with our notes tagged as user text", async () => {
		const fake = new FakeAnthropic();
		fake.turns.push(
			{ blocks: [submit(SUBMITTED)], stop_reason: "tool_use" },
			{ blocks: [{ text: "ok" }], stop_reason: "end_turn" },
		);
		await adapter(fake).executeTask(task);
		expect(fake.requests[0]?.body.messages).toEqual([
			{ role: "user", content: "TASK: fix the flaky test" },
			{ role: "user", content: "[context note]\n[context-spill] 3 earlier message(s)…" },
			{ role: "assistant", content: "Opened PR #12" },
			{ role: "user", content: "CI failure: test_checkout" },
		]);
	});

	test("an invalid artifact is returned to the model as a tool error, and it can correct itself", async () => {
		const fake = new FakeAnthropic();
		fake.turns.push(
			{
				blocks: [
					submit({ ...SUBMITTED, artifacts: [{ sourceId: "not a source", threadId: "1" }] }),
				],
				stop_reason: "tool_use",
			},
			{
				blocks: [
					submit({ ...SUBMITTED, artifacts: [{ sourceId: "github:org/repo", threadId: "1" }] }),
				],
				stop_reason: "tool_use",
			},
			{ blocks: [{ text: "ok" }], stop_reason: "end_turn" },
		);

		const result = await adapter(fake).executeTask(task);

		expect(result.artifacts?.[0]?.threadId).toBe("1");
		const errorTurn = fake.requests[1]?.body.messages.at(-1)?.content as Array<{
			type: string;
			is_error?: boolean;
			content?: unknown;
		}>;
		expect(errorTurn[0]).toMatchObject({ type: "tool_result", is_error: true });
		expect(JSON.stringify(errorTurn[0]?.content)).toContain("Invalid artifact sourceId");
	});

	test("an input that fails the schema is rejected before it becomes a result", async () => {
		const fake = new FakeAnthropic();
		fake.turns.push(
			{ blocks: [submit({ output: "", status: "MAYBE" })], stop_reason: "tool_use" },
			{ blocks: [submit(SUBMITTED)], stop_reason: "tool_use" },
			{ blocks: [{ text: "ok" }], stop_reason: "end_turn" },
		);
		expect(await adapter(fake).executeTask(task)).toEqual(SUBMITTED as never);
		const retry = fake.requests[1]?.body.messages.at(-1)?.content as Array<{ is_error?: boolean }>;
		expect(retry[0]?.is_error).toBe(true);
	});

	test("ending without submit_result is an error, not a silent DONE", async () => {
		const fake = new FakeAnthropic();
		fake.turns.push({ blocks: [{ text: "I think it's fixed." }], stop_reason: "end_turn" });
		await expect(adapter(fake).executeTask(task)).rejects.toThrow(/without calling submit_result/);
	});

	test("a refusal raises ModelRefusalError with the category", async () => {
		const fake = new FakeAnthropic();
		fake.turns.push({ blocks: [], stop_reason: "refusal", refusalCategory: "bio" });
		const error = await adapter(fake)
			.executeTask(task)
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ModelRefusalError);
		expect(String(error)).toContain("bio");
	});

	test("a response cut off at max_tokens is an error", async () => {
		const fake = new FakeAnthropic();
		fake.turns.push({ blocks: [{ text: "partial" }], stop_reason: "max_tokens" });
		await expect(adapter(fake).executeTask(task)).rejects.toThrow(/max_tokens/);
	});

	test(
		"the wall-clock timeout aborts a hung request",
		async () => {
			const fake = new FakeAnthropic();
			fake.turns.push("hang");
			const started = performance.now();
			await expect(adapter(fake, { taskTimeoutMs: 50 }).executeTask(task)).rejects.toThrow();
			// The adapter's own limit fired, not the fake client's 3 s backstop.
			expect(performance.now() - started).toBeLessThan(1_000);
		},
		{ timeout: 5_000 },
	);

	test("once a result is submitted, no further turns run even if the model keeps going", async () => {
		const fake = new FakeAnthropic();
		fake.turns.push(
			{ blocks: [submit(SUBMITTED)], stop_reason: "tool_use" },
			// The model ignores "end your turn" and asks for another tool.
			{
				blocks: [{ tool: "submit_result", input: { output: "again", status: "DONE" } }],
				stop_reason: "tool_use",
			},
		);
		expect(await adapter(fake).executeTask(task)).toEqual(SUBMITTED as never);
		expect(fake.requests).toHaveLength(2); // a third request would fail: no scripted turn
	});

	test("toolset tools are offered and run; the briefing is sent; dispose always runs", async () => {
		const fake = new FakeAnthropic();
		const calls: string[] = [];
		let disposed = 0;
		const readFile = betaZodTool({
			name: "read_file",
			description: "Read a file",
			inputSchema: z.object({ path: z.string() }),
			run: async ({ path }) => {
				calls.push(path);
				return "file contents";
			},
		});
		const toolsets = async () => ({
			tools: [readFile],
			briefing: "Repository checked out at /work/w1",
			dispose: async () => {
				disposed += 1;
			},
		});
		fake.turns.push(
			{ blocks: [{ tool: "read_file", input: { path: "src/a.ts" } }], stop_reason: "tool_use" },
			{ blocks: [submit(SUBMITTED)], stop_reason: "tool_use" },
			{ blocks: [{ text: "ok" }], stop_reason: "end_turn" },
		);

		await adapter(fake, { toolsets }).executeTask(task);
		fake.turns.push({ blocks: [], stop_reason: "refusal" });
		await adapter(fake, { toolsets })
			.executeTask(task)
			.catch(() => {});

		expect(calls).toEqual(["src/a.ts"]);
		expect(sentTools(fake, 0).map((t) => t.name)).toEqual(["read_file", "submit_result"]);
		expect(fake.requests[0]?.body.messages.at(-1)).toEqual({
			role: "user",
			content: "[setup]\nRepository checked out at /work/w1",
		});
		expect(disposed).toBe(2);
	});
});

describe("toMessages", () => {
	test("a context ending on the Worker's own answer gets a user nudge (resumed run)", () => {
		expect(
			toMessages([
				{ role: "user", content: "task" },
				{ role: "assistant", content: "working" },
			]).at(-1),
		).toEqual({
			role: "user",
			content: "Continue the task from where you left off.",
		});
	});

	test("tool output is tagged; user and assistant text pass through", () => {
		expect(
			toMessages([
				{ role: "user", content: "a" },
				{ role: "tool", content: "b" },
			]),
		).toEqual([
			{ role: "user", content: "a" },
			{ role: "user", content: "[tool output]\nb" },
		]);
	});
});
