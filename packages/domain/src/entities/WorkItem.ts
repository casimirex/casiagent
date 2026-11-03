import { WorkItemStatus } from "../value-objects/TaskStatus";
import { assertTransition, type TransitionTable } from "./transitions";

export interface WorkResult {
	readonly output: string;
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
		WorkItemStatus.COMPLETED,
		WorkItemStatus.FAILED,
		WorkItemStatus.ABANDONED,
	],
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
