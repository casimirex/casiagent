import type { SourceId } from "../value-objects/SourceId";
import { WorkItemStatus } from "../value-objects/TaskStatus";
import { assertTransition, type TransitionTable } from "./transitions";

/** A thread the Worker created or took over (e.g. the pull request it opened). */
export interface ArtifactRef {
	readonly sourceId: SourceId;
	readonly threadId: string;
	readonly url?: string;
}

export interface WorkResult {
	readonly output: string;
	/**
	 * DONE (the default) finishes the WorkItem. AWAITING_FEEDBACK keeps it open, and the
	 * Worker subscribed, until a later run returns DONE.
	 */
	readonly status?: "DONE" | "AWAITING_FEEDBACK";
	/** Threads to subscribe to, so their follow-up events come straight to this Worker. */
	readonly artifacts?: readonly ArtifactRef[];
	/** Set when a human must act (answer a question, review something). Shown on the panel. */
	readonly attention?: {
		readonly kind: "QUESTION" | "REVIEW_REQUEST";
		readonly message: string;
		readonly url?: string;
	};
}

/** A unit of work created from an accepted Trigger and run by exactly one Worker. */
export interface WorkItem {
	readonly id: string;
	readonly triggerId: string;
	readonly assignedWorkerId?: string;
	readonly status: WorkItemStatus;
	readonly result?: WorkResult;
}

export const WORK_ITEM_TRANSITIONS: TransitionTable<WorkItemStatus> = {
	[WorkItemStatus.PENDING]: [WorkItemStatus.RUNNING, WorkItemStatus.ABANDONED],
	[WorkItemStatus.RUNNING]: [
		WorkItemStatus.AWAITING,
		WorkItemStatus.COMPLETED,
		WorkItemStatus.FAILED,
		WorkItemStatus.ABANDONED,
	],
	[WorkItemStatus.AWAITING]: [WorkItemStatus.RUNNING, WorkItemStatus.ABANDONED],
	[WorkItemStatus.COMPLETED]: [],
	[WorkItemStatus.FAILED]: [],
	[WorkItemStatus.ABANDONED]: [],
};

const TERMINAL: ReadonlySet<WorkItemStatus> = new Set([
	WorkItemStatus.COMPLETED,
	WorkItemStatus.FAILED,
	WorkItemStatus.ABANDONED,
]);

export function isTerminalWorkItem(item: WorkItem): boolean {
	return TERMINAL.has(item.status);
}

export function transitionWorkItem(
	item: WorkItem,
	to: WorkItemStatus,
	result?: WorkResult,
): WorkItem {
	assertTransition("WorkItem", WORK_ITEM_TRANSITIONS, item.status, to);
	return result === undefined ? { ...item, status: to } : { ...item, status: to, result };
}
