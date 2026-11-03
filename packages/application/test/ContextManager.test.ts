import { describe, expect, test } from "bun:test";
import { approximateTokens, ContextManager } from "@superagent/application";
import { type ContextMessage, type Session, SessionId, SessionStatus } from "@superagent/domain";
import { FakeSpill } from "./fakes";

const TASK: ContextMessage = { role: "user", content: "TASK: fix the flaky checkout test" };

/** `count` messages of `tokensEach` tokens (approx. 4 chars per token), alternating roles. */
function conversation(count: number, tokensEach: number): ContextMessage[] {
	return Array.from({ length: count }, (_, i) => ({
		role: i % 2 === 0 ? ("assistant" as const) : ("user" as const),
		content: `msg-${i} ${"x".repeat(tokensEach * 4 - 12)}`,
	}));
}

function session(messages: ContextMessage[]): Session {
	return {
		id: SessionId.of("s1"),
		workerId: "w",
		workItemId: "i",
		status: SessionStatus.ACTIVE,
		context: { messages },
		createdAt: 0,
		updatedAt: 0,
		lastHeartbeatAt: 0,
		restartCount: 0,
	};
}

function setup(budgetTokens = 2_000) {
	const spill = new FakeSpill();
	return { spill, cm: new ContextManager({ spill, budgetTokens }) };
}

describe("ContextManager", () => {
	test("under budget: context is unchanged and nothing is spilled", async () => {
		const { spill, cm } = setup();
		const s = session([TASK, ...conversation(3, 100)]);
		const { session: out, context } = await cm.getWorkingContext(s);
		expect(out).toBe(s);
		expect(context).toBe(s.context);
		expect(spill.logs.size).toBe(0);
	});

	test("10,000 tokens into a 2,000-token budget: only the budgeted portion stays inline", async () => {
		const { spill, cm } = setup(2_000);
		const history = conversation(20, 500); // ~10,000 tokens
		expect(cm.tokens(history)).toBeGreaterThanOrEqual(10_000);

		const { session: out, context } = await cm.getWorkingContext(session([TASK, ...history]));

		const inline = out.context.messages;
		expect(cm.tokens(context.messages)).toBeLessThanOrEqual(2_000);
		expect(cm.tokens(inline)).toBeLessThanOrEqual(1_500); // budget minus the 25% recall share
		expect(inline[0]).toEqual(TASK); // the task is never spilled
		expect(inline[1]?.content).toStartWith("[context-spill]");
		expect(inline.at(-1)).toEqual(history.at(-1) as ContextMessage); // newest kept
		// Nothing is lost: inline real messages + spilled = the original history.
		const spilled = spill.logs.get("s1")?.map((m) => m.message) ?? [];
		expect([...spilled, ...inline.slice(2)]).toEqual(history);
	});

	test("compacting again keeps one pointer with the updated total", async () => {
		const { spill, cm } = setup(2_000);
		const first = await cm.compact(session([TASK, ...conversation(20, 500)]));
		const grown = session([...first.context.messages, ...conversation(6, 500)]);

		const second = await cm.compact(grown);

		const pointers = second.context.messages.filter((m) => m.content.startsWith("[context-spill]"));
		expect(pointers).toHaveLength(1);
		const total = spill.logs.get("s1")?.length ?? 0;
		expect(pointers[0]?.content).toContain(`${total} earlier message(s)`);
		expect(cm.tokens(second.context.messages)).toBeLessThanOrEqual(1_500);
	});

	test("a pointer is kept even when the context later fits", async () => {
		const { cm } = setup(2_000);
		const compacted = await cm.compact(session([TASK, ...conversation(20, 500)]));
		const again = await cm.compact(compacted);
		expect(again.context.messages.some((m) => m.content.startsWith("[context-spill]"))).toBe(true);
	});

	test("chain-of-recall: spilled messages relevant to the latest request come back, but are not persisted", async () => {
		const { cm } = setup(2_000);
		const decision: ContextMessage = {
			role: "assistant",
			content: "Decided to keep the retry wrapper around paymentGateway calls.",
		};
		const history = [decision, ...conversation(20, 500)];
		history.push({ role: "user", content: "Why did we keep the paymentGateway retry wrapper?" });

		const { session: out, context } = await cm.getWorkingContext(session([TASK, ...history]));

		expect(out.context.messages).not.toContainEqual(decision);
		const recall = context.messages.find((m) => m.content.startsWith("[recalled-context]"));
		expect(recall?.content).toContain("keep the retry wrapper");
		expect(out.context.messages.some((m) => m.content.startsWith("[recalled-context]"))).toBe(
			false,
		);
		expect(cm.tokens(context.messages)).toBeLessThanOrEqual(2_000);
	});

	test("a single message larger than the budget is truncated inline and spilled in full", async () => {
		const { spill, cm } = setup(2_000);
		const huge: ContextMessage = { role: "tool", content: `LOG ${"y".repeat(40_000)}` };

		const out = await cm.compact(session([TASK, huge]));

		const last = out.context.messages.at(-1);
		expect(last?.content).toStartWith("LOG ");
		expect(last?.content).toContain("[truncated");
		expect(cm.tokens(out.context.messages)).toBeLessThanOrEqual(1_500);
		expect(spill.logs.get("s1")?.[0]?.message).toEqual(huge);
	});

	test("approximateTokens is about 4 characters per token", () => {
		expect(approximateTokens("")).toBe(0);
		expect(approximateTokens("abcd")).toBe(1);
		expect(approximateTokens("abcde")).toBe(2);
	});
});
