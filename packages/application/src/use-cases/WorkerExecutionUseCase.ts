import {
	type ClockPort,
	isTerminalWorkItem,
	type LlmPort,
	type OutboundMessage,
	type SchedulerPort,
	type Session,
	type SessionId,
	SessionStatus,
	type SessionStorePort,
	type SourceEvent,
	type SourceId,
	type SourcePort,
	type Subscription,
	transitionSession,
	transitionWorkItem,
	type WatchdogPort,
	type WorkItem,
	WorkItemStatus,
	type WorkResult,
} from "@superagent/domain";
import { UseCaseError } from "../errors";
import type { PanelPort } from "../ports/PanelPort";
import { eventMessage, resultMessage } from "../services/buildWorkerContext";
import type { ContextManager } from "../services/ContextManager";
import type { SubscriptionRegistry } from "../services/SubscriptionRegistry";

export interface WorkerExecutionDeps {
	readonly store: SessionStorePort;
	readonly llm: LlmPort;
	/** Where to write results back, by source. */
	readonly sources: ReadonlyMap<SourceId, SourcePort>;
	readonly subscriptions: SubscriptionRegistry;
	/** Keeps the working context within the token budget (spill + recall). */
	readonly context: ContextManager;
	/** Where failures, undelivered results, questions and review requests are surfaced. */
	readonly panel: PanelPort;
	readonly clock: ClockPort;
	/** Heartbeats while the LLM runs, so long calls are not mistaken for stalls. */
	readonly heartbeat?: HeartbeatConfig;
}

export interface HeartbeatConfig {
	readonly watchdog: WatchdogPort;
	readonly scheduler: SchedulerPort;
	/** Must be well under the Watchdog's stall threshold. */
	readonly intervalMs: number;
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
	| {
			readonly status: "COMPLETED";
			readonly workItem: WorkItem;
			readonly delivery: DeliveryStatus;
			/** Follow-ups that arrived as the Worker finished. Re-route them (they will go to the Router). */
			readonly orphanedFollowUps: readonly SourceEvent[];
	  }
	/** Produced a reviewable artifact; subscribed and waiting for follow-ups. */
	| { readonly status: "AWAITING"; readonly workItem: WorkItem; readonly delivery: DeliveryStatus }
	| {
			readonly status: "FAILED";
			readonly workItem: WorkItem;
			readonly error: string;
			readonly orphanedFollowUps: readonly SourceEvent[];
	  };

export type FollowUpOutcome =
	| WorkerOutcome
	/** The Worker is busy; it will process the event when its current run ends. */
	| { readonly status: "QUEUED" }
	/** This event was already delivered to the session. */
	| { readonly status: "DUPLICATE" }
	/** The WorkItem has finished. Re-route these events (they will go to the Router). */
	| { readonly status: "STALE"; readonly events: readonly SourceEvent[] };

/** Where the next reply goes: the thread of the latest event the Worker handled. */
interface ReplyTarget {
	readonly sourceId: SourceId;
	readonly threadId?: string;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function targetOf(event: { sourceId: SourceId; threadId?: string }): ReplyTarget {
	return event.threadId === undefined
		? { sourceId: event.sourceId }
		: { sourceId: event.sourceId, threadId: event.threadId };
}

/**
 * Runs a WorkItem in its Worker's isolated session, including follow-up events routed
 * directly to it (Phase 3).
 *
 * Lifecycle: PENDING -> RUNNING -> (AWAITING <-> RUNNING)* -> COMPLETED | FAILED.
 * - On start the Worker subscribes to the originating thread; when a result is
 *   AWAITING_FEEDBACK it also subscribes to the result's artifacts (e.g. its PR).
 * - Follow-ups go into the session's inbox. Whoever moves the WorkItem AWAITING -> RUNNING
 *   (an atomic compare-and-set) runs it; everyone else just queues. After going back to
 *   AWAITING the Worker re-checks the inbox, so an event that arrived during the run is
 *   never stranded.
 * - On COMPLETED or FAILED all the Worker's subscriptions are removed.
 * - Results are persisted before replying, so a failed reply never re-runs the task.
 */
export class WorkerExecutionUseCase {
	readonly #store: SessionStorePort;
	readonly #llm: LlmPort;
	readonly #sources: ReadonlyMap<SourceId, SourcePort>;
	readonly #subscriptions: SubscriptionRegistry;
	readonly #context: ContextManager;
	readonly #panel: PanelPort;
	readonly #clock: ClockPort;
	readonly #heartbeat: HeartbeatConfig | undefined;

	constructor(deps: WorkerExecutionDeps) {
		this.#store = deps.store;
		this.#llm = deps.llm;
		this.#sources = deps.sources;
		this.#subscriptions = deps.subscriptions;
		this.#context = deps.context;
		this.#panel = deps.panel;
		this.#clock = deps.clock;
		this.#heartbeat = deps.heartbeat;
	}

