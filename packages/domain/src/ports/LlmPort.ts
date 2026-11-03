import type { WorkerContext } from "../entities/Session";
import type { Trigger } from "../entities/Trigger";
import type { WorkItem, WorkResult } from "../entities/WorkItem";

export type TriggerPriority = "low" | "normal" | "high";

export interface TriggerEvaluationRequest {
	readonly trigger: Trigger;
	/** The team's written authorization rules, in natural language. */
	readonly authorizationRules: string;
	/** Number of WorkItems not yet finished, so the model can avoid piling on work. */
	readonly queueDepth: number;
}

export interface TriggerVerdict {
	readonly accepted: boolean;
	readonly reason: string;
	readonly priority: TriggerPriority;
}

export interface TaskExecutionRequest {
	readonly workItem: WorkItem;
	/** Worker-scoped context only. Never includes Router state. */
	readonly context: WorkerContext;
}

/** A language model provider, used for semantic evaluation and task execution. */
export interface LlmPort {
	evaluateTrigger(request: TriggerEvaluationRequest): Promise<TriggerVerdict>;
	executeTask(request: TaskExecutionRequest): Promise<WorkResult>;
}
