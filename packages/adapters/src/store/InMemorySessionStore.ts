import {
	type Session,
	type SessionId,
	SessionStatus,
	type SessionStorePort,
	type Trigger,
	type TriggerStatus,
	type WorkItem,
	type WorkItemStatus,
} from "@superagent/domain";

const ACTIVE_STATUSES: ReadonlySet<SessionStatus> = new Set([
	SessionStatus.ACTIVE,
	SessionStatus.STALLED,
]);

/**
 * Process-local store. Every value is deep-copied on the way in and out, so no two
 * callers (and no two Workers) ever share a mutable object. Replaced by SQLite in Phase 4.
 *
 * Each method's read-check-write runs without an intervening await, so
 * compareAndSetTrigger is atomic within one process.
 */
export class InMemorySessionStore implements SessionStorePort {
	readonly #sessions = new Map<string, Session>();
	readonly #triggers = new Map<string, Trigger>();
	readonly #workItems = new Map<string, WorkItem>();

	async save(session: Session): Promise<void> {
		this.#sessions.set(session.id, structuredClone(session));
	}

	async load(id: SessionId): Promise<Session | undefined> {
		return cloneOrUndefined(this.#sessions.get(id));
	}

	async listActive(): Promise<readonly Session[]> {
		return [...this.#sessions.values()]
			.filter((s) => ACTIVE_STATUSES.has(s.status))
			.map((s) => structuredClone(s));
	}

	async createTrigger(trigger: Trigger): Promise<boolean> {
		if (this.#triggers.has(trigger.id)) return false;
		this.#triggers.set(trigger.id, structuredClone(trigger));
		return true;
	}

	async loadTrigger(id: string): Promise<Trigger | undefined> {
		return cloneOrUndefined(this.#triggers.get(id));
	}

	async listTriggersByStatus(status: TriggerStatus): Promise<readonly Trigger[]> {
		return [...this.#triggers.values()]
			.filter((t) => t.status === status)
			.sort((a, b) => a.timestamp - b.timestamp)
			.map((t) => structuredClone(t));
	}

	async compareAndSetTrigger(
		expectedStatus: TriggerStatus,
		next: Trigger,
	): Promise<Trigger | undefined> {
		const current = this.#triggers.get(next.id);
		if (current === undefined || current.status !== expectedStatus) return undefined;
		this.#triggers.set(next.id, structuredClone(next));
		return structuredClone(next);
	}

	async saveWorkItem(item: WorkItem): Promise<void> {
		this.#workItems.set(item.id, structuredClone(item));
	}

	async loadWorkItem(id: string): Promise<WorkItem | undefined> {
		return cloneOrUndefined(this.#workItems.get(id));
	}

	async countWorkItemsByStatus(statuses: readonly WorkItemStatus[]): Promise<number> {
		let count = 0;
		for (const item of this.#workItems.values()) if (statuses.includes(item.status)) count += 1;
		return count;
	}
}

function cloneOrUndefined<T>(value: T | undefined): T | undefined {
	return value === undefined ? undefined : structuredClone(value);
}
