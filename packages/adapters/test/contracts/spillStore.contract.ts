import { describe, expect, test } from "bun:test";
import { type ContextSpillPort, SessionId } from "@superagent/domain";

export function spillStoreContract(name: string, make: () => ContextSpillPort): void {
	const s1 = SessionId.of("s1");
	const msg = (content: string) => ({ role: "user" as const, content });

	describe(`${name}: context spill`, () => {
		test("spill appends with increasing seq and returns the running total", async () => {
			const store = make();
			expect(await store.spill(s1, [msg("a"), msg("b")])).toBe(2);
			expect(await store.spill(s1, [msg("c")])).toBe(3);
			expect(await store.count(s1)).toBe(3);
			expect(await store.count(SessionId.of("other"))).toBe(0);
		});

		test("recall ranks by distinct keyword hits and returns oldest first", async () => {
			const store = make();
			await store.spill(s1, [
				msg("the database migration failed on postgres"),
				msg("lunch plans for friday"),
				msg("postgres connection pool settings"),
				msg("migration rollback on postgres worked"),
			]);
			const hits = await store.recall(s1, "postgres migration error", 2);
			expect(hits.map((h) => h.seq)).toEqual([0, 3]);
			expect(await store.recall(s1, "kubernetes", 5)).toEqual([]);
		});

		test("recall is scoped to the session", async () => {
			const store = make();
			await store.spill(s1, [msg("postgres")]);
			expect(await store.recall(SessionId.of("other"), "postgres", 5)).toEqual([]);
		});
	});
}
