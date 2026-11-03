import { describe, expect, test } from "bun:test";
import { DispatchWorkUseCase, IntakeTriggerUseCase } from "@superagent/application";
import { RouterState, TriggerStatus, WorkItemStatus } from "@superagent/domain";
import { FakeSessionStore, FixedClock, makeEvent, SequentialIds } from "./fakes";

async function acceptedTriggers(store: FakeSessionStore, bodies: readonly string[]) {
	const intake = new IntakeTriggerUseCase({ store });
	const ids: string[] = [];
	for (const [i, body] of bodies.entries()) {
		const { trigger } = await intake.execute(
			makeEvent({ id: `evt-${i}`, threadId: `thread-${i}`, payload: { body }, timestamp: i }),
		);
		await store.compareAndSetTriggerStatus(
			trigger.id,
			TriggerStatus.PENDING,
			TriggerStatus.ACCEPTED,
		);
		ids.push(trigger.id);
	}
	return ids;
}

function setup() {
	const store = new FakeSessionStore();
	const dispatch = new DispatchWorkUseCase({
		store,
		ids: new SequentialIds(),
		clock: new FixedClock(),
	});
	return { store, dispatch };
}

describe("DispatchWorkUseCase", () => {
	test("creates a WorkItem, worker and ACTIVE session per accepted trigger, and consumes it", async () => {
		const { store, dispatch } = setup();
		const [triggerId] = await acceptedTriggers(store, ["fix the bug"]);

		const { dispatched, state } = await dispatch.execute(RouterState.empty());

		expect(dispatched).toHaveLength(1);
		const record = dispatched[0];
		if (record === undefined) throw new Error("expected a dispatch record");
		expect(record.triggerId).toBe(triggerId as string);
		expect(store.triggers.get(record.triggerId)?.status).toBe(TriggerStatus.CONSUMED);
		expect(store.workItems.get(record.workItemId)).toEqual({
			id: record.workItemId,
			triggerId: record.triggerId,
			assignedWorkerId: record.workerId,
			status: WorkItemStatus.PENDING,
		});
		const session = store.sessions.get(record.sessionId);
		expect(session?.workerId).toBe(record.workerId);
		expect(session?.status).toBe("ACTIVE");
		expect(state.recordFor(record.triggerId)).toEqual(record);
	});

	test("ignores triggers that are not ACCEPTED", async () => {
		const { store, dispatch } = setup();
		await new IntakeTriggerUseCase({ store }).execute(makeEvent()); // stays PENDING
		const { dispatched } = await dispatch.execute(RouterState.empty());
		expect(dispatched).toEqual([]);
	});

	test("returns a new RouterState and leaves the input state unchanged", async () => {
		const { store, dispatch } = setup();
		await acceptedTriggers(store, ["a"]);
		const before = RouterState.empty();
		const { state } = await dispatch.execute(before);
		expect(before.size).toBe(0);
		expect(state.size).toBe(1);
	});

	test("two concurrent dispatches yield distinct workers with isolated contexts", async () => {
		const { store, dispatch } = setup();
		await acceptedTriggers(store, ["fix login bug", "update the README"]);

		const [a, b] = await Promise.all([
			dispatch.execute(RouterState.empty()),
			dispatch.execute(RouterState.empty()),
		]);
		const all = [...a.dispatched, ...b.dispatched];

		// Every trigger dispatched exactly once, across both calls.
		expect(all).toHaveLength(2);
		expect(new Set(all.map((r) => r.triggerId)).size).toBe(2);
		expect(new Set(all.map((r) => r.workerId)).size).toBe(2);
		expect(new Set(all.map((r) => r.sessionId)).size).toBe(2);

		// Each context holds only its own trigger's data.
		const contexts = all.map((r) => JSON.stringify(store.sessions.get(r.sessionId)?.context));
		expect(contexts.filter((c) => c.includes("fix login bug"))).toHaveLength(1);
		expect(contexts.filter((c) => c.includes("update the README"))).toHaveLength(1);
		for (const c of contexts) {
			expect(c.includes("fix login bug") && c.includes("update the README")).toBe(false);
		}
	});

	test("a trigger already in RouterState is skipped", async () => {
		const { store, dispatch } = setup();
		const [triggerId] = await acceptedTriggers(store, ["a"]);
		const state = RouterState.empty().withDispatched([
			{ triggerId: triggerId as string, workItemId: "w", workerId: "x", sessionId: "s" as never },
		]);
		const { dispatched } = await dispatch.execute(state);
		expect(dispatched).toEqual([]);
	});

	test("Worker context never contains Router state", async () => {
		const { store, dispatch } = setup();
		await acceptedTriggers(store, ["first"]);
		const first = await dispatch.execute(RouterState.empty());
		await acceptedTriggers(store, ["first", "second"]); // evt-0 already exists; evt-1 is new
		const second = await dispatch.execute(first.state);

		const record = second.dispatched[0];
		if (record === undefined) throw new Error("expected a dispatch record");
		const context = JSON.stringify(store.sessions.get(record.sessionId)?.context);
		const firstRecord = first.dispatched[0];
		expect(context).not.toContain(firstRecord?.workerId);
		expect(context).not.toContain(firstRecord?.triggerId);
	});
});
