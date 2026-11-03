import { describe, expect, test } from "bun:test";
import { InMemorySessionStore, InMemorySubscriptionStore } from "@superagent/adapters";
import {
	SessionId,
	type SourceEvent,
	SourceId,
	type Subscription,
	ThreadKey,
} from "@superagent/domain";

const REPO = SourceId.of("github:org/repo");
const sub = (thread: string, worker: string): Subscription => ({
	threadKey: ThreadKey.of(REPO, thread),
	workerId: worker,
	workItemId: `item-${worker}`,
	sessionId: SessionId.of(`session-${worker}`),
	createdAt: 0,
});
const event = (id: string): SourceEvent => ({
	id,
	sourceId: REPO,
	threadId: "pr-1",
	authorId: "bob",
	authorIsBot: false,
	payload: { body: id },
	timestamp: 0,
});

describe("InMemorySubscriptionStore", () => {
	test("first subscriber keeps the thread; the call returns who owns it", async () => {
		const store = new InMemorySubscriptionStore();
		expect((await store.subscribe(sub("t", "w1"))).workerId).toBe("w1");
		expect((await store.subscribe(sub("t", "w2"))).workerId).toBe("w1");
		expect((await store.findByThread(ThreadKey.of(REPO, "t")))?.workerId).toBe("w1");
	});

	test("removeByWorker removes only that worker's threads", async () => {
		const store = new InMemorySubscriptionStore();
		await store.subscribe(sub("a", "w1"));
		await store.subscribe(sub("b", "w1"));
		await store.subscribe(sub("c", "w2"));
		expect(await store.removeByWorker("w1")).toBe(2);
		expect(await store.listByWorker("w1")).toEqual([]);
		expect(await store.listByWorker("w2")).toHaveLength(1);
	});

	test("returned values are copies", async () => {
		const store = new InMemorySubscriptionStore();
		await store.subscribe(sub("t", "w1"));
		const found = (await store.findByThread(ThreadKey.of(REPO, "t"))) as { workerId: string };
		found.workerId = "intruder";
		expect((await store.findByThread(ThreadKey.of(REPO, "t")))?.workerId).toBe("w1");
	});
});

describe("InMemorySessionStore follow-up inbox", () => {
	const s1 = SessionId.of("s1");

	test("enqueue, count, drain in order; drain empties the inbox", async () => {
		const store = new InMemorySessionStore();
		await store.enqueueFollowUp(s1, event("a"));
		await store.enqueueFollowUp(s1, event("b"));
		expect(await store.countFollowUps(s1)).toBe(2);
		expect((await store.drainFollowUps(s1)).map((e) => e.id)).toEqual(["a", "b"]);
		expect(await store.countFollowUps(s1)).toBe(0);
		expect(await store.drainFollowUps(s1)).toEqual([]);
	});

	test("an event id is accepted once per session, even after it was drained", async () => {
		const store = new InMemorySessionStore();
		expect(await store.enqueueFollowUp(s1, event("a"))).toBe(true);
		expect(await store.enqueueFollowUp(s1, event("a"))).toBe(false);
		await store.drainFollowUps(s1);
		expect(await store.enqueueFollowUp(s1, event("a"))).toBe(false);
		expect(await store.enqueueFollowUp(SessionId.of("s2"), event("a"))).toBe(true);
	});

	test("compareAndSetWorkItem only applies when the status matches", async () => {
		const store = new InMemorySessionStore();
		await store.saveWorkItem({ id: "w", triggerId: "t", status: "AWAITING" });
		const running = { id: "w", triggerId: "t", status: "RUNNING" } as const;
		expect(await store.compareAndSetWorkItem("AWAITING", running)).toEqual(running);
		expect(await store.compareAndSetWorkItem("AWAITING", running)).toBeUndefined();
	});
});
