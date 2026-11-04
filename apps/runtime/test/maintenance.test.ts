import { afterEach, describe, expect, test } from "bun:test";
import { parseAuthorizationConfig } from "@casiagent/adapters";
import {
	type LlmPort,
	SessionId,
	SessionStatus,
	SourceId,
	type SourcePort,
	TriggerStatus,
	WorkItemStatus,
} from "@casiagent/domain";
import { createRuntime, type Runtime } from "../src/createRuntime";

const REPO = SourceId.of("github:org/repo");
const DAY = 24 * 60 * 60_000;

const source: SourcePort = {
	sourceId: REPO,
	subscribe: () => () => {},
	fetchEvents: async () => [],
	reply: async () => {},
};

let runtime: Runtime | undefined;
afterEach(async () => {
	await runtime?.stop();
	runtime = undefined;
});

function boot(
	llm: LlmPort,
	workspaces?: { list(): Promise<string[]>; remove(id: string): Promise<void> },
) {
	const clock = {
		time: 100 * DAY,
		now() {
			return this.time;
		},
	};
	runtime = createRuntime({
		databasePath: ":memory:",
		authorization: parseAuthorizationConfig({ allowed_users: ["alice"], allowed_sources: [REPO] }),
		filterRules: {
			allowedSourceIds: "any",
			allowedUserIds: "any",
			keywordPatterns: [],
			ignoreBots: false,
		},
		authorizationRules: "",
		selfAuthorIds: [],
		llm,
		sources: [source],
		panel: false,
		watchdog: { intervalMs: 3_600_000 },
		maintenanceIntervalMs: 3_600_000,
		limits: { maxEvaluationAttempts: 3, abandonAwaitingAfterMs: 7 * DAY },
		clock,
		...(workspaces === undefined ? {} : { workspaces }),
		onError: () => {},
	});
	return { rt: runtime, clock };
}

const failingEvaluation: LlmPort = {
	evaluateTrigger: async () => {
		throw new Error("overloaded");
	},
	executeTask: async () => ({ output: "done" }),
};

const event = {
	id: "e1",
	sourceId: REPO,
	threadId: "5",
	authorId: "alice",
	authorIsBot: false,
	explicitRequest: true,
	payload: { body: "something ambiguous" },
	timestamp: 1,
};

describe("runtime maintenance", () => {
	test("retries a failing evaluation each pass until the cap, then rejects it and raises it", async () => {
		const { rt } = boot(failingEvaluation);
		await rt.handleEvent(event); // attempt 1
		await rt.idle();
		await rt.maintain(); // attempt 2
		const triggerId = `${REPO}#e1`;
		expect((await rt.parts.store.loadTrigger(triggerId))?.status).toBe(TriggerStatus.PENDING);

		await rt.maintain(); // attempt 3: cap reached

		expect((await rt.parts.store.loadTrigger(triggerId))?.status).toBe(TriggerStatus.REJECTED);
		expect((await rt.parts.attention.listOpen()).map((i) => i.kind)).toEqual(["EVALUATION_FAILED"]);
	});

	test("start() recovers a trigger a crashed process left EVALUATING", async () => {
		const { rt } = boot({
			evaluateTrigger: async () => ({ accepted: false, reason: "not for us", priority: "normal" }),
			executeTask: async () => ({ output: "x" }),
		});
		await rt.parts.store.createTrigger({
			...event,
			id: `${REPO}#e9`,
			status: TriggerStatus.EVALUATING,
		});

		await rt.start();
		await Bun.sleep(5);
		await rt.idle();

		expect(await rt.parts.store.loadTrigger(`${REPO}#e9`)).toMatchObject({
			status: TriggerStatus.REJECTED,
			evaluationAttempts: 1,
		});
	});

	test("abandons work that waited past the limit", async () => {
		const { rt, clock } = boot(failingEvaluation);
		const { store } = rt.parts;
		await store.saveWorkItem({
			id: "i1",
			triggerId: "t",
			assignedWorkerId: "w1",
			status: WorkItemStatus.AWAITING,
		});
		await store.save({
			id: SessionId.of("s1"),
			workerId: "w1",
			workItemId: "i1",
			status: SessionStatus.WAITING,
			context: { messages: [] },
			createdAt: 0,
			updatedAt: clock.time - 8 * DAY,
			lastHeartbeatAt: 0,
			restartCount: 0,
		});

		await rt.maintain();

		expect((await store.loadWorkItem("i1"))?.status).toBe(WorkItemStatus.ABANDONED);
		expect((await rt.parts.attention.listOpen()).map((i) => i.kind)).toEqual(["WORK_ABANDONED"]);
	});

	test("removes workspaces of finished or unknown WorkItems, keeps active ones", async () => {
		const removed: string[] = [];
		const { rt } = boot(failingEvaluation, {
			list: async () => ["done", "failed", "running", "gone"],
			remove: async (id) => {
				removed.push(id);
			},
		});
		const { store } = rt.parts;
		await store.saveWorkItem({ id: "done", triggerId: "t", status: WorkItemStatus.COMPLETED });
		await store.saveWorkItem({ id: "failed", triggerId: "t", status: WorkItemStatus.FAILED });
		await store.saveWorkItem({ id: "running", triggerId: "t", status: WorkItemStatus.RUNNING });

		await rt.maintain();

		expect(removed.sort()).toEqual(["done", "failed", "gone"]);
	});

	test("overlapping maintenance passes do not run concurrently", async () => {
		let lists = 0;
		const { rt } = boot(failingEvaluation, {
			list: async () => {
				lists += 1;
				await Bun.sleep(10);
				return [];
			},
			remove: async () => {},
		});
		await Promise.all([rt.maintain(), rt.maintain(), rt.maintain()]);
		expect(lists).toBe(1);
	});
});
