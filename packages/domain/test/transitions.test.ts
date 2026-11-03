import { describe, expect, test } from "bun:test";
import {
	DomainError,
	isTerminalWorkItem,
	type Session,
	SessionId,
	SessionStatus,
	SourceId,
	type Trigger,
	TriggerStatus,
	transitionSession,
	transitionTrigger,
	transitionWorkItem,
	type WorkItem,
	WorkItemStatus,
} from "@superagent/domain";

const trigger: Trigger = {
	id: "t1",
	sourceId: SourceId.of("github:org/repo"),
	authorId: "alice",
	authorIsBot: false,
	explicitRequest: true,
	payload: { body: "please fix the bug" },
	timestamp: 1_000,
	status: TriggerStatus.PENDING,
};

const workItem: WorkItem = { id: "w1", triggerId: "t1", status: WorkItemStatus.PENDING };

describe("Trigger transitions", () => {
	test("happy path: PENDING -> EVALUATING -> ACCEPTED -> CONSUMED", () => {
		const consumed = [
			TriggerStatus.EVALUATING,
			TriggerStatus.ACCEPTED,
			TriggerStatus.CONSUMED,
		].reduce((t, status) => transitionTrigger(t, status), trigger);
		expect(consumed.status).toBe(TriggerStatus.CONSUMED);
	});

	test("fast path may accept or reject directly from PENDING", () => {
		expect(transitionTrigger(trigger, TriggerStatus.ACCEPTED).status).toBe(TriggerStatus.ACCEPTED);
		expect(transitionTrigger(trigger, TriggerStatus.REJECTED).status).toBe(TriggerStatus.REJECTED);
	});

	test("returns a new object and leaves the input unchanged", () => {
		const next = transitionTrigger(trigger, TriggerStatus.EVALUATING);
		expect(next).not.toBe(trigger);
		expect(trigger.status).toBe(TriggerStatus.PENDING);
	});

	test.each([
		[TriggerStatus.PENDING, TriggerStatus.CONSUMED],
		[TriggerStatus.REJECTED, TriggerStatus.ACCEPTED],
		[TriggerStatus.CONSUMED, TriggerStatus.PENDING],
	] as const)("rejects %s -> %s", (from, to) => {
		expect(() => transitionTrigger({ ...trigger, status: from }, to)).toThrow(DomainError);
	});
});

describe("WorkItem transitions", () => {
	test("RUNNING -> COMPLETED attaches the result and becomes terminal", () => {
		const running = transitionWorkItem(workItem, WorkItemStatus.RUNNING);
		expect(isTerminalWorkItem(running)).toBe(false);
		const done = transitionWorkItem(running, WorkItemStatus.COMPLETED, { output: "PR opened" });
		expect(done.result).toEqual({ output: "PR opened" });
		expect(isTerminalWorkItem(done)).toBe(true);
	});

	test("cannot complete without running first", () => {
		expect(() => transitionWorkItem(workItem, WorkItemStatus.COMPLETED)).toThrow(DomainError);
	});

	test("terminal statuses cannot move", () => {
		const abandoned = transitionWorkItem(workItem, WorkItemStatus.ABANDONED);
		expect(() => transitionWorkItem(abandoned, WorkItemStatus.RUNNING)).toThrow(DomainError);
	});
});

describe("Session transitions", () => {
	const session: Session = {
		id: SessionId.of("s1"),
		workerId: "worker-1",
		workItemId: "w1",
		status: SessionStatus.ACTIVE,
		context: { messages: [] },
		createdAt: 0,
		updatedAt: 0,
		lastHeartbeatAt: 0,
		restartCount: 0,
	};

	test("ACTIVE -> STALLED -> ACTIVE (watchdog restart) updates updatedAt", () => {
		const stalled = transitionSession(session, SessionStatus.STALLED, 10);
		const resumed = transitionSession(stalled, SessionStatus.ACTIVE, 20);
		expect(resumed.status).toBe(SessionStatus.ACTIVE);
		expect(resumed.updatedAt).toBe(20);
	});

	test("cannot leave a terminal status", () => {
		const done = transitionSession(session, SessionStatus.COMPLETED, 10);
		expect(() => transitionSession(done, SessionStatus.ACTIVE, 20)).toThrow(DomainError);
	});
});
