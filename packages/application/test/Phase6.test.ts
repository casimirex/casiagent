import { describe, expect, test } from "bun:test";
import {
	AbandonStaleWorkUseCase,
	EvaluateTriggerUseCase,
	IntakeTriggerUseCase,
	SubscriptionRegistry,
} from "@casiagent/application";
import {
	createFilterRules,
	type Session,
	SessionId,
	SessionStatus,
	SourceId,
	ThreadKey,
	TriggerStatus,
	WorkItemStatus,
} from "@casiagent/domain";
import {
	FakeAuthorization,
	FakeLlm,
	FakeObserveLog,
	FakePanel,
	FakeSessionStore,
	FakeSubscriptionStore,
	FixedClock,
	makeEvent,
} from "./fakes";

const AMBIGUOUS = { payload: { body: "the login page looks broken" } };
const DAY = 24 * 60 * 60_000;

function evaluator(maxEvaluationAttempts = 3) {
	const store = new FakeSessionStore();
	const llm = new FakeLlm();
	llm.evaluate = async () => {
		throw new Error("model unavailable");
	};
	const panel = new FakePanel();
	const evaluate = new EvaluateTriggerUseCase({
		store,
		llm,
		panel,
		rules: createFilterRules({
			allowedSourceIds: "any",
			allowedUserIds: "any",
			keywordPatterns: [],
			ignoreBots: false,
		}),
		authorizationRules: "",
		authorization: new FakeAuthorization(),
		observeLog: new FakeObserveLog(),
		clock: new FixedClock(),
		maxEvaluationAttempts,
	});
	return { store, llm, panel, evaluate, intake: new IntakeTriggerUseCase({ store }) };
}

describe("EvaluateTriggerUseCase: retry cap", () => {
	test("each LLM failure is counted; at the cap the trigger is rejected and raised on the panel", async () => {
		const { store, panel, evaluate, intake } = evaluator(3);
		const { trigger } = await intake.execute(makeEvent(AMBIGUOUS));

		const first = await evaluate.execute(trigger.id);
		const second = await evaluate.execute(trigger.id);
		expect([first.status, second.status]).toEqual(["ERROR", "ERROR"]);
		expect(store.triggers.get(trigger.id)).toMatchObject({
			status: TriggerStatus.PENDING,
			evaluationAttempts: 2,
		});
		expect(panel.items).toEqual([]);

		const third = await evaluate.execute(trigger.id);

		expect(third.status).toBe("REJECTED");
		expect(store.triggers.get(trigger.id)?.decision?.reason).toContain("failed 3 times");
		expect(store.triggers.get(trigger.id)?.decision?.reason).toContain("model unavailable");
		expect(panel.items).toMatchObject([
			{ kind: "EVALUATION_FAILED", id: `evaluation-failed:${trigger.id}` },
		]);
	});

	test("a later success after a failure is accepted normally", async () => {
		const { llm, evaluate, intake } = evaluator(3);
		const { trigger } = await intake.execute(makeEvent(AMBIGUOUS));
		await evaluate.execute(trigger.id);
		llm.evaluate = async () => ({ accepted: true, reason: "ok", priority: "normal" });
		expect((await evaluate.execute(trigger.id)).status).toBe("ACCEPTED");
	});

	test("recoverInterrupted returns EVALUATING triggers to PENDING and counts the attempt", async () => {
		const { store, evaluate, intake } = evaluator(3);
		const { trigger } = await intake.execute(makeEvent(AMBIGUOUS));
		store.setStatus(trigger.id, TriggerStatus.EVALUATING); // a process died mid-evaluation

		expect(await evaluate.recoverInterrupted()).toBe(1);
		expect(store.triggers.get(trigger.id)).toMatchObject({
			status: TriggerStatus.PENDING,
			evaluationAttempts: 1,
		});
	});

	test("recoverInterrupted also respects the cap", async () => {
		const { store, panel, evaluate, intake } = evaluator(1);
		const { trigger } = await intake.execute(makeEvent(AMBIGUOUS));
		store.setStatus(trigger.id, TriggerStatus.EVALUATING);
		await evaluate.recoverInterrupted();
		expect(store.triggers.get(trigger.id)?.status).toBe(TriggerStatus.REJECTED);
		expect(panel.items[0]?.message).toContain("interrupted");
	});
});