	/**
	 * First run of a dispatched WorkItem. Also resumes a RUNNING one (Phase 4 Watchdog).
	 * Throws if the WorkItem is finished or the assignment does not match stored state.
	 */
	async execute(assignment: WorkerAssignment): Promise<WorkerOutcome> {
		const { item, session } = await this.#loadAssignment(assignment);
		const trigger = await this.#store.loadTrigger(item.triggerId);
		if (trigger === undefined) throw new UseCaseError(`Trigger ${item.triggerId} not found`);

		let running = item;
		if (item.status !== WorkItemStatus.RUNNING) {
			const claimed = await this.#store.compareAndSetWorkItem(
				item.status,
				transitionWorkItem(item, WorkItemStatus.RUNNING),
			);
			if (claimed === undefined) {
				throw new UseCaseError(`WorkItem ${item.id} was claimed concurrently`);
			}
			running = claimed;
		}

		if (trigger.threadId !== undefined) {
			await this.#subscriptions.subscribe(trigger.sourceId, trigger.threadId, assignment);
		}
		return this.#runLoop(running, session, targetOf(trigger));
	}

	/** Deliver an event routed DIRECT to the subscribed Worker. */
	async deliverFollowUp(subscription: Subscription, event: SourceEvent): Promise<FollowUpOutcome> {
		const assignment: WorkerAssignment = subscription;
		const item = await this.#store.loadWorkItem(assignment.workItemId);
		if (item === undefined || isTerminalWorkItem(item)) return { status: "STALE", events: [event] };

		if (!(await this.#store.enqueueFollowUp(assignment.sessionId, event))) {
			return { status: "DUPLICATE" };
		}

		// Read state only after enqueueing. Either we see AWAITING and try to claim, or the
		// running Worker's post-run inbox check (which happens after it sets AWAITING) sees
		// our event. If both try to claim, the CAS lets exactly one win; the winner drains.
		const fresh = await this.#store.loadWorkItem(assignment.workItemId);
		if (fresh?.status === WorkItemStatus.AWAITING) {
			const claimed = await this.#store.compareAndSetWorkItem(
				WorkItemStatus.AWAITING,
				transitionWorkItem(fresh, WorkItemStatus.RUNNING),
			);
			if (claimed !== undefined) {
				const { session } = await this.#loadAssignment(assignment);
				return this.#runLoop(claimed, session, targetOf(event));
			}
		}

		const latest = await this.#store.loadWorkItem(assignment.workItemId);
		if (latest === undefined || isTerminalWorkItem(latest)) {
			return { status: "STALE", events: await this.#store.drainFollowUps(assignment.sessionId) };
		}
		return { status: "QUEUED" };
	}

	async #loadAssignment(
		assignment: WorkerAssignment,
	): Promise<{ item: WorkItem; session: Session }> {
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
		if (isTerminalWorkItem(item)) {
			// Surfaces as an illegal-transition DomainError, matching the entity rules.
			transitionWorkItem(item, WorkItemStatus.RUNNING);
		}
		return { item, session };
	}

	/** `item` must be RUNNING and owned by this caller. */
	async #runLoop(item: WorkItem, session: Session, target: ReplyTarget): Promise<WorkerOutcome> {
		let running = item;
		let current = session;
		let replyTo = target;

		for (;;) {
			const followUps = await this.#store.drainFollowUps(current.id);
			const last = followUps.at(-1);
			if (last !== undefined) replyTo = targetOf(last);
			const now = this.#clock.now();
			const working = await this.#context.getWorkingContext({
				...(current.status === SessionStatus.ACTIVE
					? current
					: transitionSession(current, SessionStatus.ACTIVE, now)),
				context: { messages: [...current.context.messages, ...followUps.map(eventMessage)] },
				updatedAt: now,
				lastHeartbeatAt: now,
			});
			current = working.session;
			await this.#store.save(current);

			let result: WorkResult;
			const stopHeartbeat = this.#startHeartbeat(current.id);
			try {
				result = await this.#llm.executeTask({ workItem: running, context: working.context });
			} catch (error) {
				return this.#fail(running, current, messageOf(error));
			} finally {
				stopHeartbeat();
			}

			current = {
				...current,
				context: { messages: [...current.context.messages, resultMessage(result)] },
			};

