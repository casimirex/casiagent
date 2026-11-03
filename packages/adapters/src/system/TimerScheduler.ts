import type { CancelSchedule, SchedulerPort } from "@superagent/domain";

export class TimerScheduler implements SchedulerPort {
	every(intervalMs: number, task: () => void): CancelSchedule {
		const handle = setInterval(task, intervalMs);
		return () => clearInterval(handle);
	}
}
