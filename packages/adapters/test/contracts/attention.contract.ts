import { describe, expect, test } from "bun:test";
import type {
	AttentionItem,
	AttentionStorePort,
	Observation,
	ObserveLogPort,
} from "@superagent/domain";

export const attentionItem = (id: string, createdAt: number): AttentionItem => ({
	id,
	kind: "WORKER_FAILED",
	message: `item ${id}`,
	workItemId: "w1",
	createdAt,
});

export function attentionStoreContract(name: string, make: () => AttentionStorePort): void {
	describe(`${name}: attention items`, () => {
		test("raise is idempotent by id; listOpen is newest first", async () => {
			const store = make();
			expect(await store.raise(attentionItem("a", 1))).toBe(true);
			expect(await store.raise(attentionItem("b", 2))).toBe(true);
			expect(await store.raise({ ...attentionItem("a", 9), message: "changed" })).toBe(false);
			expect(await store.listOpen()).toEqual([attentionItem("b", 2), attentionItem("a", 1)]);
		});

		test("resolve hides an item and reports unknown / already-resolved ids", async () => {
			const store = make();
			await store.raise(attentionItem("a", 1));
			expect(await store.resolve("a", 5)).toBe("RESOLVED");
			expect(await store.resolve("a", 6)).toBe("ALREADY_RESOLVED");
			expect(await store.resolve("nope", 6)).toBe("NOT_FOUND");
			expect(await store.listOpen()).toEqual([]);
		});
	});
}

export const observation = (id: string, createdAt: number): Observation => ({
	id,
	sourceId: "github:org/repo",
	authorId: "alice",
	intendedAction: `would do ${id}`,
	rationale: "inferred work is observe-only",
	createdAt,
});

export function observeLogContract(name: string, make: () => ObserveLogPort): void {
	describe(`${name}: observe log`, () => {
		test("record is idempotent by id; list is newest first and limited", async () => {
			const log = make();
			await log.record(observation("a", 1));
			await log.record(observation("b", 3));
			await log.record(observation("c", 2));
			await log.record({ ...observation("a", 9), rationale: "changed" });
			expect((await log.list(10)).map((o) => o.id)).toEqual(["b", "c", "a"]);
			expect(await log.list(1)).toEqual([observation("b", 3)]);
			expect(await log.list(0)).toEqual([]);
		});
	});
}