			if (result.status === "AWAITING_FEEDBACK") {
				for (const artifact of result.artifacts ?? []) {
					await this.#subscriptions.subscribe(artifact.sourceId, artifact.threadId, {
						workerId: current.workerId,
						workItemId: running.id,
						sessionId: current.id,
					});
				}
				const awaiting = await this.#transition(running, WorkItemStatus.AWAITING, result);
				current = transitionSession(current, SessionStatus.WAITING, this.#clock.now());
				await this.#store.save(current);
				const delivery = await this.#replyAndSurface(current, replyTo, result);

				// An event may have been queued while we ran; it could not claim the WorkItem.
				if ((await this.#store.countFollowUps(current.id)) > 0) {
					const reclaimed = await this.#store.compareAndSetWorkItem(
						WorkItemStatus.AWAITING,
						transitionWorkItem(awaiting, WorkItemStatus.RUNNING),
					);
					if (reclaimed !== undefined) {
						running = reclaimed;
						continue;
					}
				}
				return { status: "AWAITING", workItem: awaiting, delivery };
			}

			const completed = await this.#transition(running, WorkItemStatus.COMPLETED, result);
			await this.#store.save(
				transitionSession(current, SessionStatus.COMPLETED, this.#clock.now()),
			);
			const delivery = await this.#replyAndSurface(current, replyTo, result);
			const orphanedFollowUps = await this.#release(current);
			return { status: "COMPLETED", workItem: completed, delivery, orphanedFollowUps };
		}
	}

	#startHeartbeat(sessionId: SessionId): () => void {
		const hb = this.#heartbeat;
		if (hb === undefined) return () => {};
		// A failed heartbeat must never fail the task; the Watchdog will notice if they stop.
		const beat = () => void hb.watchdog.heartbeat(sessionId).catch(() => {});
		return hb.scheduler.every(hb.intervalMs, beat);
	}

	async #fail(running: WorkItem, session: Session, error: string): Promise<WorkerOutcome> {
		const failed = await this.#transition(running, WorkItemStatus.FAILED);
		await this.#store.save(transitionSession(session, SessionStatus.FAILED, this.#clock.now()));
		const orphanedFollowUps = await this.#release(session);
		await this.#panel.showAttentionItem({
			id: `worker-failed:${failed.id}`,
			kind: "WORKER_FAILED",
			message: `Task ${failed.id} failed: ${error}`,
			sessionId: session.id,
			workItemId: failed.id,
			createdAt: this.#clock.now(),
		});
		return { status: "FAILED", workItem: failed, error, orphanedFollowUps };
	}

	/** RUNNING -> `to`. Only the owner of a RUNNING WorkItem calls this, so the CAS must succeed. */
	async #transition(running: WorkItem, to: WorkItemStatus, result?: WorkResult): Promise<WorkItem> {
		const next = await this.#store.compareAndSetWorkItem(
			WorkItemStatus.RUNNING,
			transitionWorkItem(running, to, result),
		);
		if (next === undefined) {
			throw new UseCaseError(`WorkItem ${running.id} changed while its Worker was running it`);
		}
		return next;
	}

	/** Terminal cleanup: drop subscriptions first, then hand back anything left in the inbox. */
	async #release(session: Session): Promise<readonly SourceEvent[]> {
		await this.#subscriptions.unsubscribeWorker(session.workerId);
		return this.#store.drainFollowUps(session.id);
	}

	/**
	 * Reply, then tell a human about anything they must act on: a reply that could not be
	 * delivered (nobody has seen the result) and any question or review request.
	 * Runs after the result is persisted.
	 */
	async #replyAndSurface(
		session: Session,
		target: ReplyTarget,
		result: WorkResult,
	): Promise<DeliveryStatus> {
		const delivery = await this.#reply(target, result);
		const now = this.#clock.now();
		const where = { sessionId: session.id, workItemId: session.workItemId };
		if (!delivery.delivered) {
			await this.#panel.showAttentionItem({
				id: `delivery-failed:${session.workItemId}:${now}`,
				kind: "DELIVERY_FAILED",
				message: `Could not post the result of ${session.workItemId} (${delivery.reason}). Result: ${result.output}`,
				...where,
				createdAt: now,
			});
		}
		if (result.attention !== undefined) {
			const { kind, message, url } = result.attention;
			await this.#panel.showAttentionItem({
				id: `${kind.toLowerCase()}:${session.workItemId}:${now}`,
				kind,
				message,
				...(url === undefined ? {} : { url }),
				...where,
				createdAt: now,
			});
		}
		return delivery;
	}

	async #reply(target: ReplyTarget, result: WorkResult): Promise<DeliveryStatus> {
		const source = this.#sources.get(target.sourceId);
		if (source === undefined) {
			return { delivered: false, reason: `No source registered for ${target.sourceId}` };
		}
		const message: OutboundMessage = {
			...(target.threadId === undefined ? {} : { threadId: target.threadId }),
			body: result.output,
		};
		try {
			await source.reply(message);
			return { delivered: true };
		} catch (error) {
			return { delivered: false, reason: messageOf(error) };
		}
	}
}
