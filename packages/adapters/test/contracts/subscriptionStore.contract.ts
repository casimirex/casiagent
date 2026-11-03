import { describe, expect, test } from "bun:test";
import { type SubscriptionStorePort, ThreadKey } from "@casiagent/domain";
import { REPO, subscription } from "./fixtures";

export function subscriptionStoreContract(name: string, make: () => SubscriptionStorePort): void {
	describe(`${name}: subscriptions`, () => {
		test("first subscriber keeps the thread; subscribe returns the owner in force", async () => {
			const store = make();
			expect((await store.subscribe(subscription("t", "w1"))).workerId).toBe("w1");
			expect((await store.subscribe(subscription("t", "w2"))).workerId).toBe("w1");
			expect((await store.subscribe(subscription("t", "w1"))).workerId).toBe("w1");
			expect(await store.findByThread(ThreadKey.of(REPO, "t"))).toEqual(subscription("t", "w1"));
			expect(await store.findByThread(ThreadKey.of(REPO, "none"))).toBeUndefined();
		});

		test("listByWorker and removeByWorker affect only that worker", async () => {
			const store = make();
			await store.subscribe(subscription("a", "w1"));
			await store.subscribe(subscription("b", "w1"));
			await store.subscribe(subscription("c", "w2"));
			expect(await store.listByWorker("w1")).toHaveLength(2);
			expect(await store.removeByWorker("w1")).toBe(2);
			expect(await store.listByWorker("w1")).toEqual([]);
			expect(await store.listByWorker("w2")).toEqual([subscription("c", "w2")]);
		});
	});
}
