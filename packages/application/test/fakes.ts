import {
	type ClockPort,
	type IdGeneratorPort,
	type LlmPort,
	type OutboundMessage,
	type Session,
	type SessionId,
	SessionStatus,
	type SessionStorePort,
	type SourceEvent,
	SourceId,
	type SourcePort,
	type TaskExecutionRequest,
	type Trigger,
	type TriggerEvaluationRequest,
	type TriggerStatus,
	type TriggerVerdict,
	type WorkItem,
	type WorkItemStatus,
	type WorkResult,
} from "@superagent/domain";

/** Yield to the event loop so concurrent callers interleave at every store call. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** In-memory SessionStorePort that copies values in and out, like a real store. */
export class FakeSessionStore implements SessionStorePort {
	readonly sessions = new Map<string, Session>();
	readonly triggers = new Map<string, Trigger>();
	readonly workItems = new Map<string, WorkItem>();

	async save(session: Session) {
		await tick();
		this.sessions.set(session.id, structuredClone(session));
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
		payload: { body: "please fix the flaky test" },
		timestamp: 500,
		...overrides,
	};
}
