/**
 * Phase 4 acceptance: a Worker "crashes" mid-execution, a fresh process starts on the
 * same database, and its Watchdog restarts the session until the WorkItem completes.
 * Everything here is real (SQLite, adapters, use cases) except the LLM and the source.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	InMemoryAttentionStore,
	IntervalWatchdog,
	openDatabase,
	SqliteContextSpillStore,
	SqliteSessionStore,
	SqliteSubscriptionStore,
	UuidGenerator,
} from "@superagent/adapters";
import {
	ContextManager,
	DispatchWorkUseCase,
	EvaluateTriggerUseCase,
	IntakeTriggerUseCase,
	SubscriptionRegistry,
	WorkerExecutionUseCase,
} from "@superagent/application";
import {
	createFilterRules,
	type LlmPort,
	type OutboundMessage,
	RouterState,
	SessionStatus,
	SourceId,
	type SourcePort,
	WorkItemStatus,
	type WorkResult,
} from "@superagent/domain";

const REPO = SourceId.of("github:org/repo");
const dir = mkdtempSync(join(tmpdir(), "superagent-crash-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

class Clock {
	time = 1_000;
	now() {
		return this.time;
	}
}

class RecordingSource implements SourcePort {
	readonly sourceId = REPO;
	readonly replies: OutboundMessage[] = [];
	subscribe() {
		return () => {};
	}
	async fetchEvents() {
		return [];
	}
	async reply(message: OutboundMessage) {
		this.replies.push(message);
	}
}

/** Hangs forever on the calls listed in `hangOn` (a crashed process never returns). */
function llm(hangOn: (call: number) => boolean, counter: { calls: number }): LlmPort {
	return {
		evaluateTrigger: async () => {
			throw new Error("not used: the fast filter accepts this trigger");
		},
		executeTask: async (): Promise<WorkResult> => {
			const call = counter.calls++;
			if (hangOn(call)) return new Promise<WorkResult>(() => {});
			return { output: "Fixed the flaky test", status: "DONE" };
		},
	};
}

/** One "process": its own connection and object graph over the shared database file. */
function boot(path: string, clock: Clock, model: LlmPort) {
	const db = openDatabase(path);
	const store = new SqliteSessionStore(db);
	const subscriptionStore = new SqliteSubscriptionStore(db);
	const attention = new InMemoryAttentionStore();
	const source = new RecordingSource();
	const worker = new WorkerExecutionUseCase({
		store,
		llm: model,
		sources: new Map([[REPO, source]]),
		subscriptions: new SubscriptionRegistry({ store: subscriptionStore, clock }),
		context: new ContextManager({ spill: new SqliteContextSpillStore(db), budgetTokens: 8_000 }),
		clock,
	});
	const restarts: Promise<unknown>[] = [];
	const watchdog = new IntervalWatchdog({
		store,
		subscriptions: subscriptionStore,
		attention,
		clock,
		intervalMs: 30_000,
		// Composition-root wiring: restart = resume the WorkItem from persisted state.
		onRestart: (s) => {
			const run = worker.execute({
				workItemId: s.workItemId,
				workerId: s.workerId,
				sessionId: s.id,
			});
			restarts.push(run);
			return run;
		},
	});
	return { db, store, attention, source, worker, watchdog, restarts };
}

async function startTask(path: string, clock: Clock, model: LlmPort) {
	const p1 = boot(path, clock, model);
	const { trigger } = await new IntakeTriggerUseCase({ store: p1.store }).execute({
		id: "issue-1",
		sourceId: REPO,
		threadId: "issue-1",
		authorId: "alice",
		authorIsBot: false,
		payload: { body: "please fix the bug in the flaky checkout test" },
		timestamp: 0,
	});
	const rules = createFilterRules({
		allowedSourceIds: [REPO],
		allowedUserIds: ["alice"],
		keywordPatterns: ["fix (the )?bug"],
		ignoreBots: true,
	});
	await new EvaluateTriggerUseCase({
		store: p1.store,
		llm: model,
		rules,
		authorizationRules: "",
	}).execute(trigger.id);
	const { dispatched } = await new DispatchWorkUseCase({
		store: p1.store,
		ids: new UuidGenerator(),
		clock,
	}).execute(RouterState.empty());
	const record = dispatched[0];
	if (record === undefined) throw new Error("nothing dispatched");
	void p1.worker.execute(record); // never settles: this process "crashes" inside the LLM call
	for (
		let i = 0;
		i < 200 && (await p1.store.loadWorkItem(record.workItemId))?.status !== WorkItemStatus.RUNNING;
		i++
	) {
		await Bun.sleep(1);
	}
	return { p1, record };
}

describe("crash recovery", () => {
	test("a Worker that dies mid-task is restarted by the Watchdog and completes", async () => {
		const path = join(dir, "recover.sqlite");
		const clock = new Clock();
		const counter = { calls: 0 };
		const model = llm((call) => call === 0, counter);
		const { p1, record } = await startTask(path, clock, model);
		p1.db.close(); // process 1 is gone

		const p2 = boot(path, clock, model);
		clock.time += 90_001; // no heartbeat for longer than 3 x 30 s
		const report = await p2.watchdog.check();
		await Promise.all(p2.restarts);

		expect(report.restarted).toEqual([record.sessionId]);
		expect((await p2.store.loadWorkItem(record.workItemId))?.status).toBe(WorkItemStatus.COMPLETED);
		expect(await p2.store.load(record.sessionId)).toMatchObject({
			status: SessionStatus.COMPLETED,
			restartCount: 1,
		});
		expect(p2.source.replies).toEqual([{ threadId: "issue-1", body: "Fixed the flaky test" }]);
		expect(counter.calls).toBe(2);
	});

	test("a Worker that keeps dying is restarted 3 times, then escalated to a human", async () => {
		const path = join(dir, "escalate.sqlite");
		const clock = new Clock();
		const counter = { calls: 0 };
		const model = llm(() => true, counter);
		const { p1, record } = await startTask(path, clock, model);
		p1.db.close();

		const p2 = boot(path, clock, model);
		for (let i = 0; i < 4; i++) {
			clock.time += 90_001;
			await p2.watchdog.check();
			// Let a restarted run reach (and hang in) the LLM call before the next pass.
			const expected = Math.min(2 + i, 4);
			for (let n = 0; n < 1_000 && counter.calls < expected; n++) await Bun.sleep(1);
		}

		expect(counter.calls).toBe(4); // original + 3 restarts
		expect((await p2.store.load(record.sessionId))?.status).toBe(SessionStatus.FAILED);
		expect((await p2.store.loadWorkItem(record.workItemId))?.status).toBe(WorkItemStatus.FAILED);
		expect(p2.attention.list().map((a) => a.kind)).toEqual(["WATCHDOG_ESCALATION"]);
	});
});
