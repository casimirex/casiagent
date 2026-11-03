import {
	type Session,
	type SessionId,
	SessionStatus,
	type SessionStorePort,
	type Trigger,
	type TriggerStatus,
	type WorkItem,
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
 * compareAndSetTriggerStatus is atomic within one process.
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

	async compareAndSetTriggerStatus(
		id: string,
		expected: TriggerStatus,
		next: TriggerStatus,
	): Promise<Trigger | undefined> {
		const current = this.#triggers.get(id);
		if (current === undefined || current.status !== expected) return undefined;
		const updated: Trigger = { ...current, status: next };
		this.#triggers.set(id, updated);
		return structuredClone(updated);
	}

	async saveWorkItem(item: WorkItem): Promise<void> {
		this.#workItems.set(item.id, structuredClone(item));
	}

	async loadWorkItem(id: string): Promise<WorkItem | undefined> {
		return cloneOrUndefined(this.#workItems.get(id));
	}
}

function cloneOrUndefined<T>(value: T | undefined): T | undefined {
	return value === undefined ? undefined : structuredClone(value);
}
