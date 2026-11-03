import type { Subscription } from "../entities/Subscription";
import type { ThreadKey } from "../value-objects/ThreadKey";

/** Persistence for thread subscriptions. A thread has at most one subscribed Worker. */
export interface SubscriptionStorePort {
	/**
	 * Subscribe atomically. Returns the subscription now in force for the thread: `sub` if
	 * the thread was free or already this Worker's, otherwise the existing owner's (the
	 * first Worker to subscribe keeps the thread).
	 */
	subscribe(sub: Subscription): Promise<Subscription>;
	findByThread(threadKey: ThreadKey): Promise<Subscription | undefined>;
	listByWorker(workerId: string): Promise<readonly Subscription[]>;
	/** Remove all of a Worker's subscriptions. Returns how many were removed. */
	removeByWorker(workerId: string): Promise<number>;
}
