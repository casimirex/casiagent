import { describe, expect, test } from "bun:test";
import { InMemorySessionStore } from "@superagent/adapters";
import {
	type Session,
	SessionId,
	SessionStatus,
	SourceId,
	type Trigger,
	TriggerStatus,
} from "@superagent/domain";

function session(id: string, status: SessionStatus = SessionStatus.ACTIVE): Session {
	return {
		id: SessionId.of(id),
		workerId: `worker-${id}`,
		workItemId: `item-${id}`,
		status,
		context: { messages: [{ role: "user", content: `task ${id}` }] },
		createdAt: 0,
		updatedAt: 0,
		lastHeartbeatAt: 0,
		restartCount: 0,
	};
}

function trigger(
	id: string,
	timestamp: number,
	status: TriggerStatus = TriggerStatus.ACCEPTED,
): Trigger {
	return {
		id,
		sourceId: SourceId.of("github:org/repo"),
		authorId: "alice",
		authorIsBot: false,
		payload: { body: id },
		timestamp,
		status,
	};
}

/** Simulates a caller mutating an object it got from (or gave to) the store. */
function mutate(value: object): void {
	(value as { context: { messages: unknown[] } }).context.messages.push({
		role: "user",
		content: "LEAK",
	});
}

describe("InMemorySessionStore isolation", () => {
	test("mutating a loaded session does not affect stored state or other readers", async () => {
		const store = new InMemorySessionStore();
		await store.save(session("a"));

		const first = await store.load(SessionId.of("a"));
		if (first === undefined) throw new Error("missing");
		mutate(first);

		const second = await store.load(SessionId.of("a"));
		expect(second?.context.messages).toHaveLength(1);
	});

	test("mutating the object after save does not affect stored state", async () => {
		const store = new InMemorySessionStore();
		const s = session("a");
		await store.save(s);
		mutate(s);
		expect((await store.load(SessionId.of("a")))?.context.messages).toHaveLength(1);
	});

	test("sessions never share context objects", async () => {
		const store = new InMemorySessionStore();
		await store.save(session("a"));
		await store.save(session("b"));
		const [a, b] = await store.listActive();
		if (a === undefined || b === undefined) throw new Error("missing");
		mutate(a);
		expect(b.context.messages).toHaveLength(1);
	});
});

describe("InMemorySessionStore behaviour", () => {
	test("listActive returns only ACTIVE and STALLED sessions", async () => {
		const store = new InMemorySessionStore();
		await store.save(session("a", SessionStatus.ACTIVE));
		await store.save(session("b", SessionStatus.STALLED));
		await store.save(session("c", SessionStatus.COMPLETED));
		await store.save(session("d", SessionStatus.FAILED));
		const ids = (await store.listActive()).map((s) => s.id as string).sort();
		expect(ids).toEqual(["a", "b"]);
	});

	test("createTrigger does not overwrite an existing trigger", async () => {
		const store = new InMemorySessionStore();
		expect(await store.createTrigger(trigger("t", 1, TriggerStatus.ACCEPTED))).toBe(true);
		expect(await store.createTrigger(trigger("t", 1, TriggerStatus.PENDING))).toBe(false);
		expect((await store.loadTrigger("t"))?.status).toBe(TriggerStatus.ACCEPTED);
	});

	test("listTriggersByStatus filters by status and sorts oldest first", async () => {
		const store = new InMemorySessionStore();
		await store.createTrigger(trigger("late", 30));
		await store.createTrigger(trigger("early", 10));
		await store.createTrigger(trigger("other", 20, TriggerStatus.PENDING));
		const ids = (await store.listTriggersByStatus(TriggerStatus.ACCEPTED)).map((t) => t.id);
		expect(ids).toEqual(["early", "late"]);
	});

	test("compareAndSetTrigger: exactly one of many concurrent claims wins", async () => {
		const store = new InMemorySessionStore();
		await store.createTrigger(trigger("t", 1));
		const consumed = trigger("t", 1, TriggerStatus.CONSUMED);
		const claims = await Promise.all(
			Array.from({ length: 10 }, () =>
				store.compareAndSetTrigger(TriggerStatus.ACCEPTED, consumed),
			),
		);
		expect(claims.filter((c) => c !== undefined)).toHaveLength(1);
		expect((await store.loadTrigger("t"))?.status).toBe(TriggerStatus.CONSUMED);
	});

	test("compareAndSetTrigger returns undefined for unknown ids", async () => {
		const store = new InMemorySessionStore();
		expect(
			await store.compareAndSetTrigger(TriggerStatus.ACCEPTED, trigger("nope", 1)),
		).toBeUndefined();
	});

	test("compareAndSetTrigger stores the full replacement, including the decision", async () => {
		const store = new InMemorySessionStore();
		await store.createTrigger(trigger("t", 1, TriggerStatus.PENDING));
		const next: Trigger = {
			...trigger("t", 1, TriggerStatus.REJECTED),
			decision: { stage: "FAST_FILTER", reason: "bot", priority: "normal" },
		};
		await store.compareAndSetTrigger(TriggerStatus.PENDING, next);
		expect(await store.loadTrigger("t")).toEqual(next);
	});

	test("countWorkItemsByStatus counts only the given statuses", async () => {
		const store = new InMemorySessionStore();
		await store.saveWorkItem({ id: "a", triggerId: "t", status: "PENDING" });
		await store.saveWorkItem({ id: "b", triggerId: "t", status: "RUNNING" });
		await store.saveWorkItem({ id: "c", triggerId: "t", status: "COMPLETED" });
		expect(await store.countWorkItemsByStatus(["PENDING", "RUNNING"])).toBe(2);
		expect(await store.countWorkItemsByStatus([])).toBe(0);
	});

	test("work items round-trip", async () => {
		const store = new InMemorySessionStore();
		const item = { id: "w", triggerId: "t", assignedWorkerId: "x", status: "PENDING" } as const;
		await store.saveWorkItem(item);
		expect(await store.loadWorkItem("w")).toEqual(item);
		expect(await store.loadWorkItem("missing")).toBeUndefined();
	});
});
