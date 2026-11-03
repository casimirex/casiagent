import {
	type SessionStorePort,
	type SourceEvent,
	type Trigger,
	TriggerStatus,
} from "@superagent/domain";
import { UseCaseError } from "../errors";

export interface IntakeTriggerDeps {
	readonly store: SessionStorePort;
}

export interface IntakeResult {
	readonly trigger: Trigger;
	/** False if this event was already taken in; the stored Trigger is returned unchanged. */
	readonly created: boolean;
}

/** Trigger ids derive from the source event, so taking in the same event twice is a no-op. */
export function triggerIdFor(event: SourceEvent): string {
	return `${event.sourceId}#${event.id}`;
}

/**
 * Structural intake only: maps a raw source event to a PENDING Trigger and stores it.
 * No filtering or LLM evaluation happens here.
 */
export class IntakeTriggerUseCase {
	readonly #store: SessionStorePort;

	constructor(deps: IntakeTriggerDeps) {
		this.#store = deps.store;
	}

	async execute(event: SourceEvent): Promise<IntakeResult> {
		const trigger: Trigger = {
			id: triggerIdFor(event),
			sourceId: event.sourceId,
			...(event.threadId === undefined ? {} : { threadId: event.threadId }),
			authorId: event.authorId,
			authorIsBot: event.authorIsBot,
			payload: event.payload,
			timestamp: event.timestamp,
			status: TriggerStatus.PENDING,
		};

		if (await this.#store.createTrigger(trigger)) {
			return { trigger, created: true };
		}
		const existing = await this.#store.loadTrigger(trigger.id);
		if (existing === undefined) {
			throw new UseCaseError(`Trigger ${trigger.id} reported as existing but could not be loaded`);
		}
		return { trigger: existing, created: false };
	}
}
