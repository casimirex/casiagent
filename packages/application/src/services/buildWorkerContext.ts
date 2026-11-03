import type { Trigger, WorkerContext } from "@superagent/domain";

/**
 * The initial context for a Worker: the data of its own Trigger and nothing else.
 * Router state, other Triggers and other Workers' data must never be added here.
 */
export function buildWorkerContext(trigger: Trigger): WorkerContext {
	const task = {
		sourceId: trigger.sourceId,
		...(trigger.threadId === undefined ? {} : { threadId: trigger.threadId }),
		authorId: trigger.authorId,
		payload: trigger.payload,
	};
	return { messages: [{ role: "user", content: JSON.stringify(task, null, 2) }] };
}
