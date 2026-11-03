import type { SourceId } from "../value-objects/SourceId";

export const ActionOrigin = {
	/** A human asked the agent directly. */
	EXPLICIT_REQUEST: "EXPLICIT_REQUEST",
	/** The agent would be acting on its own inference (proactive work). */
	INFERRED: "INFERRED",
	/** An event on a thread a Worker already owns (review comment, CI result). */
	FOLLOW_UP: "FOLLOW_UP",
} as const;
export type ActionOrigin = (typeof ActionOrigin)[keyof typeof ActionOrigin];

export interface Action {
	readonly origin: ActionOrigin;
	/** The request text, matched against rule patterns. */
	readonly description: string;
}

export const AuthorizationDecision = {
	ALLOW: "ALLOW",
	DENY: "DENY",
	/** Record what would have been done; do not act. */
	OBSERVE_ONLY: "OBSERVE_ONLY",
} as const;
export type AuthorizationDecision =
	(typeof AuthorizationDecision)[keyof typeof AuthorizationDecision];

export interface AuthorizationVerdict {
	readonly decision: AuthorizationDecision;
	readonly reason: string;
}

/** Who may make the agent act, where, and on what. Synchronous: policy is local config. */
export interface AuthorizationPort {
	canAct(userId: string, sourceId: SourceId, action: Action): AuthorizationVerdict;
}
