import type {
	ContextMessage,
	SourceEvent,
	Trigger,
	WorkerContext,
	WorkResult,
} from "@casiagent/domain";

type EventLike = Pick<SourceEvent, "sourceId" | "threadId" | "authorId" | "payload">;

/** One inbound event (the original Trigger or a follow-up) as a context message. */
export function eventMessage(event: EventLike): ContextMessage {
	const content = {
		sourceId: event.sourceId,
		...(event.threadId === undefined ? {} : { threadId: event.threadId }),
		authorId: event.authorId,
		payload: event.payload,
	};
	return { role: "user", content: JSON.stringify(content, null, 2) };
}

/** The Worker's own previous answer, so follow-up runs see what it already did. */
export function resultMessage(result: WorkResult): ContextMessage {
	return { role: "assistant", content: result.output };
}

/**
 * The initial context for a Worker: the data of its own Trigger and nothing else.
 * Router state, other Triggers and other Workers' data must never be added here.
 */
export function buildWorkerContext(trigger: Trigger): WorkerContext {
	return { messages: [eventMessage(trigger)] };
}
