export type AttentionKind =
	/** The Watchdog gave up restarting a session. */
	| "WATCHDOG_ESCALATION"
	/** A Worker's task failed. */
	| "WORKER_FAILED"
	/** A result could not be posted back, so nobody has seen it. */
	| "DELIVERY_FAILED"
	/** A Worker needs an answer from a human. */
	| "QUESTION"
	/** A Worker wants a human to review something. */
	| "REVIEW_REQUEST"
	/** An event kept being re-routed and was dropped (a safety stop; indicates a bug). */
	| "ROUTING_LOOP";

/** Something a human must look at. The panel shows only these. */
export interface AttentionItem {
	/** Deterministic where possible, so raising the same problem twice is idempotent. */
	readonly id: string;
	readonly kind: AttentionKind;
	readonly message: string;
	readonly sessionId?: string;
	readonly workItemId?: string;
	/** Link to the thing to look at (e.g. the PR). */
	readonly url?: string;
	/** Epoch milliseconds. */
	readonly createdAt: number;
	readonly resolvedAt?: number;
}
