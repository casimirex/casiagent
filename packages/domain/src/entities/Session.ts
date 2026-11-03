import type { SessionId } from "../value-objects/SessionId";
import { SessionStatus } from "../value-objects/TaskStatus";
import { assertTransition, type TransitionTable } from "./transitions";

export interface ContextMessage {
	readonly role: "system" | "user" | "assistant" | "tool";
	readonly content: string;
}

/** The Worker-scoped context. Holds only the data for one WorkItem, never Router state. */
export interface WorkerContext {
	readonly messages: readonly ContextMessage[];
}

/** The persisted execution state of one Worker running one WorkItem. */
export interface Session {
	readonly id: SessionId;
	readonly workerId: string;
	readonly workItemId: string;
	readonly status: SessionStatus;
	readonly context: WorkerContext;
	/** Epoch milliseconds. */
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly lastHeartbeatAt: number;
	/** How many times the Watchdog has restarted this session. */
	readonly restartCount: number;
}

export const SESSION_TRANSITIONS: TransitionTable<SessionStatus> = {
	[SessionStatus.ACTIVE]: [SessionStatus.STALLED, SessionStatus.COMPLETED, SessionStatus.FAILED],
	[SessionStatus.STALLED]: [SessionStatus.ACTIVE, SessionStatus.FAILED],
	[SessionStatus.COMPLETED]: [],
	[SessionStatus.FAILED]: [],
};

export function transitionSession(session: Session, to: SessionStatus, now: number): Session {
	assertTransition("Session", SESSION_TRANSITIONS, session.status, to);
	return { ...session, status: to, updatedAt: now };
}
