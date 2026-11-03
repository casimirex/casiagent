import type { SessionId } from "../value-objects/SessionId";
import type { ThreadKey } from "../value-objects/ThreadKey";

/** A Worker's claim on a thread: events on it go straight to the Worker, bypassing the Router. */
export interface Subscription {
	readonly threadKey: ThreadKey;
	readonly workerId: string;
	readonly workItemId: string;
	readonly sessionId: SessionId;
	/** Epoch milliseconds. */
	readonly createdAt: number;
}
