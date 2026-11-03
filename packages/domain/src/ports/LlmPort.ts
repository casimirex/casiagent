import type { WorkerContext } from "../entities/Session";
import type { WorkItem, WorkResult } from "../entities/WorkItem";
import type { TriggerPriority } from "../value-objects/TriggerPriority";

/**
 * A fully rendered evaluation prompt. The application owns and versions the template
 * (it contains the payload, authorization rules and queue depth); the adapter only
 * sends it and parses the model's answer into a TriggerVerdict.
 */
export interface TriggerEvaluationRequest {
	readonly triggerId: string;
	readonly promptVersion: string;
	readonly prompt: string;
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
