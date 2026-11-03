import type { ClockPort } from "@casiagent/domain";

export class SystemClock implements ClockPort {
	now(): number {
		return Date.now();
	}
}
