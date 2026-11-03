import type { Session } from "../entities/Session";
import type { Trigger } from "../entities/Trigger";
import type { WorkItem } from "../entities/WorkItem";
import type { SessionId } from "../value-objects/SessionId";
import type { TriggerStatus } from "../value-objects/TaskStatus";

/**
 * Persistence for Triggers, WorkItems and Worker sessions.
 *
 * Implementations must keep stored entities isolated: a value passed to a save
 * method or returned from a load method must never be shared with another caller.
 */
export interface SessionStorePort {
	/** Insert or replace the full session state. */
	save(session: Session): Promise<void>;
	load(id: SessionId): Promise<Session | undefined>;
	/** Sessions whose status is not terminal (ACTIVE or STALLED). */
	listActive(): Promise<readonly Session[]>;

	/** Insert a new Trigger. Returns false, and changes nothing, if the id already exists. */
	createTrigger(trigger: Trigger): Promise<boolean>;
	loadTrigger(id: string): Promise<Trigger | undefined>;
	/** Oldest first, by timestamp. */
	listTriggersByStatus(status: TriggerStatus): Promise<readonly Trigger[]>;
	/**
	 * Atomically move a Trigger from `expected` to `next`. Returns the updated Trigger,
	 * or undefined if it does not exist or its status is no longer `expected`.
	 * This is how concurrent callers claim a Trigger without double-processing it.
	 */
	compareAndSetTriggerStatus(
		id: string,
		expected: TriggerStatus,
		next: TriggerStatus,
	): Promise<Trigger | undefined>;

	/** Insert or replace a WorkItem. */
	saveWorkItem(item: WorkItem): Promise<void>;
	loadWorkItem(id: string): Promise<WorkItem | undefined>;
}
