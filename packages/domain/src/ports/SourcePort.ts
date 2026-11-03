import type { TriggerPayload } from "../entities/Trigger";
import type { SourceId } from "../value-objects/SourceId";

/** A raw event as produced by a source adapter, before intake into a Trigger. */
export interface SourceEvent {
	readonly id: string;
	readonly sourceId: SourceId;
	/** Conversation the event belongs to (PR number, chat thread, ...), used for direct routing. */
	readonly threadId?: string;
	readonly authorId: string;
	readonly authorIsBot: boolean;
	readonly payload: TriggerPayload;
	/** Epoch milliseconds. */
	readonly timestamp: number;
}

export type SourceEventHandler = (event: SourceEvent) => void | Promise<void>;

/** Call to stop receiving events from a subscription. */
export type Unsubscribe = () => void;

/** A message the agent sends back to a source. */
export interface OutboundMessage {
	/** Thread to reply in. If absent, the source decides where to post. */
	readonly threadId?: string;
	readonly body: string;
}

/** An external system the agent watches (GitHub, chat, CI, ...). */
export interface SourcePort {
	readonly sourceId: SourceId;
	/** Push-based: deliver events to `handler` as they arrive. */
	subscribe(handler: SourceEventHandler): Unsubscribe;
	/** Pull-based: fetch events newer than `sinceTimestamp` (epoch ms), oldest first. */
	fetchEvents(sinceTimestamp?: number): Promise<readonly SourceEvent[]>;
	/** Write a result back to the source (e.g. post a PR comment). */
	reply(message: OutboundMessage): Promise<void>;
}
