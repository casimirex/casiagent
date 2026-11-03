import {
	type Session,
	SessionId,
	SessionStatus,
	type SourceEvent,
	SourceId,
	type Subscription,
	ThreadKey,
	type Trigger,
	TriggerStatus,
	type WorkItem,
	WorkItemStatus,
} from "@superagent/domain";

export const REPO = SourceId.of("github:org/repo");

export function session(id: string, overrides: Partial<Session> = {}): Session {
	return {
		id: SessionId.of(id),
		workerId: `worker-${id}`,
		workItemId: `item-${id}`,
		status: SessionStatus.ACTIVE,
		context: { messages: [{ role: "user", content: `task ${id}` }] },
		createdAt: 0,
		updatedAt: 0,
		lastHeartbeatAt: 0,
		restartCount: 0,
		...overrides,
	};
}

export function trigger(
	id: string,
	timestamp: number,
	status: TriggerStatus = TriggerStatus.ACCEPTED,
): Trigger {
	return {
		id,
		sourceId: REPO,
		threadId: "pr-1",
		authorId: "alice",
		authorIsBot: false,
		payload: { body: id, nested: { list: [1, "two"] } },
		timestamp,
		status,
	};
}

export function workItem(id: string, status: WorkItemStatus = WorkItemStatus.PENDING): WorkItem {
	return { id, triggerId: "t", assignedWorkerId: "x", status };
}

export function event(id: string): SourceEvent {
	return {
		id,
		sourceId: REPO,
		threadId: "pr-1",
		authorId: "bob",
		authorIsBot: false,
		payload: { body: id },
		timestamp: 0,
	};
}

export function subscription(thread: string, worker: string): Subscription {
	return {
		threadKey: ThreadKey.of(REPO, thread),
		workerId: worker,
		workItemId: `item-${worker}`,
		sessionId: SessionId.of(`session-${worker}`),
		createdAt: 0,
	};
}

/** Simulates a caller mutating an object it got from (or gave to) the store. */
export function mutate(value: Session): void {
	(value.context.messages as unknown[]).push({ role: "user", content: "LEAK" });
}
