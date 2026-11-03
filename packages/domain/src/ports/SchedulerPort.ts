/** Call to stop a scheduled task. */
export type CancelSchedule = () => void;

/** Runs a callback periodically. Lets use cases send heartbeats without touching timers. */
export interface SchedulerPort {
	every(intervalMs: number, task: () => void): CancelSchedule;
}
