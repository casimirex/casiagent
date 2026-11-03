export interface ClockPort {
	/** Current time in epoch milliseconds. */
	now(): number;
}
