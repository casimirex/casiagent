import { describe, expect, test } from "bun:test";
import {
	ContextManager,
	DispatchWorkUseCase,
	IntakeTriggerUseCase,
	SubscriptionRegistry,
	WorkerExecutionUseCase,
} from "@casiagent/application";
import {
	type DispatchRecord,
	RouterState,
	type SchedulerPort,
	SessionId,
	type SourceId,
	type SourcePort,
	TriggerStatus,
	type WatchdogPort,
} from "@casiagent/domain";
import {
	FakeLlm,
	FakePanel,
	FakeSessionStore,
	FakeSource,
	FakeSpill,
	FakeSubscriptionStore,
	FixedClock,
	makeEvent,
	SequentialIds,
} from "./fakes";

/** Scheduler whose ticks the test fires by hand. */
class ManualScheduler implements SchedulerPort {
	readonly tasks = new Set<() => void>();
	every(_ms: number, task: () => void) {
		this.tasks.add(task);
		return () => this.tasks.delete(task);
	}
	tick() {
		for (const t of this.tasks) t();
	}
}

async function setup(budgetTokens = 1_000_000, watchdogOverride?: WatchdogPort) {
	const store = new FakeSessionStore();
	const clock = new FixedClock();
	const llm = new FakeLlm();
	const source = new FakeSource();
	const scheduler = new ManualScheduler();
	const beats: string[] = [];
	const watchdog: WatchdogPort = watchdogOverride ?? {
		start() {},
		stop() {},
		heartbeat: async (id) => {
			beats.push(id);
		},
	};
	const { trigger } = await new IntakeTriggerUseCase({ store }).execute(makeEvent());
	store.setStatus(trigger.id, TriggerStatus.ACCEPTED);
	const { dispatched } = await new DispatchWorkUseCase({
		store,
		ids: new SequentialIds(),
		clock,
	}).execute(RouterState.empty());
	const context = new ContextManager({ spill: new FakeSpill(), budgetTokens });
	const worker = new WorkerExecutionUseCase({
		panel: new FakePanel(),
		store,
		llm,
		sources: new Map<SourceId, SourcePort>([[source.sourceId, source]]),
		subscriptions: new SubscriptionRegistry({ store: new FakeSubscriptionStore(), clock }),
		context,
		clock,
		heartbeat: { watchdog, scheduler, intervalMs: 10_000 },
	});
	return { store, llm, scheduler, beats, worker, context, record: dispatched[0] as DispatchRecord };
}

describe("WorkerExecutionUseCase (Phase 4)", () => {
	test("sends heartbeats while the LLM call is in flight, and stops afterwards", async () => {
		const { llm, scheduler, beats, worker, record } = await setup();
		let release = () => {};
		llm.execute = () =>
			new Promise((resolve) => {
				release = () => resolve({ output: "done" });
			});

		const run = worker.execute(record);
		for (let i = 0; i < 100 && llm.executeCalls.length === 0; i++) await Bun.sleep(1);
		scheduler.tick();
		scheduler.tick();
		release();
		await run;
		scheduler.tick();

		expect(beats).toEqual([record.sessionId, record.sessionId]);
		expect(scheduler.tasks.size).toBe(0);
	});

	test("a failing heartbeat does not fail the task", async () => {
		let attempts = 0;
		const failing: WatchdogPort = {
			start() {},
			stop() {},
			heartbeat: async () => {
				attempts += 1;
				throw new Error("db locked");
			},
		};
		const { scheduler, worker, llm, record } = await setup(1_000_000, failing);
		llm.execute = async () => {
			scheduler.tick();
			await Bun.sleep(1); // let the rejected heartbeat settle while the task is running
			return { output: "done" };
		};

		expect((await worker.execute(record)).status).toBe("COMPLETED");
		expect(attempts).toBe(1);
	});

	test("the LLM receives the budgeted working context, and the session is saved compacted", async () => {
		const { store, llm, worker, context, record } = await setup(2_000);
		const session = store.sessions.get(record.sessionId);
		if (session === undefined) throw new Error("missing session");
		const big = Array.from({ length: 20 }, (_, i) => ({
			role: "user" as const,
			content: `note ${i} ${"z".repeat(2_000)}`,
		}));
		store.sessions.set(session.id, {
			...session,
			context: { messages: [...session.context.messages, ...big] },
		});

		await worker.execute(record);

		const sent = llm.executeCalls[0]?.context.messages ?? [];
		expect(context.tokens(sent)).toBeLessThanOrEqual(2_000);
		const saved = store.sessions.get(SessionId.of(record.sessionId))?.context.messages ?? [];
		expect(saved.some((m) => m.content.startsWith("[context-spill]"))).toBe(true);
	});
});
