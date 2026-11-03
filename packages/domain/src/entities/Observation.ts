/** An action the agent was not authorized to take, recorded for humans to review. */
export interface Observation {
	readonly id: string;
	readonly triggerId?: string;
	readonly sourceId: string;
	readonly threadId?: string;
	readonly authorId: string;
	/** What the agent would have done. */
	readonly intendedAction: string;
	/** Why it only observed. */
	readonly rationale: string;
	/** Epoch milliseconds. */
	readonly createdAt: number;
}
