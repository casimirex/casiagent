import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	InMemoryAttentionStore,
	InMemoryContextSpillStore,
	InMemoryObserveLog,
	InMemorySessionStore,
	InMemorySubscriptionStore,
	openDatabase,
	SCHEMA_VERSION,
	SqliteAttentionStore,
	SqliteContextSpillStore,
	SqliteObserveLog,
	SqliteSessionStore,
	SqliteSubscriptionStore,
} from "@casiagent/adapters";
import { SessionId, TriggerStatus } from "@casiagent/domain";
import { attentionStoreContract, observeLogContract } from "./contracts/attention.contract";
import { session, subscription, trigger, workItem } from "./contracts/fixtures";
import { sessionStoreContract } from "./contracts/sessionStore.contract";
import { spillStoreContract } from "./contracts/spillStore.contract";
import { subscriptionStoreContract } from "./contracts/subscriptionStore.contract";

sessionStoreContract("InMemorySessionStore", () => new InMemorySessionStore());
sessionStoreContract("SqliteSessionStore", () => new SqliteSessionStore(openDatabase(":memory:")));
subscriptionStoreContract("InMemorySubscriptionStore", () => new InMemorySubscriptionStore());
subscriptionStoreContract(
	"SqliteSubscriptionStore",
	() => new SqliteSubscriptionStore(openDatabase(":memory:")),
);
spillStoreContract("InMemoryContextSpillStore", () => new InMemoryContextSpillStore());
spillStoreContract(
	"SqliteContextSpillStore",
	() => new SqliteContextSpillStore(openDatabase(":memory:")),
);

describe("SQLite on disk", () => {
	const dir = mkdtempSync(join(tmpdir(), "casiagent-test-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("state survives closing and reopening the database (process restart)", async () => {
		const path = join(dir, "restart.sqlite");
		const db1 = openDatabase(path);
		const store1 = new SqliteSessionStore(db1);
		await store1.createTrigger(trigger("t", 1));
		await store1.claimTriggerForWork(
			trigger("t", 1, TriggerStatus.CONSUMED),
			workItem("w"),
			session("s"),
		);
		await new SqliteSubscriptionStore(db1).subscribe(subscription("pr-1", "worker-s"));
		db1.close();

		const db2 = openDatabase(path);
		const store2 = new SqliteSessionStore(db2);
		expect(await store2.load(SessionId.of("s"))).toEqual(session("s"));
		expect(await store2.loadWorkItem("w")).toEqual(workItem("w"));
		expect((await store2.loadTrigger("t"))?.status).toBe(TriggerStatus.CONSUMED);
		expect(await new SqliteSubscriptionStore(db2).listByWorker("worker-s")).toHaveLength(1);
		db2.close();
	});

	test("migrations are idempotent", () => {
		const path = join(dir, "migrate.sqlite");
		openDatabase(path).close();
		const db = openDatabase(path);
		expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
			SCHEMA_VERSION,
		);
		db.close();
	});

	test("claims are atomic across separate connections to the same file", async () => {
		const path = join(dir, "multi.sqlite");
		const a = new SqliteSessionStore(openDatabase(path));
		const b = new SqliteSessionStore(openDatabase(path));
		await a.createTrigger(trigger("t", 1));
		const consumed = trigger("t", 1, TriggerStatus.CONSUMED);
		const results = await Promise.all([
			a.claimTriggerForWork(consumed, workItem("wa"), session("sa")),
			b.claimTriggerForWork(consumed, workItem("wb"), session("sb")),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
	});
});

attentionStoreContract("InMemoryAttentionStore", () => new InMemoryAttentionStore());
attentionStoreContract(
	"SqliteAttentionStore",
	() => new SqliteAttentionStore(openDatabase(":memory:")),
);
observeLogContract("InMemoryObserveLog", () => new InMemoryObserveLog());
observeLogContract("SqliteObserveLog", () => new SqliteObserveLog(openDatabase(":memory:")));
