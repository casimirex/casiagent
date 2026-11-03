import { describe, expect, test } from "bun:test";
import {
	IntakeTriggerUseCase,
	SubscriptionRegistry,
	SubscriptionRouter,
} from "@superagent/application";
import { SessionId, SourceId, TriggerStatus } from "@superagent/domain";
import {
	FakeAuthorization,
	FakeObserveLog,
	FakeSessionStore,
	FakeSubscriptionStore,
	FixedClock,
	makeEvent,
} from "./fakes";

const REPO = SourceId.of("github:org/repo");
const owner = (n: number) => ({
	workerId: `worker-${n}`,
	workItemId: `item-${n}`,
	sessionId: SessionId.of(`session-${n}`),
});

function setup() {
	const store = new FakeSessionStore();
	const subscriptionStore = new FakeSubscriptionStore();
	const registry = new SubscriptionRegistry({ store: subscriptionStore, clock: new FixedClock() });
	const router = new SubscriptionRouter({
		authorization: new FakeAuthorization(),
		observeLog: new FakeObserveLog(),
		clock: new FixedClock(),
		registry,
		intake: new IntakeTriggerUseCase({ store }),
		selfAuthorIds: new Set(["superagent-bot"]),
	});
	return { store, subscriptionStore, registry, router };
}

describe("SubscriptionRouter.routeEvent", () => {
	test("subscribe thread-A -> DIRECT to that worker; after unsubscribe -> ROUTER", async () => {
		const { registry, router } = setup();
		await registry.subscribe(REPO, "thread-A", owner(1));

		const direct = await router.routeEvent(makeEvent({ id: "e1", threadId: "thread-A" }));
		expect(direct).toMatchObject({ type: "DIRECT", workerId: "worker-1" });

		await registry.unsubscribeWorker("worker-1");
		const routed = await router.routeEvent(makeEvent({ id: "e2", threadId: "thread-A" }));
		expect(routed.type).toBe("ROUTER");
	});

	test("ROUTER takes the event in as a PENDING trigger", async () => {
		const { store, router } = setup();
		const decision = await router.routeEvent(makeEvent({ threadId: "unowned" }));
		if (decision.type !== "ROUTER") throw new Error(`expected ROUTER, got ${decision.type}`);
		expect(decision.created).toBe(true);
		expect(store.triggers.get(decision.trigger.id)?.status).toBe(TriggerStatus.PENDING);
	});

	test("DIRECT does not create a trigger", async () => {
		const { store, registry, router } = setup();
		await registry.subscribe(REPO, "thread-A", owner(1));
		await router.routeEvent(makeEvent({ threadId: "thread-A" }));
		expect(store.triggers.size).toBe(0);
	});

	test("events without a thread always go to the Router", async () => {
		const { router } = setup();
		const { threadId: _, ...event } = makeEvent();
		expect((await router.routeEvent(event)).type).toBe("ROUTER");
	});

	test("the same thread id in another source is a different thread", async () => {
		const { registry, router } = setup();
		await registry.subscribe(REPO, "42", owner(1));
		const other = makeEvent({ sourceId: SourceId.of("github:org/other"), threadId: "42" });
		expect((await router.routeEvent(other)).type).toBe("ROUTER");
	});

	test("the agent's own posts are IGNORED, so its replies can't loop back to it", async () => {
		const { store, registry, router } = setup();
		await registry.subscribe(REPO, "thread-A", owner(1));
		const own = makeEvent({ threadId: "thread-A", authorId: "superagent-bot", authorIsBot: true });
		expect((await router.routeEvent(own)).type).toBe("IGNORED");
		expect(store.triggers.size).toBe(0);
	});

	test("routing is deterministic: same registry state, same decision", async () => {
		const { registry, router } = setup();
		await registry.subscribe(REPO, "thread-A", owner(1));
		const decisions = await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				router.routeEvent(makeEvent({ id: `e${i}`, threadId: "thread-A" })),
			),
		);
		expect(new Set(decisions.map((d) => (d.type === "DIRECT" ? d.workerId : d.type)))).toEqual(
			new Set(["worker-1"]),
		);
	});
});

describe("SubscriptionRegistry", () => {
	test("the first worker keeps a thread; a second worker's subscribe is refused", async () => {
		const { registry } = setup();
		expect(await registry.subscribe(REPO, "t", owner(1))).toBe(true);
		expect(await registry.subscribe(REPO, "t", owner(2))).toBe(false);
		expect(await registry.subscribe(REPO, "t", owner(1))).toBe(true); // idempotent
		expect((await registry.lookup(makeEvent({ threadId: "t" })))?.workerId).toBe("worker-1");
	});

	test("unsubscribeWorker removes all of that worker's threads and no one else's", async () => {
		const { registry, subscriptionStore } = setup();
		await registry.subscribe(REPO, "a", owner(1));
		await registry.subscribe(REPO, "b", owner(1));
		await registry.subscribe(REPO, "c", owner(2));
		expect(await registry.unsubscribeWorker("worker-1")).toBe(2);
		expect([...subscriptionStore.byThread.values()].map((s) => s.workerId)).toEqual(["worker-2"]);
	});
});
