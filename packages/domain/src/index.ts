export { DomainError } from "./DomainError";
export {
	type ContextMessage,
	SESSION_TRANSITIONS,
	type Session,
	transitionSession,
	type WorkerContext,
} from "./entities/Session";
export {
	TRIGGER_TRANSITIONS,
	type Trigger,
	type TriggerPayload,
	transitionTrigger,
} from "./entities/Trigger";
export type { TransitionTable } from "./entities/transitions";
export {
	isTerminalWorkItem,
	transitionWorkItem,
	WORK_ITEM_TRANSITIONS,
	type WorkItem,
	type WorkResult,
} from "./entities/WorkItem";
export type {
	LlmPort,
	TaskExecutionRequest,
	TriggerEvaluationRequest,
	TriggerPriority,
	TriggerVerdict,
} from "./ports/LlmPort";
export type { SessionStorePort } from "./ports/SessionStorePort";
export type { SourceEvent, SourceEventHandler, SourcePort, Unsubscribe } from "./ports/SourcePort";
export type { WatchdogPort } from "./ports/WatchdogPort";
export { SessionId } from "./value-objects/SessionId";
export { SourceId } from "./value-objects/SourceId";
export { SessionStatus, TriggerStatus, WorkItemStatus } from "./value-objects/TaskStatus";
