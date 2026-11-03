import { describe, expect, test } from "bun:test";
import {
	SessionId,
	SessionStatus,
	type SessionStorePort,
	type Trigger,
	TriggerStatus,
	WorkItemStatus,
} from "@superagent/domain";
import { event, mutate, session, trigger, workItem } from "./fixtures";

/** Behaviour every SessionStorePort implementation must have. */
export function sessionStoreContract(name: string, make: () => SessionStorePort): void {
	describe(`${name}: sessions`, () => {
		test("round-trips the full session, including context", async () => {
			const store = make();
			const s = session("a", { restartCount: 2, lastHeartbeatAt: 5, updatedAt: 7 });
			await store.save(s);
			expect(await store.load(SessionId.of("a"))).toEqual(s);
			expect(await store.load(SessionId.of("missing"))).toBeUndefined();
		});

		test("isolation: mutating loaded or saved objects never changes stored state", async () => {
			const store = make();
			const s = session("a");
			await store.save(s);
			mutate(s);
			const loaded = await store.load(SessionId.of("a"));
			if (loaded === undefined) throw new Error("missing");
			mutate(loaded);
			expect((await store.load(SessionId.of("a")))?.context.messages).toHaveLength(1);
		});

		test("listActive returns only ACTIVE and STALLED", async () => {
			const store = make();
			for (const [id, status] of [
				["a", SessionStatus.ACTIVE],
				["b", SessionStatus.STALLED],
				["c", SessionStatus.WAITING],
				["d", SessionStatus.COMPLETED],
				["e", SessionStatus.FAILED],
			] as const) {
				await store.save(session(id, { status }));
			}
			expect((await store.listActive()).map((s) => s.id as string).sort()).toEqual(["a", "b"]);
		});

		test("save never moves lastHeartbeatAt or restartCount backwards", async () => {
			const store = make();
			await store.save(session("a", { lastHeartbeatAt: 100, restartCount: 2 }));
			await store.save(
				session("a", { lastHeartbeatAt: 50, restartCount: 1, status: SessionStatus.WAITING }),
			);
			const s = await store.load(SessionId.of("a"));
			expect(s).toMatchObject({
				lastHeartbeatAt: 100,
				restartCount: 2,
				status: SessionStatus.WAITING,
			});
		});

		test("recordHeartbeat updates only the heartbeat, never backwards", async () => {
			const store = make();
			const s = session("a", { lastHeartbeatAt: 10 });
			await store.save(s);
			expect(await store.recordHeartbeat(s.id, 30)).toBe(true);
			expect(await store.recordHeartbeat(s.id, 20)).toBe(true);
			expect(await store.load(s.id)).toEqual({ ...s, lastHeartbeatAt: 30 });
			expect(await store.recordHeartbeat(SessionId.of("missing"), 1)).toBe(false);
		});
	});

	describe(`${name}: triggers`, () => {
		test("createTrigger is insert-only", async () => {
			const store = make();
			expect(await store.createTrigger(trigger("t", 1, TriggerStatus.ACCEPTED))).toBe(true);
			expect(await store.createTrigger(trigger("t", 1, TriggerStatus.PENDING))).toBe(false);
			expect(await store.loadTrigger("t")).toEqual(trigger("t", 1, TriggerStatus.ACCEPTED));
		});

		test("listTriggersByStatus filters and sorts oldest first", async () => {
			const store = make();
			await store.createTrigger(trigger("late", 30));
			await store.createTrigger(trigger("early", 10));
			await store.createTrigger(trigger("other", 20, TriggerStatus.PENDING));
			expect((await store.listTriggersByStatus(TriggerStatus.ACCEPTED)).map((t) => t.id)).toEqual([
				"early",
				"late",
			]);
		});

		test("compareAndSetTrigger: one winner among concurrent claims; stores the full replacement", async () => {
			const store = make();
			await store.createTrigger(trigger("t", 1));
			const next: Trigger = {
				...trigger("t", 1, TriggerStatus.CONSUMED),
				decision: { stage: "LLM", reason: "ok", priority: "high" },
			};
			const claims = await Promise.all(
				Array.from({ length: 10 }, () => store.compareAndSetTrigger(TriggerStatus.ACCEPTED, next)),
			);
			expect(claims.filter((c) => c !== undefined)).toHaveLength(1);
			expect(await store.loadTrigger("t")).toEqual(next);
			expect(
				await store.compareAndSetTrigger(TriggerStatus.ACCEPTED, trigger("nope", 1)),
			).toBeUndefined();
		});

		test("claimTriggerForWork is all-or-nothing", async () => {
			const store = make();
			await store.createTrigger(trigger("t", 1));
			const consumed = trigger("t", 1, TriggerStatus.CONSUMED);

			expect(await store.claimTriggerForWork(consumed, workItem("w1"), session("s1"))).toBe(true);
			expect(await store.claimTriggerForWork(consumed, workItem("w2"), session("s2"))).toBe(false);

			expect((await store.loadTrigger("t"))?.status).toBe(TriggerStatus.CONSUMED);
			expect(await store.loadWorkItem("w1")).toEqual(workItem("w1"));
			expect(await store.load(SessionId.of("s1"))).toEqual(session("s1"));
			expect(await store.loadWorkItem("w2")).toBeUndefined();
			expect(await store.load(SessionId.of("s2"))).toBeUndefined();
		});
	});

	describe(`${name}: work items`, () => {
		test("save, load, CAS, count", async () => {
			const store = make();
			await store.saveWorkItem(workItem("a", WorkItemStatus.PENDING));
			await store.saveWorkItem(workItem("b", WorkItemStatus.AWAITING));
			await store.saveWorkItem(workItem("c", WorkItemStatus.COMPLETED));
			expect(await store.loadWorkItem("a")).toEqual(workItem("a"));
			expect(await store.loadWorkItem("missing")).toBeUndefined();

			const running = { ...workItem("b", WorkItemStatus.RUNNING), result: { output: "x" } };
			expect(await store.compareAndSetWorkItem(WorkItemStatus.AWAITING, running)).toEqual(running);
			expect(await store.compareAndSetWorkItem(WorkItemStatus.AWAITING, running)).toBeUndefined();
			expect(await store.loadWorkItem("b")).toEqual(running);

			expect(
				await store.countWorkItemsByStatus([WorkItemStatus.PENDING, WorkItemStatus.RUNNING]),
			).toBe(2);
			expect(await store.countWorkItemsByStatus([])).toBe(0);
		});
	});

	describe(`${name}: follow-up inbox`, () => {
		const s1 = SessionId.of("s1");

		test("enqueue, count, drain in order; drain empties the inbox", async () => {
			const store = make();
			await store.enqueueFollowUp(s1, event("a"));
			await store.enqueueFollowUp(s1, event("b"));
			expect(await store.countFollowUps(s1)).toBe(2);
			expect(await store.drainFollowUps(s1)).toEqual([event("a"), event("b")]);
			expect(await store.countFollowUps(s1)).toBe(0);
			expect(await store.drainFollowUps(s1)).toEqual([]);
		});

		test("an event id is accepted once per session, even after draining", async () => {
			const store = make();
			expect(await store.enqueueFollowUp(s1, event("a"))).toBe(true);
			expect(await store.enqueueFollowUp(s1, event("a"))).toBe(false);
			await store.drainFollowUps(s1);
			expect(await store.enqueueFollowUp(s1, event("a"))).toBe(false);
			expect(await store.enqueueFollowUp(SessionId.of("s2"), event("a"))).toBe(true);
		});

		test("saving the session does not touch its inbox", async () => {
			const store = make();
			await store.save(session("s1"));
			await store.enqueueFollowUp(s1, event("a"));
			await store.save(session("s1", { updatedAt: 9 }));
			expect(await store.countFollowUps(s1)).toBe(1);
		});
	});
}
