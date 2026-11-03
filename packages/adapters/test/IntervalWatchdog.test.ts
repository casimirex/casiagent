import { describe, expect, test } from "bun:test";
import {
	InMemoryAttentionStore,
	InMemorySessionStore,
	InMemorySubscriptionStore,
	IntervalWatchdog,
	type IntervalWatchdogDeps,
} from "@casiagent/adapters";
import { type Session, SessionId, SessionStatus, WorkItemStatus } from "@casiagent/domain";
import { session, subscription, workItem } from "./contracts/fixtures";

class ManualClock {
	time = 0;
	now() {
		return this.time;
	}
}

function setup(overrides: Partial<IntervalWatchdogDeps> = {}) {
	const store = new InMemorySessionStore();
	const subscriptions = new InMemorySubscriptionStore();
	const attention = new InMemoryAttentionStore();
	const clock = new ManualClock();
	const restarts: Session[] = [];
	const watchdog = new IntervalWatchdog({
		store,
		subscriptions,
		attention,
		clock,
		intervalMs: 30_000,
		onRestart: async (s) => {
			restarts.push(s);
		},
		...overrides,
	});
	return { store, subscriptions, attention, clock, restarts, watchdog };
}

const S = SessionId.of("a");

describe("IntervalWatchdog", () => {
	test("leaves sessions with recent heartbeats alone (threshold = 3 x interval)", async () => {
		const { store, clock, restarts, watchdog } = setup();
		await store.save(session("a"));
		clock.time = 90_000;
		expect(await watchdog.check()).toEqual({ restarted: [], escalated: [] });
		expect(restarts).toEqual([]);
	});

	test("a silent session is marked STALLED, counted, given a grace period, and restarted", async () => {
		const { store, clock, restarts, watchdog } = setup();
		await store.save(session("a"));
		clock.time = 90_001;

		expect((await watchdog.check()).restarted).toEqual([S]);
		await Bun.sleep(0);

		const stored = await store.load(S);
		expect(stored).toMatchObject({
			status: SessionStatus.STALLED,
			restartCount: 1,
			lastHeartbeatAt: 90_001,
		});
		expect(restarts.map((s) => s.id)).toEqual([S]);
		// Grace period: the next pass right away does not restart it again.
		expect((await watchdog.check()).restarted).toEqual([]);
	});

	test("heartbeat() keeps a session alive", async () => {
		const { store, clock, watchdog } = setup();
		await store.save(session("a"));
		clock.time = 80_000;
		await watchdog.heartbeat(S);
		clock.time = 150_000;
		expect((await watchdog.check()).restarted).toEqual([]);
	});

	test("after 3 restarts it escalates: session and WorkItem failed, subscriptions removed, human alerted", async () => {
		const { store, subscriptions, attention, clock, restarts, watchdog } = setup();
		await store.save(session("a"));
		await store.saveWorkItem(workItem("item-a", WorkItemStatus.RUNNING));
		await subscriptions.subscribe(subscription("pr-1", "worker-a"));

		for (let i = 1; i <= 4; i++) {
			clock.time = i * 100_000;
			await watchdog.check();
		}
		await Bun.sleep(0);

		expect(restarts).toHaveLength(3);
		expect((await store.load(S))?.status).toBe(SessionStatus.FAILED);
		expect((await store.loadWorkItem("item-a"))?.status).toBe(WorkItemStatus.FAILED);
		expect(await subscriptions.listByWorker("worker-a")).toEqual([]);
		expect(attention.list()).toEqual([
			{
				id: "watchdog:a",
				kind: "WATCHDOG_ESCALATION",
				message: expect.stringContaining("after 3 restarts"),
				sessionId: "a",
				workItemId: "item-a",
				createdAt: 400_000,
			},
		]);
		// Failed sessions are no longer supervised.
		clock.time = 1_000_000;
		expect(await watchdog.check()).toEqual({ restarted: [], escalated: [] });
	});

	test("a never-started (PENDING) WorkItem is ABANDONED on escalation", async () => {
		const { store, clock, watchdog } = setup({ maxRestarts: 0 });
		await store.save(session("a"));
		await store.saveWorkItem(workItem("item-a", WorkItemStatus.PENDING));
		clock.time = 100_000;
		await watchdog.check();
		expect((await store.loadWorkItem("item-a"))?.status).toBe(WorkItemStatus.ABANDONED);
	});

	test("WAITING sessions are not supervised", async () => {
		const { store, clock, watchdog } = setup();
		await store.save(session("a", { status: SessionStatus.WAITING }));
		clock.time = 10_000_000;
		expect(await watchdog.check()).toEqual({ restarted: [], escalated: [] });
	});

	test("a failing restart is reported to onError, not thrown", async () => {
		const errors: unknown[] = [];
		const { store, clock, watchdog } = setup({
			onRestart: async () => {
				throw new Error("boom");
			},
			onError: (e) => errors.push(e),
		});
		await store.save(session("a"));
		clock.time = 100_000;
		await watchdog.check();
		await Bun.sleep(0);
		expect(errors).toEqual([new Error("boom")]);
	});

	test("start() runs checks on an interval; stop() ends them", async () => {
		const { store, restarts, watchdog } = setup({
			intervalMs: 5,
			stallAfterMs: -1,
			clock: { now: () => 0 },
		});
		await store.save(session("a"));
		watchdog.start();
		watchdog.start(); // idempotent
		await Bun.sleep(30);
		watchdog.stop();
		const seen = restarts.length;
		expect(seen).toBeGreaterThanOrEqual(1);
		await Bun.sleep(20);
		expect(restarts.length).toBe(seen);
	});
});
