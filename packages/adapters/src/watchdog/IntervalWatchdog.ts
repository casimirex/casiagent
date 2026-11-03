import {
	type AttentionSinkPort,
	assessSessionHealth,
	type ClockPort,
	type Session,
	type SessionId,
	SessionStatus,
	type SessionStorePort,
	type SubscriptionStorePort,
	transitionSession,
	transitionWorkItem,
	type WatchdogPolicy,
	type WatchdogPort,
	WorkItemStatus,
} from "@casiagent/domain";

export interface IntervalWatchdogDeps {
	readonly store: SessionStorePort;
	readonly subscriptions: SubscriptionStorePort;
	readonly attention: AttentionSinkPort;
	readonly clock: ClockPort;
	/**
	 * Restart a stalled session from its persisted state. Wired by the composition root
	 * (to WorkerExecutionUseCase.execute); the Watchdog never calls use cases directly.
	 * Not awaited: a restarted run may take a long time.
	 */
	readonly onRestart: (session: Session) => Promise<unknown>;
	readonly onError?: (error: unknown, session: Session) => void;
	/** Default 30 s. */
	readonly intervalMs?: number;
	/** Default 3 × intervalMs. */
	readonly stallAfterMs?: number;
	/** Default 3. */
	readonly maxRestarts?: number;
}

export interface WatchdogReport {
	readonly restarted: readonly SessionId[];
	readonly escalated: readonly SessionId[];
}

/**
 * Supervises ACTIVE/STALLED sessions. A session silent for longer than `stallAfterMs`
 * is marked STALLED and restarted, up to `maxRestarts` times; after that it is failed,
 * its WorkItem is closed, its subscriptions are removed, and a human is alerted.
 */
export class IntervalWatchdog implements WatchdogPort {
	readonly #deps: IntervalWatchdogDeps;
	readonly #intervalMs: number;
	readonly #policy: WatchdogPolicy;
	#timer: ReturnType<typeof setInterval> | undefined;
	#checking = false;

	constructor(deps: IntervalWatchdogDeps) {
		this.#deps = deps;
		this.#intervalMs = deps.intervalMs ?? 30_000;
		this.#policy = {
			stallAfterMs: deps.stallAfterMs ?? 3 * this.#intervalMs,
			maxRestarts: deps.maxRestarts ?? 3,
		};
	}

	start(): void {
		if (this.#timer !== undefined) return;
		this.#timer = setInterval(() => void this.check(), this.#intervalMs);
	}

	stop(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	async heartbeat(sessionId: SessionId): Promise<void> {
		await this.#deps.store.recordHeartbeat(sessionId, this.#deps.clock.now());
	}

	/** One supervision pass. Public so tests and the runtime can trigger it directly. */
	async check(): Promise<WatchdogReport> {
		if (this.#checking) return { restarted: [], escalated: [] }; // previous pass still running
		this.#checking = true;
		try {
			const restarted: SessionId[] = [];
			const escalated: SessionId[] = [];
			const now = this.#deps.clock.now();
			for (const session of await this.#deps.store.listActive()) {
				const verdict = assessSessionHealth(session, now, this.#policy);
				if (verdict.action === "RESTART") {
					await this.#restart(session, now);
					restarted.push(session.id);
				} else if (verdict.action === "ESCALATE") {
					await this.#escalate(session, verdict.reason, now);
					escalated.push(session.id);
				}
			}
			return { restarted, escalated };
		} finally {
			this.#checking = false;
		}
	}

	async #restart(session: Session, now: number): Promise<void> {
		const stalled: Session = {
			...(session.status === SessionStatus.STALLED
				? session
				: transitionSession(session, SessionStatus.STALLED, now)),
			restartCount: session.restartCount + 1,
			// Grace period: the restarted run gets a full stall window before being judged again.
			lastHeartbeatAt: now,
		};
		await this.#deps.store.save(stalled);
		Promise.resolve()
			.then(() => this.#deps.onRestart(stalled))
			.catch((error: unknown) => this.#deps.onError?.(error, stalled));
	}

	async #escalate(session: Session, reason: string, now: number): Promise<void> {
		const { store } = this.#deps;
		await store.save(transitionSession(session, SessionStatus.FAILED, now));

		const item = await store.loadWorkItem(session.workItemId);
		if (item?.status === WorkItemStatus.RUNNING) {
			await store.compareAndSetWorkItem(
				item.status,
				transitionWorkItem(item, WorkItemStatus.FAILED),
			);
		} else if (item?.status === WorkItemStatus.PENDING) {
			await store.compareAndSetWorkItem(
				item.status,
				transitionWorkItem(item, WorkItemStatus.ABANDONED),
			);
		}
		await this.#deps.subscriptions.removeByWorker(session.workerId);

		await this.#deps.attention.raise({
			id: `watchdog:${session.id}`,
			kind: "WATCHDOG_ESCALATION",
			message: reason,
			sessionId: session.id,
			workItemId: session.workItemId,
			createdAt: now,
		});
	}
}
