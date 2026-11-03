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
} from "@casiagent/domain";
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
 * the caller decides how to run it. Claiming the Trigger (ACCEPTED -> CONSUMED) and
 * creating its WorkItem and session is one atomic store operation, so concurrent
 * dispatches never start two Workers for one Trigger, and a crash cannot strand it.
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

			const trigger = transitionTrigger(candidate, TriggerStatus.CONSUMED);
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

			// Claim + create in one atomic step: the loser of a race, or a crash, leaves nothing behind.
			if (!(await this.#store.claimTriggerForWork(trigger, workItem, session))) continue;
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
