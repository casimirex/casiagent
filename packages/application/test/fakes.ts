import { ContextManager, type PanelPort } from "@casiagent/application";
import {
	type Action,
	type AttentionItem,
	type AuthorizationPort,
	type AuthorizationVerdict,
	type ClockPort,
	type ContextMessage,
	type ContextSpillPort,
	type IdGeneratorPort,
	type LlmPort,
	type Observation,
	type ObserveLogPort,
	type OutboundMessage,
	type Session,
	type SessionId,
	SessionStatus,
	type SessionStorePort,
	type SourceEvent,
	SourceId,
	type SourcePort,
	type SpilledMessage,
	type Subscription,
	type SubscriptionStorePort,
	type TaskExecutionRequest,
	type ThreadKey,
	type Trigger,
	type TriggerEvaluationRequest,
	type TriggerStatus,
	type TriggerVerdict,
	type WorkItem,
	type WorkItemStatus,
	type WorkResult,
} from "@casiagent/domain";

/** Yield to the event loop so concurrent callers interleave at every store call. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** In-memory SessionStorePort that copies values in and out, like a real store. */
export class FakeSessionStore implements SessionStorePort {
	readonly sessions = new Map<string, Session>();
	readonly triggers = new Map<string, Trigger>();
	readonly workItems = new Map<string, WorkItem>();

