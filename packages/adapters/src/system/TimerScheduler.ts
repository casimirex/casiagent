import type { CancelSchedule, SchedulerPort } from "@casiagent/domain";

export class TimerScheduler implements SchedulerPort {
	every(intervalMs: number, task: () => void): CancelSchedule {
		const handle = setInterval(task, intervalMs);
		return () => clearInterval(handle);
	}
}
