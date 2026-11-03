import type { Session } from "../entities/Session";
import { SessionStatus } from "../value-objects/TaskStatus";

export interface WatchdogPolicy {
	/** A session with no heartbeat for longer than this is stalled. */
	readonly stallAfterMs: number;
	/** Restarts allowed before escalating to a human. */
	readonly maxRestarts: number;
}

export type HealthVerdict =
	| { readonly action: "HEALTHY" }
	| { readonly action: "RESTART" }
	| { readonly action: "ESCALATE"; readonly reason: string };

/**
 * Pure decision for one session. Only ACTIVE or STALLED sessions are supervised:
 * WAITING sessions are idle by design and terminal ones are done.
 */
export function assessSessionHealth(
	session: Session,
	now: number,
	policy: WatchdogPolicy,
): HealthVerdict {
	if (session.status !== SessionStatus.ACTIVE && session.status !== SessionStatus.STALLED) {
		return { action: "HEALTHY" };
	}
	const silentFor = now - session.lastHeartbeatAt;
	if (silentFor <= policy.stallAfterMs) return { action: "HEALTHY" };
	if (session.restartCount < policy.maxRestarts) return { action: "RESTART" };
	return {
		action: "ESCALATE",
		reason: `session ${session.id} stalled (no heartbeat for ${silentFor} ms) after ${session.restartCount} restarts`,
	};
}
