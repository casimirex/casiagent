import { describe, expect, test } from "bun:test";
import {
	DispatchWorkUseCase,
	EvaluateTriggerUseCase,
	IntakeTriggerUseCase,
	SubscriptionRegistry,
	SubscriptionRouter,
	WorkerExecutionUseCase,
} from "@casiagent/application";
import {
	type AuthorizationDecision,
	createFilterRules,
	type DispatchRecord,
	RouterState,
	SessionId,
	type SourceEvent,
	SourceId,
	type SourcePort,
	TriggerStatus,
} from "@casiagent/domain";
import {
	FakeAuthorization,
	FakeLlm,
	FakeObserveLog,
	FakePanel,
	FakeSessionStore,
	FakeSource,
	FakeSubscriptionStore,
	FixedClock,
	makeEvent,
	roomyContext,
	SequentialIds,
} from "./fakes";

const REPO = SourceId.of("github:org/repo");
const rules = createFilterRules({
	allowedSourceIds: "any",
	allowedUserIds: "any",
	keywordPatterns: ["fix (the )?bug"],
	ignoreBots: false,
});

function evaluator(decision: AuthorizationDecision) {
	const store = new FakeSessionStore();
	const llm = new FakeLlm();
	const authorization = new FakeAuthorization();
	authorization.decide = () => ({ decision, reason: `test says ${decision}` });
	const observeLog = new FakeObserveLog();
	const evaluate = new EvaluateTriggerUseCase({
		store,
		llm,
		rules,
		authorizationRules: "",
		authorization,
		observeLog,
		clock: new FixedClock(),
	});
	return {
		store,
		llm,
		authorization,
		observeLog,
		evaluate,
		intake: new IntakeTriggerUseCase({ store }),
	};
}

describe("EvaluateTriggerUseCase: authorization comes first", () => {
	test("DENY rejects before the filter or the LLM runs", async () => {
		const { store, llm, evaluate, intake } = evaluator("DENY");
		const { trigger } = await intake.execute(makeEvent({ payload: { body: "fix the bug" } }));

		const outcome = await evaluate.execute(trigger.id);

		expect(outcome.status).toBe("REJECTED");
		expect(store.triggers.get(trigger.id)?.decision).toMatchObject({ stage: "AUTHORIZATION" });
		expect(llm.evaluateCalls).toHaveLength(0);
	});

	test("OBSERVE_ONLY: trigger OBSERVED, intended action logged, no WorkItem ever created", async () => {
		const { store, observeLog, evaluate, intake } = evaluator("OBSERVE_ONLY");
		const { trigger } = await intake.execute(
			makeEvent({
				explicitRequest: false,
				payload: { body: "someone should fix the bug in billing" },
			}),
		);

		const outcome = await evaluate.execute(trigger.id);
		const { dispatched } = await new DispatchWorkUseCase({
			store,
			ids: new SequentialIds(),
			clock: new FixedClock(),
		}).execute(RouterState.empty());

		expect(outcome.status).toBe("OBSERVED");
		expect(store.triggers.get(trigger.id)?.status).toBe(TriggerStatus.OBSERVED);
		expect(dispatched).toEqual([]);
		expect(store.workItems.size).toBe(0);
		const entry = observeLog.entries.get(`observe:${trigger.id}`);
		expect(entry?.intendedAction).toBe(
			"Act on inferred request: someone should fix the bug in billing",
		);
		expect(entry?.rationale).toBe("test says OBSERVE_ONLY");
	});

	test("the action's origin reflects whether the human asked the agent", async () => {
		const { authorization, evaluate, intake } = evaluator("ALLOW");
		const a = await intake.execute(makeEvent({ id: "a", explicitRequest: true }));
		const b = await intake.execute(makeEvent({ id: "b", explicitRequest: false }));
		await evaluate.execute(a.trigger.id);
		await evaluate.execute(b.trigger.id);
		expect(authorization.calls.map((c) => c.action.origin)).toEqual([
			"EXPLICIT_REQUEST",
			"INFERRED",
		]);
	});

	test("ALLOW continues to the two-stage filter", async () => {
		const { evaluate, intake } = evaluator("ALLOW");
		const { trigger } = await intake.execute(makeEvent({ payload: { body: "fix the bug" } }));
		expect(await evaluate.execute(trigger.id)).toMatchObject({
			status: "ACCEPTED",
			decision: { stage: "FAST_FILTER" },
		});
	});
});

