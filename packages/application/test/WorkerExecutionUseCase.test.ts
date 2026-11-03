import { describe, expect, test } from "bun:test";
import {
	DispatchWorkUseCase,
	IntakeTriggerUseCase,
	SubscriptionRegistry,
	UseCaseError,
	WorkerExecutionUseCase,
} from "@superagent/application";
import {
	type DispatchRecord,
	RouterState,
	SessionStatus,
	type SourceId,
	type SourcePort,
	TriggerStatus,
	WorkItemStatus,
} from "@superagent/domain";
import {
	FakeLlm,
	FakePanel,
	FakeSessionStore,
	FakeSource,
	FakeSubscriptionStore,
	FixedClock,
	makeEvent,
	roomyContext,
	SequentialIds,
} from "./fakes";

async function setup(bodies: readonly string[] = ["fix the flaky test"]) {
	const store = new FakeSessionStore();
	const clock = new FixedClock();
	const llm = new FakeLlm();
	const source = new FakeSource();
	const intake = new IntakeTriggerUseCase({ store });
	for (const [i, body] of bodies.entries()) {
		const { trigger } = await intake.execute(
			makeEvent({ id: `evt-${i}`, threadId: `pr-${i}`, payload: { body }, timestamp: i }),
		);
		store.setStatus(trigger.id, TriggerStatus.ACCEPTED);
	}
	const { dispatched } = await new DispatchWorkUseCase({
		store,
		ids: new SequentialIds(),
		clock,
	}).execute(RouterState.empty());
	const sources = new Map<SourceId, SourcePort>([[source.sourceId, source]]);
	const subscriptionStore = new FakeSubscriptionStore();
	const subscriptions = new SubscriptionRegistry({ store: subscriptionStore, clock });
	const worker = new WorkerExecutionUseCase({
		panel: new FakePanel(),
		context: roomyContext(),
		store,
		llm,
		sources,
		subscriptions,
		clock,
	});
	return {
		store,
		clock,
		llm,
		source,
		sources,
		subscriptions,
		subscriptionStore,
		worker,
		dispatched,
	};
}

function only<T>(items: readonly T[]): T {
	const [first] = items;
	if (items.length !== 1 || first === undefined)
		throw new Error(`expected 1 item, got ${items.length}`);
	return first;
}

describe("WorkerExecutionUseCase", () => {
	test("runs the task, completes WorkItem and session, and replies in the originating thread", async () => {
		const { store, clock, source, worker, dispatched } = await setup();
		const record = only(dispatched);
		clock.time = 2_000;

		const outcome = await worker.execute(record);

		expect(outcome.status).toBe("COMPLETED");
		if (outcome.status !== "COMPLETED") return;
		expect(outcome.delivery).toEqual({ delivered: true });
		expect(store.workItems.get(record.workItemId)?.status).toBe(WorkItemStatus.COMPLETED);
		expect(store.workItems.get(record.workItemId)?.result).toEqual({
			output: `done: ${record.workItemId}`,
		});
		const session = store.sessions.get(record.sessionId);
		expect(session?.status).toBe(SessionStatus.COMPLETED);
		expect(session?.updatedAt).toBe(2_000);
		expect(source.replies).toEqual([{ threadId: "pr-0", body: `done: ${record.workItemId}` }]);
	});

	test("the LLM sees only this Worker's context", async () => {
		const { llm, worker, dispatched } = await setup(["task A secret", "task B secret"]);

		await Promise.all(dispatched.map((r) => worker.execute(r)));

		expect(llm.executeCalls).toHaveLength(2);
		for (const call of llm.executeCalls) {
			const seen = JSON.stringify(call);
			expect(seen.includes("task A secret") && seen.includes("task B secret")).toBe(false);
			expect(seen).not.toContain("RouterState");
		}
	});

	test("an LLM failure marks WorkItem and session FAILED and sends no reply", async () => {
		const { store, llm, source, worker, dispatched } = await setup();
		llm.execute = async () => {
			throw new Error("model overloaded");
		};
		const record = only(dispatched);

		const outcome = await worker.execute(record);

		expect(outcome).toMatchObject({ status: "FAILED", error: "model overloaded" });
		expect(store.workItems.get(record.workItemId)?.status).toBe(WorkItemStatus.FAILED);
		expect(store.sessions.get(record.sessionId)?.status).toBe(SessionStatus.FAILED);
		expect(source.replies).toEqual([]);
	});

	test("a failed reply keeps the result and reports it, without re-running the task", async () => {
		const { store, llm, source, worker, dispatched } = await setup();
		source.failWith = new Error("GitHub 502");
		const record = only(dispatched);

		const outcome = await worker.execute(record);

		expect(outcome).toMatchObject({
			status: "COMPLETED",
			delivery: { delivered: false, reason: "GitHub 502" },
		});
		expect(store.workItems.get(record.workItemId)?.status).toBe(WorkItemStatus.COMPLETED);
		expect(llm.executeCalls).toHaveLength(1);
	});

	test("reports undelivered when no source is registered for the trigger", async () => {
		const { store, llm, clock, subscriptions, dispatched } = await setup();
		const worker = new WorkerExecutionUseCase({
			panel: new FakePanel(),
			context: roomyContext(),
			store,
			llm,
			sources: new Map(),
			subscriptions,
			clock,
		});
		const outcome = await worker.execute(only(dispatched));
		expect(outcome).toMatchObject({ status: "COMPLETED", delivery: { delivered: false } });
	});

	test("resumes a WorkItem that is already RUNNING", async () => {
		const { store, worker, dispatched } = await setup();
		const record = only(dispatched);
		const item = store.workItems.get(record.workItemId);
		if (item === undefined) throw new Error("missing work item");
		store.workItems.set(item.id, { ...item, status: WorkItemStatus.RUNNING });

		const outcome = await worker.execute(record);

		expect(outcome.status).toBe("COMPLETED");
	});

	test("refuses to run a WorkItem for a different worker", async () => {
		const { worker, dispatched } = await setup();
		const record: DispatchRecord = { ...only(dispatched), workerId: "intruder" };
		await expect(worker.execute(record)).rejects.toThrow(UseCaseError);
	});

	test("refuses to re-run a finished WorkItem", async () => {
		const { worker, dispatched } = await setup();
		const record = only(dispatched);
		await worker.execute(record);
		await expect(worker.execute(record)).rejects.toThrow(
			/illegal status transition COMPLETED -> RUNNING/,
		);
	});
});
