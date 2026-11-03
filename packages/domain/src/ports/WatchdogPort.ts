import type { SessionId } from "../value-objects/SessionId";

/** Supervises running sessions and restarts those that stop sending heartbeats. */
export interface WatchdogPort {
	start(): void;
	stop(): void;
	/** Record that the session is still alive. */
	heartbeat(sessionId: SessionId): Promise<void>;
}
