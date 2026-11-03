import {
	type ClockPort,
	comparePriority,
	type DispatchRecord,
	type IdGeneratorPort,
	type RouterState,
	type Session,
	SessionId,
	SessionStatus,
	type SessionStorePort,
	TriggerStatus,
	transitionTrigger,
	type WorkItem,
	WorkItemStatus,
} from "@superagent/domain";
import { buildWorkerContext } from "../services/buildWorkerContext";

export interface DispatchWorkDeps {
	readonly store: SessionStorePort;
	readonly ids: IdGeneratorPort;
	readonly clock: ClockPort;
}

export interface DispatchOutcome {
	/** The Router's state after this dispatch. Stays with the Router; never given to Workers. */
	readonly state: RouterState;
	/** One entry per Worker started. The caller runs WorkerExecutionUseCase for each. */
	readonly dispatched: readonly DispatchRecord[];
}

/**
 * Turns every ACCEPTED Trigger (highest priority first) into a WorkItem with its own Worker and session.
 *
 * "Spawning" a Worker means persisting an ACTIVE session with an isolated context;
 * the caller decides how to run it. Each Trigger is claimed atomically
 * (ACCEPTED -> CONSUMED) before any work is created, so concurrent dispatches never
 * start two Workers for the same Trigger.
 *
 * Known gap: a crash between the claim and saving the session leaves a CONSUMED
 * Trigger with no WorkItem. Phase 4 recovery should reconcile these.
 */
export class DispatchWorkUseCase {
	readonly #store: SessionStorePort;
	readonly #ids: IdGeneratorPort;
	readonly #clock: ClockPort;

	constructor(deps: DispatchWorkDeps) {
		this.#store = deps.store;
		this.#ids = deps.ids;
		this.#clock = deps.clock;
	}

	async execute(state: RouterState): Promise<DispatchOutcome> {
		// High priority first; the store already returns oldest first, and sort is stable.
		const accepted = [...(await this.#store.listTriggersByStatus(TriggerStatus.ACCEPTED))].sort(
			(a, b) => comparePriority(a.decision?.priority ?? "normal", b.decision?.priority ?? "normal"),
		);
		const dispatched: DispatchRecord[] = [];

		for (const candidate of accepted) {
			if (state.isDispatched(candidate.id)) continue;

			const trigger = await this.#store.compareAndSetTrigger(
				TriggerStatus.ACCEPTED,
				transitionTrigger(candidate, TriggerStatus.CONSUMED),
			);
			if (trigger === undefined) continue; // another dispatcher claimed it first

			const workerId = this.#ids.next();
			const workItem: WorkItem = {
				id: this.#ids.next(),
				triggerId: trigger.id,
				assignedWorkerId: workerId,
				status: WorkItemStatus.PENDING,
			};
			const now = this.#clock.now();
			const session: Session = {
				id: SessionId.of(this.#ids.next()),
				workerId,
				workItemId: workItem.id,
				status: SessionStatus.ACTIVE,
				context: buildWorkerContext(trigger),
				createdAt: now,
				updatedAt: now,
				lastHeartbeatAt: now,
				restartCount: 0,
			};

			await this.#store.saveWorkItem(workItem);
			await this.#store.save(session);
			dispatched.push({
				triggerId: trigger.id,
				workItemId: workItem.id,
				workerId,
				sessionId: session.id,
			});
		}

		return { state: state.withDispatched(dispatched), dispatched };
	}
}