describe("SubscriptionRouter: DIRECT follow-ups are authorized", () => {
	async function router(decide: (user: string) => AuthorizationDecision) {
		const store = new FakeSessionStore();
		const registry = new SubscriptionRegistry({
			store: new FakeSubscriptionStore(),
			clock: new FixedClock(),
		});
		await registry.subscribe(REPO, "pr-9", {
			workerId: "worker-1",
			workItemId: "item-1",
			sessionId: SessionId.of("s1"),
		});
		const authorization = new FakeAuthorization();
		authorization.decide = (user) => ({ decision: decide(user), reason: `test: ${user}` });
		const observeLog = new FakeObserveLog();
		const r = new SubscriptionRouter({
			registry,
			intake: new IntakeTriggerUseCase({ store }),
			selfAuthorIds: new Set(),
			authorization,
			observeLog,
			clock: new FixedClock(),
		});
		return { r, authorization, observeLog, store };
	}
	const comment = (author: string): SourceEvent =>
		makeEvent({ id: `c-${author}`, threadId: "pr-9", authorId: author, payload: { body: "do X" } });

	test("allowed authors reach the Worker; the check uses the FOLLOW_UP origin", async () => {
		const { r, authorization } = await router(() => "ALLOW");
		expect((await r.routeEvent(comment("ci-bot"))).type).toBe("DIRECT");
		expect(authorization.calls[0]?.action.origin).toBe("FOLLOW_UP");
	});

	test("a denied commenter cannot instruct the Worker, and no trigger is created", async () => {
		const { r, store } = await router((u) => (u === "mallory" ? "DENY" : "ALLOW"));
		expect(await r.routeEvent(comment("mallory"))).toMatchObject({ type: "IGNORED" });
		expect(store.triggers.size).toBe(0);
	});

	test("OBSERVE_ONLY follow-ups are logged, not delivered", async () => {
		const { r, observeLog } = await router(() => "OBSERVE_ONLY");
		expect((await r.routeEvent(comment("bob"))).type).toBe("OBSERVED");
		expect([...observeLog.entries.values()][0]?.intendedAction).toContain("worker-1");
	});

	test("events with no subscriber are not authorized here (evaluation does that)", async () => {
		const { r, authorization } = await router(() => "DENY");
		const decision = await r.routeEvent(makeEvent({ threadId: "elsewhere" }));
		expect(decision.type).toBe("ROUTER");
		expect(authorization.calls).toHaveLength(0);
	});
});

describe("WorkerExecutionUseCase: surfaces what needs a human", () => {
	async function worker() {
		const store = new FakeSessionStore();
		const clock = new FixedClock();
		const llm = new FakeLlm();
		const source = new FakeSource();
		const panel = new FakePanel();
		const { trigger } = await new IntakeTriggerUseCase({ store }).execute(makeEvent());
		store.setStatus(trigger.id, TriggerStatus.ACCEPTED);
		const { dispatched } = await new DispatchWorkUseCase({
			store,
			ids: new SequentialIds(),
			clock,
		}).execute(RouterState.empty());
		const w = new WorkerExecutionUseCase({
			store,
			llm,
			sources: new Map<SourceId, SourcePort>([[source.sourceId, source]]),
			subscriptions: new SubscriptionRegistry({ store: new FakeSubscriptionStore(), clock }),
			context: roomyContext(),
			panel,
			clock,
		});
		return { w, llm, source, panel, record: dispatched[0] as DispatchRecord };
	}

	test("a successful, delivered result raises nothing (healthy work stays quiet)", async () => {
		const { w, panel, record } = await worker();
		await w.execute(record);
		expect(panel.items).toEqual([]);
	});

	test("a failed task raises WORKER_FAILED", async () => {
		const { w, llm, panel, record } = await worker();
		llm.execute = async () => {
			throw new Error("model refused");
		};
		await w.execute(record);
		expect(panel.items).toMatchObject([
			{
				kind: "WORKER_FAILED",
				workItemId: record.workItemId,
				message: expect.stringContaining("model refused"),
			},
		]);
	});

	test("an undelivered result raises DELIVERY_FAILED including the result", async () => {
		const { w, source, panel, record } = await worker();
		source.failWith = new Error("GitHub 502");
		await w.execute(record);
		expect(panel.items).toMatchObject([{ kind: "DELIVERY_FAILED" }]);
		expect(panel.items[0]?.message).toContain("GitHub 502");
		expect(panel.items[0]?.message).toContain(`done: ${record.workItemId}`);
	});

	test("a question or review request from the Worker is raised with its link", async () => {
		const { w, llm, panel, record } = await worker();
		llm.execute = async () => ({
			output: "Opened PR #12",
			status: "AWAITING_FEEDBACK",
			attention: {
				kind: "REVIEW_REQUEST",
				message: "Please review PR #12",
				url: "https://x.test/pr/12",
			},
		});
		await w.execute(record);
		expect(panel.items).toMatchObject([
			{ kind: "REVIEW_REQUEST", message: "Please review PR #12", url: "https://x.test/pr/12" },
		]);
	});
});
