import { describe, expect, test } from "bun:test";
import {
	DispatchWorkUseCase,
	IntakeTriggerUseCase,
	SubscriptionRegistry,
	SubscriptionRouter,
	WorkerExecutionUseCase,
} from "@casiagent/application";
import {
	type DispatchRecord,
	RouterState,
	SessionStatus,
	type SourceEvent,
	SourceId,
	type SourcePort,
	type Subscription,
	type TaskExecutionRequest,
	ThreadKey,
	TriggerStatus,
	WorkItemStatus,
	type WorkResult,
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
const AWAIT_PR: WorkResult = {
	output: "Opened PR #99",
	status: "AWAITING_FEEDBACK",
	artifacts: [{ sourceId: REPO, threadId: "pr-99", url: "https://example.test/pr/99" }],
};
const DONE: WorkResult = { output: "Addressed review, done", status: "DONE" };

/** A controllable LLM: scripted results, optional gates to hold a call open, and concurrency tracking. */
class ScriptedLlm extends FakeLlm {
	readonly results: WorkResult[] = [];
	readonly gates: Array<Promise<void> | undefined> = [];
	inFlight = 0;
	maxInFlight = 0;
	constructor() {
		super();
		this.execute = async (req: TaskExecutionRequest) => {
			const call = this.executeCalls.length - 1;
			this.inFlight += 1;
			this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
			try {
				await this.gates[call];
				const result = this.results[call];
				if (result === undefined)
					throw new Error(`no scripted result for call ${call} (${req.workItem.id})`);
				return result;
			} finally {
				this.inFlight -= 1;
			}
		};
	}
}

/** Wait (bounded) until the LLM has been called `n` times, i.e. a run is in flight. */
async function untilCalls(llm: FakeLlm, n: number): Promise<void> {
	for (let i = 0; i < 1_000 && llm.executeCalls.length < n; i++) await Bun.sleep(1);
	if (llm.executeCalls.length < n)
		throw new Error(`LLM was called ${llm.executeCalls.length} times, expected ${n}`);
}

function gate(): { promise: Promise<void>; open: () => void } {
	let open = () => {};
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

async function setup() {
	const store = new FakeSessionStore();
	const subscriptionStore = new FakeSubscriptionStore();
	const clock = new FixedClock();
	const llm = new ScriptedLlm();
	const source = new FakeSource();
	const registry = new SubscriptionRegistry({ store: subscriptionStore, clock });
	const intake = new IntakeTriggerUseCase({ store });
	const router = new SubscriptionRouter({
		authorization: new FakeAuthorization(),
		observeLog: new FakeObserveLog(),
		clock: new FixedClock(),
		registry,
		intake,
		selfAuthorIds: new Set(["casiagent-bot"]),
	});
	const worker = new WorkerExecutionUseCase({
		panel: new FakePanel(),
		context: roomyContext(),
		store,
		llm,
		sources: new Map<SourceId, SourcePort>([[source.sourceId, source]]),
		subscriptions: registry,
		clock,
	});

	const { trigger } = await intake.execute(
		makeEvent({ id: "issue-7-opened", threadId: "issue-7", payload: { body: "fix the bug" } }),
	);
	store.setStatus(trigger.id, TriggerStatus.ACCEPTED);
	const { dispatched } = await new DispatchWorkUseCase({
		store,
		ids: new SequentialIds(),
		clock,
	}).execute(RouterState.empty());
	const record = dispatched[0] as DispatchRecord;
	return { store, subscriptionStore, llm, source, registry, router, worker, record };
}

/** Route an event and, if DIRECT, deliver it. */
async function send(
	router: SubscriptionRouter,
	worker: WorkerExecutionUseCase,
	event: SourceEvent,
) {
	const decision = await router.routeEvent(event);
	if (decision.type !== "DIRECT") return decision;
	return worker.deliverFollowUp(decision.subscription, event);
}

const review = (id: string, body = "please rename the variable") =>
	makeEvent({ id, threadId: "pr-99", authorId: "bob", payload: { body } });

describe("Worker-side subscription", () => {
	test("subscribes to the originating thread before running, then to its PR", async () => {
		const { llm, subscriptionStore, worker, record } = await setup();
		let threadsDuringRun: string[] = [];
		llm.results.push(AWAIT_PR);
		const inner = llm.execute;
		llm.execute = async (req) => {
			threadsDuringRun = [...subscriptionStore.byThread.keys()];
			return inner(req);
		};

		const outcome = await worker.execute(record);

		expect(threadsDuringRun).toEqual([ThreadKey.of(REPO, "issue-7")]);
		expect(outcome.status).toBe("AWAITING");
		expect([...subscriptionStore.byThread.keys()].sort()).toEqual(
			[ThreadKey.of(REPO, "issue-7"), ThreadKey.of(REPO, "pr-99")].sort(),
		);
	});

	test("AWAITING keeps the WorkItem open and the session WAITING (not watched as active)", async () => {
		const { store, llm, source, worker, record } = await setup();
		llm.results.push(AWAIT_PR);

		await worker.execute(record);

		expect(store.workItems.get(record.workItemId)?.status).toBe(WorkItemStatus.AWAITING);
		expect(store.sessions.get(record.sessionId)?.status).toBe(SessionStatus.WAITING);
		expect(await store.listActive()).toEqual([]);
		expect(source.replies).toEqual([{ threadId: "issue-7", body: "Opened PR #99" }]);
	});
});

describe("Direct routing of follow-ups", () => {
	test("a review comment on the PR goes straight to the Worker, which finishes and unsubscribes", async () => {
		const { store, subscriptionStore, llm, source, router, worker, record } = await setup();
		llm.results.push(AWAIT_PR, DONE);
		await worker.execute(record);

		const outcome = await send(router, worker, review("c1"));

		expect(outcome).toMatchObject({ status: "COMPLETED", orphanedFollowUps: [] });
		expect(store.triggers.size).toBe(1); // no new trigger: it bypassed the Router
		expect(store.workItems.get(record.workItemId)?.status).toBe(WorkItemStatus.COMPLETED);
		expect(store.sessions.get(record.sessionId)?.status).toBe(SessionStatus.COMPLETED);
		expect(subscriptionStore.byThread.size).toBe(0);
		expect(source.replies.at(-1)).toEqual({ threadId: "pr-99", body: "Addressed review, done" });

		// Once unsubscribed, the next event on the PR goes to the Router.
		expect((await router.routeEvent(review("c2"))).type).toBe("ROUTER");
	});

	test("the follow-up run sees the original task, its own previous answer, and the new event", async () => {
		const { llm, router, worker, record } = await setup();
		llm.results.push(AWAIT_PR, DONE);
		await worker.execute(record);
		await send(router, worker, review("c1", "rename foo to bar"));

		const messages = llm.executeCalls[1]?.context.messages ?? [];
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(messages[0]?.content).toContain("fix the bug");
		expect(messages[1]?.content).toBe("Opened PR #99");
		expect(messages[2]?.content).toContain("rename foo to bar");
	});

	test("an event that arrives while the Worker is running is queued, then handled by the same Worker", async () => {
		const { llm, router, worker, record } = await setup();
		const first = gate();
		llm.gates[0] = first.promise;
		llm.results.push(AWAIT_PR, AWAIT_PR);

		const running = worker.execute(record);
		await untilCalls(llm, 1); // first run is inside the LLM call
		// The originating thread is already subscribed, so this routes DIRECT.
		const queued = await send(
			router,
			worker,
			makeEvent({
				id: "c1",
				threadId: "issue-7",
				authorId: "alice",
				payload: { body: "also update the changelog" },
			}),
		);
		first.open();
		const outcome = await running;

		expect(queued).toEqual({ status: "QUEUED" });
		expect(outcome.status).toBe("AWAITING");
		expect(llm.executeCalls).toHaveLength(2);
		expect(JSON.stringify(llm.executeCalls[1]?.context)).toContain("also update the changelog");
		expect(llm.maxInFlight).toBe(1);
	});

	test("concurrent follow-ups never run the Worker twice at once, and none is lost", async () => {
		const { llm, router, worker, record } = await setup();
		llm.results.push(AWAIT_PR, AWAIT_PR, AWAIT_PR, AWAIT_PR);
		await worker.execute(record);

		const events = ["c1", "c2", "c3"].map((id) => review(id, `comment ${id}`));
		const outcomes = await Promise.all(events.map((e) => send(router, worker, e)));

		expect(llm.maxInFlight).toBe(1);
		const seen = llm.executeCalls
			.slice(1)
			.map((c) => JSON.stringify(c.context))
			.join("\n");
		for (const id of ["c1", "c2", "c3"]) expect(seen).toContain(`comment ${id}`);
		expect(
			outcomes.filter((o) => "status" in o && o.status === "AWAITING").length,
		).toBeGreaterThanOrEqual(1);
	});

	test("the same event delivered twice is processed once", async () => {
		const { llm, router, worker, record } = await setup();
		llm.results.push(AWAIT_PR, AWAIT_PR);
		await worker.execute(record);
		const sub = (await router.routeEvent(review("c1"))) as { subscription: Subscription };

		await worker.deliverFollowUp(sub.subscription, review("c1"));
		const again = await worker.deliverFollowUp(sub.subscription, review("c1"));

		expect(again).toEqual({ status: "DUPLICATE" });
		expect(llm.executeCalls).toHaveLength(2);
	});

	test("a follow-up for a finished WorkItem is handed back as STALE for re-routing", async () => {
		const { llm, router, worker, record } = await setup();
		llm.results.push(AWAIT_PR);
		await worker.execute(record);
		const sub = (await router.routeEvent(review("c1"))) as { subscription: Subscription };
		llm.results.push(DONE);
		await worker.deliverFollowUp(sub.subscription, review("c1"));

		const late = await worker.deliverFollowUp(sub.subscription, review("c2"));

		expect(late).toMatchObject({ status: "STALE", events: [{ id: "c2" }] });
	});

	test("an event queued during the final run is returned as orphaned, not dropped", async () => {
		const { llm, router, worker, record } = await setup();
		llm.results.push(AWAIT_PR);
		await worker.execute(record);
		const last = gate();
		llm.gates[1] = last.promise;
		llm.results.push(DONE);

		const finishing = send(router, worker, review("c1"));
		await untilCalls(llm, 2); // final run is inside the LLM call
		const queued = await send(router, worker, review("c2", "one more thing"));
		last.open();
		const outcome = await finishing;

		expect(queued).toEqual({ status: "QUEUED" });
		expect(outcome).toMatchObject({ status: "COMPLETED", orphanedFollowUps: [{ id: "c2" }] });
	});

	test("FAILED also removes the Worker's subscriptions", async () => {
		const { subscriptionStore, llm, router, worker, record } = await setup();
		llm.results.push(AWAIT_PR);
		await worker.execute(record);
		// No scripted result for call 1 -> the LLM throws.
		const outcome = await send(router, worker, review("c1"));
		expect(outcome).toMatchObject({ status: "FAILED" });
		expect(subscriptionStore.byThread.size).toBe(0);
	});

	test("the agent's own reply on the PR does not wake the Worker", async () => {
		const { llm, router, worker, record } = await setup();
		llm.results.push(AWAIT_PR);
		await worker.execute(record);
		const own = makeEvent({
			id: "bot-1",
			threadId: "pr-99",
			authorId: "casiagent-bot",
			authorIsBot: true,
		});
		expect(await send(router, worker, own)).toMatchObject({ type: "IGNORED" });
		expect(llm.executeCalls).toHaveLength(1);
	});
});
