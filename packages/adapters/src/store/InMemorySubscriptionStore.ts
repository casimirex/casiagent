import type { Subscription, SubscriptionStorePort, ThreadKey } from "@casiagent/domain";

/** Process-local subscription store. Values are copied in and out. */
export class InMemorySubscriptionStore implements SubscriptionStorePort {
	readonly #byThread = new Map<string, Subscription>();

	async subscribe(sub: Subscription): Promise<Subscription> {
		const existing = this.#byThread.get(sub.threadKey);
		if (existing !== undefined && existing.workerId !== sub.workerId) {
			return structuredClone(existing);
		}
		this.#byThread.set(sub.threadKey, structuredClone(sub));
		return structuredClone(sub);
	}

	async findByThread(threadKey: ThreadKey): Promise<Subscription | undefined> {
		const sub = this.#byThread.get(threadKey);
		return sub === undefined ? undefined : structuredClone(sub);
	}

	async listByWorker(workerId: string): Promise<readonly Subscription[]> {
		return [...this.#byThread.values()]
			.filter((s) => s.workerId === workerId)
			.map((s) => structuredClone(s));
	}

	async removeByWorker(workerId: string): Promise<number> {
		let removed = 0;
		for (const [key, sub] of this.#byThread) {
			if (sub.workerId === workerId) {
				this.#byThread.delete(key);
				removed += 1;
			}
		}
		return removed;
	}
}
