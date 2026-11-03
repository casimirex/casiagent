/** Something a human must look at. The panel (Phase 5) shows only these. */
export interface AttentionItem {
	/** Deterministic where possible, so raising the same problem twice is idempotent. */
	readonly id: string;
	readonly kind: "WATCHDOG_ESCALATION";
	readonly message: string;
	readonly sessionId?: string;
	readonly workItemId?: string;
	/** Epoch milliseconds. */
	readonly createdAt: number;
}
