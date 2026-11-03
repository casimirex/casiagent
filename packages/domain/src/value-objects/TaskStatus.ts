/**
 * Lifecycle states for the core entities. Each is an `as const` object plus a
 * derived union type, which keeps the values erasable (no TS `enum`).
 */

export const TriggerStatus = {
	PENDING: "PENDING",
	EVALUATING: "EVALUATING",
	ACCEPTED: "ACCEPTED",
	REJECTED: "REJECTED",
	CONSUMED: "CONSUMED",
} as const;
export type TriggerStatus = (typeof TriggerStatus)[keyof typeof TriggerStatus];

export const WorkItemStatus = {
	PENDING: "PENDING",
	RUNNING: "RUNNING",
	COMPLETED: "COMPLETED",
	FAILED: "FAILED",
	ABANDONED: "ABANDONED",
} as const;
export type WorkItemStatus = (typeof WorkItemStatus)[keyof typeof WorkItemStatus];

export const SessionStatus = {
	ACTIVE: "ACTIVE",
	STALLED: "STALLED",
	COMPLETED: "COMPLETED",
	FAILED: "FAILED",
} as const;
export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];