	async save(session: Session) {
		await tick();
		const stored = this.sessions.get(session.id);
		const next =
			stored === undefined
				? session
				: {
						...session,
						lastHeartbeatAt: Math.max(stored.lastHeartbeatAt, session.lastHeartbeatAt),
						restartCount: Math.max(stored.restartCount, session.restartCount),
					};
		this.sessions.set(session.id, structuredClone(next));
	}
	readonly heartbeats: Array<{ id: string; at: number }> = [];
	async recordHeartbeat(id: SessionId, at: number) {
		await tick();
		const s = this.sessions.get(id);
		if (s === undefined) return false;
		this.heartbeats.push({ id, at });
		this.sessions.set(id, { ...s, lastHeartbeatAt: Math.max(s.lastHeartbeatAt, at) });
		return true;
	}
	async claimTriggerForWork(consumed: Trigger, item: WorkItem, session: Session) {
		await tick();
		const t = this.triggers.get(consumed.id);
		if (t === undefined || t.status !== "ACCEPTED") return false;
		this.triggers.set(consumed.id, structuredClone(consumed));
		this.workItems.set(item.id, structuredClone(item));
		this.sessions.set(session.id, structuredClone(session));
		return true;
	}
	async load(id: SessionId) {
		await tick();
		const s = this.sessions.get(id);
		return s && structuredClone(s);
	}
	async listActive() {
		await tick();
		return [...this.sessions.values()]
			.filter((s) => s.status === SessionStatus.ACTIVE || s.status === SessionStatus.STALLED)
			.map((s) => structuredClone(s));
	}
	async createTrigger(trigger: Trigger) {
		await tick();
		if (this.triggers.has(trigger.id)) return false;
		this.triggers.set(trigger.id, structuredClone(trigger));
		return true;
	}
	async loadTrigger(id: string) {
		await tick();
		const t = this.triggers.get(id);
		return t && structuredClone(t);
	}
	async listTriggersByStatus(status: TriggerStatus) {
		await tick();
		return [...this.triggers.values()]
			.filter((t) => t.status === status)
			.sort((a, b) => a.timestamp - b.timestamp)
			.map((t) => structuredClone(t));
	}
	async compareAndSetTrigger(expectedStatus: TriggerStatus, next: Trigger) {
		await tick();
		const t = this.triggers.get(next.id);
		if (t === undefined || t.status !== expectedStatus) return undefined;
		this.triggers.set(next.id, structuredClone(next));
		return structuredClone(next);
	}
	/** Test helper: force a stored trigger's status, bypassing transition rules. */
	setStatus(id: string, status: TriggerStatus) {
		const t = this.triggers.get(id);
		if (t === undefined) throw new Error(`no trigger ${id}`);
		this.triggers.set(id, { ...t, status });
	}
	async saveWorkItem(item: WorkItem) {
		await tick();
		this.workItems.set(item.id, structuredClone(item));
	}
	async loadWorkItem(id: string) {
		await tick();
		const w = this.workItems.get(id);
		return w && structuredClone(w);
	}
	async compareAndSetWorkItem(expectedStatus: WorkItemStatus, next: WorkItem) {
		await tick();
		const w = this.workItems.get(next.id);
		if (w === undefined || w.status !== expectedStatus) return undefined;
		this.workItems.set(next.id, structuredClone(next));
		return structuredClone(next);
	}
	readonly inboxes = new Map<string, SourceEvent[]>();
	readonly #seen = new Set<string>();
	async enqueueFollowUp(sessionId: SessionId, event: SourceEvent) {
		await tick();
		const key = `${sessionId}|${event.id}`;
		if (this.#seen.has(key)) return false;
		this.#seen.add(key);
		this.inboxes.set(sessionId, [...(this.inboxes.get(sessionId) ?? []), structuredClone(event)]);
		return true;
	}
	async drainFollowUps(sessionId: SessionId) {
		await tick();
		const inbox = this.inboxes.get(sessionId) ?? [];
		this.inboxes.delete(sessionId);
		return inbox;
	}
	async countFollowUps(sessionId: SessionId) {
		await tick();
		return this.inboxes.get(sessionId)?.length ?? 0;
	}
	async countWorkItemsByStatus(statuses: readonly WorkItemStatus[]) {
		await tick();
		return [...this.workItems.values()].filter((w) => statuses.includes(w.status)).length;
	}
}

export class SequentialIds implements IdGeneratorPort {
	#n = 0;
	next() {
		this.#n += 1;
		return `id-${this.#n}`;
	}
}

export class FixedClock implements ClockPort {
	time = 1_000;
	now() {
		return this.time;
	}
}

export class FakeLlm implements LlmPort {
	readonly executeCalls: TaskExecutionRequest[] = [];
	readonly evaluateCalls: TriggerEvaluationRequest[] = [];
	/** Replace to change the verdict (or throw). */
	evaluate: (req: TriggerEvaluationRequest) => Promise<TriggerVerdict> = async () => ({
		accepted: true,
		reason: "looks like a legitimate request",
		priority: "normal",
	});
	/** Replace to change how tasks run (e.g. to throw). */
	execute: (req: TaskExecutionRequest) => Promise<WorkResult> = async (req) => ({
		output: `done: ${req.workItem.id}`,
	});
	async evaluateTrigger(req: TriggerEvaluationRequest) {
		this.evaluateCalls.push(req);
		return this.evaluate(req);
	}
	async executeTask(req: TaskExecutionRequest) {
		this.executeCalls.push(req);
		return this.execute(req);
	}
}

export class FakeSource implements SourcePort {
	readonly replies: OutboundMessage[] = [];
	failWith: Error | undefined;
	readonly sourceId: SourceId = SourceId.of("github:org/repo");
	subscribe() {
		return () => {};
	}
	async fetchEvents() {
		return [];
	}
	async reply(message: OutboundMessage) {
		if (this.failWith) throw this.failWith;
		this.replies.push(message);
	}
}

export function makeEvent(overrides: Partial<SourceEvent> = {}): SourceEvent {
	return {
		id: "evt-1",
		sourceId: SourceId.of("github:org/repo"),
		threadId: "pr-42",
		authorId: "alice",
		authorIsBot: false,
		explicitRequest: true,
		payload: { body: "please fix the flaky test" },
		timestamp: 500,
		...overrides,
	};
}

export class FakeSubscriptionStore implements SubscriptionStorePort {
	readonly byThread = new Map<string, Subscription>();
	async subscribe(sub: Subscription) {
		await tick();
		const existing = this.byThread.get(sub.threadKey);
		if (existing !== undefined && existing.workerId !== sub.workerId) return existing;
		this.byThread.set(sub.threadKey, sub);
		return sub;
	}
	async findByThread(threadKey: ThreadKey) {
		await tick();
		return this.byThread.get(threadKey);
	}
	async listByWorker(workerId: string) {
		await tick();
		return [...this.byThread.values()].filter((s) => s.workerId === workerId);
	}
	async removeByWorker(workerId: string) {
		await tick();
		let n = 0;
		for (const [k, s] of this.byThread) {
			if (s.workerId === workerId) {
				this.byThread.delete(k);
				n += 1;
			}
		}
		return n;
	}
}

/** Spill log with naive substring recall; enough to exercise ContextManager. */
export class FakeSpill implements ContextSpillPort {
	readonly logs = new Map<string, SpilledMessage[]>();
	async spill(sessionId: SessionId, messages: readonly ContextMessage[]) {
		const log = this.logs.get(sessionId) ?? [];
		for (const message of messages) log.push({ seq: log.length, message });
		this.logs.set(sessionId, log);
		return log.length;
	}
	async recall(sessionId: SessionId, query: string, limit: number) {
		const words = query
			.toLowerCase()
			.split(/\W+/)
			.filter((w) => w.length >= 4);
		return (this.logs.get(sessionId) ?? [])
			.filter((s) => words.some((w) => s.message.content.toLowerCase().includes(w)))
			.slice(-limit);
	}
	async count(sessionId: SessionId) {
		return this.logs.get(sessionId)?.length ?? 0;
	}
}

/** A ContextManager with a budget large enough that existing tests never spill. */
export function roomyContext(spill: ContextSpillPort = new FakeSpill()): ContextManager {
	return new ContextManager({ spill, budgetTokens: 1_000_000 });
}

/** Authorization with a fixed answer, or a custom function. Allows everything by default. */
export class FakeAuthorization implements AuthorizationPort {
	readonly calls: Array<{ userId: string; sourceId: string; action: Action }> = [];
	decide: (userId: string, sourceId: string, action: Action) => AuthorizationVerdict = () => ({
		decision: "ALLOW",
		reason: "test: allow all",
	});
	canAct(userId: string, sourceId: SourceId, action: Action) {
		this.calls.push({ userId, sourceId, action });
		return this.decide(userId, sourceId, action);
	}
}

export class FakeObserveLog implements ObserveLogPort {
	readonly entries = new Map<string, Observation>();
	async record(o: Observation) {
		this.entries.set(o.id, o);
	}
	async list(limit: number) {
		return [...this.entries.values()].reverse().slice(0, limit);
	}
}

export class FakePanel implements PanelPort {
	readonly items: AttentionItem[] = [];
	async showAttentionItem(item: AttentionItem) {
		this.items.push(item);
	}
}
