import type { ClockPort } from "@superagent/domain";

export class SystemClock implements ClockPort {
	now(): number {
		return Date.now();
	}
}
