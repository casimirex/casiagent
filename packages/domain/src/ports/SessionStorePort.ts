import type { Session } from "../entities/Session";
import type { SessionId } from "../value-objects/SessionId";

/** Persistence for Worker sessions. Implementations must keep sessions isolated from each other. */
export interface SessionStorePort {
	/** Insert or replace the full session state. */
	save(session: Session): Promise<void>;
	load(id: SessionId): Promise<Session | undefined>;
	/** Sessions whose status is not terminal (ACTIVE or STALLED). */
	listActive(): Promise<readonly Session[]>;
}
