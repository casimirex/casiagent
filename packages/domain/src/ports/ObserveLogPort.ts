import type { Observation } from "../entities/Observation";

export interface ObserveLogPort {
	/** Record an observation. Idempotent by id. */
	record(observation: Observation): Promise<void>;
	/** Newest first. */
	list(limit: number): Promise<readonly Observation[]>;
}
