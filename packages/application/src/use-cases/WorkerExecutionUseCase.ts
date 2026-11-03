import {
	type ClockPort,
	type LlmPort,
	type OutboundMessage,
	type SessionId,
	SessionStatus,
	type SessionStorePort,
	type SourceId,
	type SourcePort,
	transitionSession,
	transitionWorkItem,
	type WorkItem,
	WorkItemStatus,
	type WorkResult,
} from "@superagent/domain";
import { UseCaseError } from "../errors";

export interface WorkerExecutionDeps {
	readonly store: SessionStorePort;
	readonly llm: LlmPort;
	/** Where to write results back, by the originating Trigger's source. */
	readonly sources: ReadonlyMap<SourceId, SourcePort>;
	readonly clock: ClockPort;
}

export interface WorkerAssignment {
	readonly workItemId: string;
	readonly workerId: string;
	readonly sessionId: SessionId;
}

export type DeliveryStatus =
	| { readonly delivered: true }
	| { readonly delivered: false; readonly reason: string };

export type WorkerOutcome =
	| { readonly status: "COMPLETED"; readonly workItem: WorkItem; readonly delivery: DeliveryStatus }
	| { readonly status: "FAILED"; readonly workItem: WorkItem; readonly error: string };

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one WorkItem in its Worker's isolated session.
 *
 * The LLM sees only the session's own context. The result is persisted before it is
 * written back to the source, so a failed write-back never causes the task to run
 * again; it is reported in `delivery` instead.
 *
 * A WorkItem already RUNNING is resumed (as the Phase 4 Watchdog will do after a stall).
 */
export class WorkerExecutionUseCase {
	readonly #store: SessionStorePort;
	readonly #llm: LlmPort;
	readonly #sources: ReadonlyMap<SourceId, SourcePort>;
	readonly #clock: ClockPort;

	constructor(deps: WorkerExecutionDeps) {
		this.#store = deps.store;
		this.#llm = deps.llm;
		this.#sources = deps.sources;
		this.#clock = deps.clock;
	}

	async execute(assignment: WorkerAssignment): Promise<WorkerOutcome> {
		const { workItemId, workerId, sessionId } = assignment;
		const [item, session] = await Promise.all([
			this.#store.loadWorkItem(workItemId),
			this.#store.load(sessionId),
		]);
		if (item === undefined) throw new UseCaseError(`WorkItem ${workItemId} not found`);
		if (session === undefined) throw new UseCaseError(`Session ${sessionId} not found`);
		if (item.assignedWorkerId !== workerId) {
			throw new UseCaseError(`WorkItem ${workItemId} is not assigned to worker ${workerId}`);
		}
		if (session.workerId !== workerId || session.workItemId !== workItemId) {
			throw new UseCaseError(`Session ${sessionId} does not belong to this assignment`);
		}

		const running =
			item.status === WorkItemStatus.RUNNING
				? item
				: transitionWorkItem(item, WorkItemStatus.RUNNING);
		if (running !== item) await this.#store.saveWorkItem(running);

		let result: WorkResult;
		try {
			result = await this.#llm.executeTask({ workItem: running, context: session.context });
		} catch (error) {
			const failed = transitionWorkItem(running, WorkItemStatus.FAILED);
			await this.#store.saveWorkItem(failed);
			await this.#store.save(transitionSession(session, SessionStatus.FAILED, this.#clock.now()));
			return { status: "FAILED", workItem: failed, error: messageOf(error) };
		}

		const completed = transitionWorkItem(running, WorkItemStatus.COMPLETED, result);
		await this.#store.saveWorkItem(completed);
		await this.#store.save(transitionSession(session, SessionStatus.COMPLETED, this.#clock.now()));

		return { status: "COMPLETED", workItem: completed, delivery: await this.#deliver(completed) };
	}

	async #deliver(item: WorkItem): Promise<DeliveryStatus> {
		const trigger = await this.#store.loadTrigger(item.triggerId);
		if (trigger === undefined) {
			return { delivered: false, reason: `Trigger ${item.triggerId} not found` };
		}
		const source = this.#sources.get(trigger.sourceId);
		if (source === undefined) {
			return { delivered: false, reason: `No source registered for ${trigger.sourceId}` };
		}
		const message: OutboundMessage = {
			...(trigger.threadId === undefined ? {} : { threadId: trigger.threadId }),
			body: item.result?.output ?? "",
		};
		try {
			await source.reply(message);
			return { delivered: true };
		} catch (error) {
			return { delivered: false, reason: messageOf(error) };
		}
	}
}
