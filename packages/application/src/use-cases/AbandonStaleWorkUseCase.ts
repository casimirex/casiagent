import {
	type ClockPort,
	SessionStatus,
	type SessionStorePort,
	type SourceEvent,
	transitionSession,
	transitionWorkItem,
	WorkItemStatus,
} from "@casiagent/domain";
import type { PanelPort } from "../ports/PanelPort";
import type { SubscriptionRegistry } from "../services/SubscriptionRegistry";

export interface AbandonStaleWorkDeps {
	readonly store: SessionStorePort;
	readonly subscriptions: SubscriptionRegistry;
	readonly panel: PanelPort;
	readonly clock: ClockPort;
	/** How long a WorkItem may wait for feedback. Default 7 days. */
	readonly maxAwaitMs?: number;
}

export interface AbandonOutcome {
	readonly abandoned: readonly string[];
	/** Follow-ups that were still queued for abandoned work. Re-route them. */
	readonly orphanedFollowUps: readonly SourceEvent[];
}

/**
 * Closes work that has waited too long for feedback: WorkItem AWAITING → ABANDONED,
 * session WAITING → FAILED, subscriptions removed, a human told. A follow-up that wakes
 * the Worker at the same moment wins: the compare-and-set on the WorkItem fails and the
 * work is left alone.
 */
export class AbandonStaleWorkUseCase {
	readonly #store: SessionStorePort;
	readonly #subscriptions: SubscriptionRegistry;
	readonly #panel: PanelPort;
	readonly #clock: ClockPort;
	readonly #maxAwaitMs: number;

	constructor(deps: AbandonStaleWorkDeps) {
		this.#store = deps.store;
		this.#subscriptions = deps.subscriptions;
		this.#panel = deps.panel;
		this.#clock = deps.clock;
		this.#maxAwaitMs = deps.maxAwaitMs ?? 7 * 24 * 60 * 60_000;
	}

	async execute(): Promise<AbandonOutcome> {
		const now = this.#clock.now();
		const abandoned: string[] = [];
		const orphanedFollowUps: SourceEvent[] = [];

		for (const session of await this.#store.listSessionsByStatus(SessionStatus.WAITING)) {
			if (now - session.updatedAt <= this.#maxAwaitMs) continue;
			const item = await this.#store.loadWorkItem(session.workItemId);
			if (item?.status !== WorkItemStatus.AWAITING) continue;
			const closed = await this.#store.compareAndSetWorkItem(
				WorkItemStatus.AWAITING,
				transitionWorkItem(item, WorkItemStatus.ABANDONED),
			);
			if (closed === undefined) continue; // a follow-up woke it just now

			await this.#store.save(transitionSession(session, SessionStatus.FAILED, now));
			await this.#subscriptions.unsubscribeWorker(session.workerId);
			orphanedFollowUps.push(...(await this.#store.drainFollowUps(session.id)));
			const days = Math.round((now - session.updatedAt) / (24 * 60 * 60_000));
			await this.#panel.showAttentionItem({
				id: `work-abandoned:${item.id}`,
				kind: "WORK_ABANDONED",
				message: `Work item ${item.id} waited ${days} day(s) for feedback with no reply and was abandoned.${item.result === undefined ? "" : ` Last result: ${item.result.output}`}`,
				sessionId: session.id,
				workItemId: item.id,
				createdAt: now,
			});
			abandoned.push(item.id);
		}
		return { abandoned, orphanedFollowUps };
	}
}
