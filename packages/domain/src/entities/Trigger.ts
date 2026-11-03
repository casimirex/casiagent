import type { SourceId } from "../value-objects/SourceId";
import { TriggerStatus } from "../value-objects/TaskStatus";
import type { TriggerPriority } from "../value-objects/TriggerPriority";
import { assertTransition, type TransitionTable } from "./transitions";

/** Source-specific event data. Opaque to the domain. */
export type TriggerPayload = Readonly<Record<string, unknown>>;

/** Why a Trigger was accepted or rejected, and by which stage. */
export interface TriggerDecision {
	readonly stage: "FAST_FILTER" | "LLM";
	readonly reason: string;
	readonly priority: TriggerPriority;
}

/** An inbound event the Router has taken in and must decide whether to act on. */
export interface Trigger {
	readonly id: string;
	readonly sourceId: SourceId;
	/** Conversation the event came from; results are written back here. */
	readonly threadId?: string;
	readonly authorId: string;
	readonly authorIsBot: boolean;
	readonly payload: TriggerPayload;
	/** Epoch milliseconds when the source event happened. */
	readonly timestamp: number;
	readonly status: TriggerStatus;
	/** Set when the Trigger is accepted or rejected. */
	readonly decision?: TriggerDecision;
}

/** The fast filter may accept or reject directly; only ambiguous triggers go to EVALUATING. */
export const TRIGGER_TRANSITIONS: TransitionTable<TriggerStatus> = {
	[TriggerStatus.PENDING]: [
		TriggerStatus.EVALUATING,
		TriggerStatus.ACCEPTED,
		TriggerStatus.REJECTED,
	],
	// EVALUATING -> PENDING returns a Trigger for retry when the LLM fails.
	[TriggerStatus.EVALUATING]: [
		TriggerStatus.ACCEPTED,
		TriggerStatus.REJECTED,
		TriggerStatus.PENDING,
	],
	[TriggerStatus.ACCEPTED]: [TriggerStatus.CONSUMED],
	[TriggerStatus.REJECTED]: [],
	[TriggerStatus.CONSUMED]: [],
};

export function transitionTrigger(
	trigger: Trigger,
	to: TriggerStatus,
	decision?: TriggerDecision,
): Trigger {
	assertTransition("Trigger", TRIGGER_TRANSITIONS, trigger.status, to);
	return decision === undefined ? { ...trigger, status: to } : { ...trigger, status: to, decision };
}
