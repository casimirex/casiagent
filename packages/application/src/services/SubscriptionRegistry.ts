import {
	type ClockPort,
	type SessionId,
	type SourceEvent,
	type SourceId,
	type Subscription,
	type SubscriptionStorePort,
	ThreadKey,
} from "@superagent/domain";

export interface SubscriptionOwner {
	readonly workerId: string;
	readonly workItemId: string;
	readonly sessionId: SessionId;
}

export interface SubscriptionRegistryDeps {
	readonly store: SubscriptionStorePort;
	readonly clock: ClockPort;
}

/**
 * Maps threads to the Worker that owns them. Application-level routing state, backed by
 * SubscriptionStorePort so it can be persisted without changing this class.
 */
export class SubscriptionRegistry {
	readonly #store: SubscriptionStorePort;
	readonly #clock: ClockPort;

	constructor(deps: SubscriptionRegistryDeps) {
		this.#store = deps.store;
		this.#clock = deps.clock;
	}

	/**
	 * Subscribe `owner` to a thread. Returns false if another Worker already owns it;
	 * the first owner keeps the thread.
	 */
	async subscribe(
		sourceId: SourceId,
		threadId: string,
		owner: SubscriptionOwner,
	): Promise<boolean> {
		const sub: Subscription = {
			threadKey: ThreadKey.of(sourceId, threadId),
			...owner,
			createdAt: this.#clock.now(),
		};
		const inForce = await this.#store.subscribe(sub);
		return inForce.workerId === owner.workerId;
	}

	/** The subscription for the event's thread, if it has one. */
	async lookup(event: SourceEvent): Promise<Subscription | undefined> {
		if (event.threadId === undefined) return undefined;
		return this.#store.findByThread(ThreadKey.of(event.sourceId, event.threadId));
	}

	listForWorker(workerId: string): Promise<readonly Subscription[]> {
		return this.#store.listByWorker(workerId);
	}

	/** Remove every subscription the Worker holds. Call when its WorkItem finishes. */
	unsubscribeWorker(workerId: string): Promise<number> {
		return this.#store.removeByWorker(workerId);
	}
}
