import type { Session } from "../entities/Session";
import type { Trigger } from "../entities/Trigger";
import type { WorkItem } from "../entities/WorkItem";
import type { SessionId } from "../value-objects/SessionId";
import type { TriggerStatus, WorkItemStatus } from "../value-objects/TaskStatus";
import type { SourceEvent } from "./SourcePort";

/**
 * Persistence for Triggers, WorkItems and Worker sessions.
 *
 * Implementations must keep stored entities isolated: a value passed to a save
 * method or returned from a load method must never be shared with another caller.
 */
export interface SessionStorePort {
	/**
	 * Insert or replace the full session state, except that `lastHeartbeatAt` and
	 * `restartCount` never move backwards: a save carrying older values keeps the stored
	 * ones. Both are owned by the Watchdog, and a Worker's stale copy must not reset them.
	 */
	save(session: Session): Promise<void>;
	/** Atomically set only `lastHeartbeatAt` (never backwards). Returns false if the session does not exist. */
	recordHeartbeat(id: SessionId, at: number): Promise<boolean>;
	load(id: SessionId): Promise<Session | undefined>;
	/** Sessions that should be running: ACTIVE or STALLED (not WAITING, not terminal). */
	listActive(): Promise<readonly Session[]>;

	/** Insert a new Trigger. Returns false, and changes nothing, if the id already exists. */
	createTrigger(trigger: Trigger): Promise<boolean>;
	loadTrigger(id: string): Promise<Trigger | undefined>;
	/** Oldest first, by timestamp. */
	listTriggersByStatus(status: TriggerStatus): Promise<readonly Trigger[]>;
	/**
	 * Atomically replace the stored Trigger with `next` (matched by id), but only if the
	 * stored status is still `expectedStatus`. Returns the stored Trigger, or undefined if
	 * it does not exist or its status has changed. Every Trigger update goes through this,
	 * which is how concurrent callers claim a Trigger without double-processing it.
	 */
	compareAndSetTrigger(expectedStatus: TriggerStatus, next: Trigger): Promise<Trigger | undefined>;

	/**
	 * Dispatch atomically: replace the Trigger with `consumed` if it is still ACCEPTED, and
	 * insert the WorkItem and Session, all or nothing. Returns false (and changes nothing)
	 * if the Trigger is no longer ACCEPTED. A crash can never leave a consumed Trigger
	 * without its work.
	 */
	claimTriggerForWork(consumed: Trigger, item: WorkItem, session: Session): Promise<boolean>;

	/** Insert or replace a WorkItem. Use for creation; use compareAndSetWorkItem for status changes. */
	saveWorkItem(item: WorkItem): Promise<void>;
	/** Atomically replace a WorkItem if its stored status is still `expectedStatus`. Same contract as compareAndSetTrigger. */
	compareAndSetWorkItem(
		expectedStatus: WorkItemStatus,
		next: WorkItem,
	): Promise<WorkItem | undefined>;
	loadWorkItem(id: string): Promise<WorkItem | undefined>;
	countWorkItemsByStatus(statuses: readonly WorkItemStatus[]): Promise<number>;

	/**
	 * Follow-up inbox: events routed directly to a session, waiting to be processed.
	 * Kept apart from the Session record so saving a session never drops queued events.
	 */
	/** Append atomically. Returns false, and changes nothing, if this event id is already queued or was drained before. */
	enqueueFollowUp(sessionId: SessionId, event: SourceEvent): Promise<boolean>;
	/** Atomically remove and return all queued events, oldest first. */
	drainFollowUps(sessionId: SessionId): Promise<readonly SourceEvent[]>;
	countFollowUps(sessionId: SessionId): Promise<number>;
}