describe("AbandonStaleWorkUseCase", () => {
	const REPO = SourceId.of("github:org/repo");

	async function setup(waitingSinceDaysAgo: number) {
		const store = new FakeSessionStore();
		const clock = new FixedClock();
		clock.time = 100 * DAY;
		const subscriptionStore = new FakeSubscriptionStore();
		const registry = new SubscriptionRegistry({ store: subscriptionStore, clock });
		const panel = new FakePanel();
		const session: Session = {
			id: SessionId.of("s1"),
			workerId: "w1",
			workItemId: "i1",
			status: SessionStatus.WAITING,
			context: { messages: [] },
			createdAt: 0,
			updatedAt: clock.time - waitingSinceDaysAgo * DAY,
			lastHeartbeatAt: 0,
			restartCount: 0,
		};
		store.sessions.set(session.id, session);
		store.workItems.set("i1", {
			id: "i1",
			triggerId: "t1",
			assignedWorkerId: "w1",
			status: WorkItemStatus.AWAITING,
			result: { output: "Opened PR #12" },
		});
		await registry.subscribe(REPO, "12", {
			workerId: "w1",
			workItemId: "i1",
			sessionId: session.id,
		});
		const abandon = new AbandonStaleWorkUseCase({
			store,
			subscriptions: registry,
			panel,
			clock,
			maxAwaitMs: 7 * DAY,
		});
		return { store, subscriptionStore, panel, abandon, session };
	}

	test("work waiting longer than the limit is abandoned, unsubscribed and raised", async () => {
		const { store, subscriptionStore, panel, abandon, session } = await setup(8);
		await store.enqueueFollowUp(session.id, makeEvent({ id: "late-comment" }));

		const outcome = await abandon.execute();

		expect(outcome.abandoned).toEqual(["i1"]);
		expect(outcome.orphanedFollowUps.map((e) => e.id)).toEqual(["late-comment"]);
		expect(store.workItems.get("i1")?.status).toBe(WorkItemStatus.ABANDONED);
		expect(store.sessions.get("s1")?.status).toBe(SessionStatus.FAILED);
		expect(subscriptionStore.byThread.has(ThreadKey.of(REPO, "12"))).toBe(false);
		expect(panel.items).toMatchObject([{ kind: "WORK_ABANDONED", workItemId: "i1" }]);
		expect(panel.items[0]?.message).toContain("Opened PR #12");
	});

	test("work within the limit is left alone", async () => {
		const { store, panel, abandon } = await setup(6);
		expect((await abandon.execute()).abandoned).toEqual([]);
		expect(store.workItems.get("i1")?.status).toBe(WorkItemStatus.AWAITING);
		expect(panel.items).toEqual([]);
	});

	test("a follow-up that wakes the Worker between the check and the write still wins (CAS)", async () => {
		const { store, panel, abandon } = await setup(8);
		const awaiting = store.workItems.get("i1");
		if (awaiting === undefined) throw new Error("missing");
		// The use case reads AWAITING, but by the time it writes, a follow-up has claimed the work.
		const realLoad = store.loadWorkItem.bind(store);
		store.loadWorkItem = async (id: string) => {
			const seen = await realLoad(id);
			store.workItems.set("i1", { ...awaiting, status: WorkItemStatus.RUNNING });
			return seen;
		};
		expect((await abandon.execute()).abandoned).toEqual([]);
		expect(store.workItems.get("i1")?.status).toBe(WorkItemStatus.RUNNING);
		expect(store.sessions.get("s1")?.status).toBe(SessionStatus.WAITING);
		expect(panel.items).toEqual([]);
	});

	test("a follow-up that woke the Worker first wins", async () => {
		const { store, panel, abandon } = await setup(8);
		const item = store.workItems.get("i1");
		if (item === undefined) throw new Error("missing");
		store.workItems.set("i1", { ...item, status: WorkItemStatus.RUNNING });
		expect((await abandon.execute()).abandoned).toEqual([]);
		expect(store.sessions.get("s1")?.status).toBe(SessionStatus.WAITING);
		expect(panel.items).toEqual([]);
	});
});
