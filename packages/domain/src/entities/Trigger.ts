import type { SourceId } from "../value-objects/SourceId";
import { TriggerStatus } from "../value-objects/TaskStatus";
import { assertTransition, type TransitionTable } from "./transitions";

/** Source-specific event data. Opaque to the domain. */
export type TriggerPayload = Readonly<Record<string, unknown>>;

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
}

/** The fast filter may accept or reject directly; only ambiguous triggers go to EVALUATING. */
export const TRIGGER_TRANSITIONS: TransitionTable<TriggerStatus> = {
	[TriggerStatus.PENDING]: [
		TriggerStatus.EVALUATING,
		TriggerStatus.ACCEPTED,
		TriggerStatus.REJECTED,
	],
	[TriggerStatus.EVALUATING]: [TriggerStatus.ACCEPTED, TriggerStatus.REJECTED],
	[TriggerStatus.ACCEPTED]: [TriggerStatus.CONSUMED],
	[TriggerStatus.REJECTED]: [],
	[TriggerStatus.CONSUMED]: [],
};

export function transitionTrigger(trigger: Trigger, to: TriggerStatus): Trigger {
	assertTransition("Trigger", TRIGGER_TRANSITIONS, trigger.status, to);
	return { ...trigger, status: to };
}
