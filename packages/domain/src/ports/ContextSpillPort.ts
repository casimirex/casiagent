import type { ContextMessage } from "../entities/Session";
import type { SessionId } from "../value-objects/SessionId";

export interface SpilledMessage {
	/** Position in the session's spill log, starting at 0 (older messages are lower). */
	readonly seq: number;
	readonly message: ContextMessage;
}

/**
 * Overflow storage for Worker context that no longer fits the inline token budget.
 * Swap implementations (keyword -> vector search) without touching the application.
 */
export interface ContextSpillPort {
	/** Append messages to the session's spill log. Returns the session's total spilled count. */
	spill(sessionId: SessionId, messages: readonly ContextMessage[]): Promise<number>;
	/** Up to `limit` spilled messages most relevant to `query`, returned oldest first. */
	recall(sessionId: SessionId, query: string, limit: number): Promise<readonly SpilledMessage[]>;
	count(sessionId: SessionId): Promise<number>;
}
