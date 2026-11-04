import { Database } from "bun:sqlite";

/**
 * Schema, versioned with PRAGMA user_version. Append a new entry to MIGRATIONS for each
 * change; never edit an applied one.
 */
const MIGRATIONS: readonly string[] = [
	`
	CREATE TABLE triggers (
		id         TEXT PRIMARY KEY,
		source_id  TEXT NOT NULL,
		status     TEXT NOT NULL,
		timestamp  INTEGER NOT NULL,
		data_json  TEXT NOT NULL
	);
	CREATE INDEX triggers_status ON triggers (status, timestamp);

	CREATE TABLE work_items (
		id          TEXT PRIMARY KEY,
		trigger_id  TEXT NOT NULL,
		status      TEXT NOT NULL,
		data_json   TEXT NOT NULL
	);
	CREATE INDEX work_items_status ON work_items (status);

	CREATE TABLE sessions (
		id                 TEXT PRIMARY KEY,
		worker_id          TEXT NOT NULL,
		work_item_id       TEXT NOT NULL,
		status             TEXT NOT NULL,
		context_json       TEXT NOT NULL,
		created_at         INTEGER NOT NULL,
		updated_at         INTEGER NOT NULL,
		last_heartbeat_at  INTEGER NOT NULL,
		restart_count      INTEGER NOT NULL
	);
	CREATE INDEX sessions_status ON sessions (status);

	CREATE TABLE follow_ups (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		session_id  TEXT NOT NULL,
		event_id    TEXT NOT NULL,
		event_json  TEXT NOT NULL,
		drained     INTEGER NOT NULL DEFAULT 0,
		UNIQUE (session_id, event_id)
	);

	CREATE TABLE subscriptions (
		thread_key    TEXT PRIMARY KEY,
		worker_id     TEXT NOT NULL,
		work_item_id  TEXT NOT NULL,
		session_id    TEXT NOT NULL,
		created_at    INTEGER NOT NULL
	);
	CREATE INDEX subscriptions_worker ON subscriptions (worker_id);

	CREATE TABLE context_spill (
		session_id  TEXT NOT NULL,
		seq         INTEGER NOT NULL,
		role        TEXT NOT NULL,
		content     TEXT NOT NULL,
		PRIMARY KEY (session_id, seq)
	);
	`,
	// 2: Phase 5 — attention items and the observe log.
	`
	CREATE TABLE attention_items (
		id           TEXT PRIMARY KEY,
		created_at   INTEGER NOT NULL,
		resolved_at  INTEGER,
		data_json    TEXT NOT NULL
	);
	CREATE INDEX attention_items_open ON attention_items (resolved_at, created_at);

	CREATE TABLE observe_log (
		id          TEXT PRIMARY KEY,
		created_at  INTEGER NOT NULL,
		data_json   TEXT NOT NULL
	);
	CREATE INDEX observe_log_created ON observe_log (created_at);
	`,
	// 3: Phase 6 — poll cursors for event sources.
	`
	CREATE TABLE source_cursors (
		key    TEXT PRIMARY KEY,
		value  INTEGER NOT NULL
	);
	`,
];

/** The schema version a fully migrated database reports in PRAGMA user_version. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** Open (or create) a database and bring its schema up to date. Use ":memory:" for tests. */
export function openDatabase(path: string): Database {
	const db = new Database(path, { create: true, strict: true });
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA busy_timeout = 5000;");
	db.exec("PRAGMA foreign_keys = ON;");
	migrate(db);
	return db;
}

export function migrate(db: Database): void {
	const row = db.query("PRAGMA user_version").get() as { user_version: number };
	for (let version = row.user_version; version < MIGRATIONS.length; version++) {
		db.transaction(() => {
			db.exec(MIGRATIONS[version] as string);
			db.exec(`PRAGMA user_version = ${version + 1}`);
		})();
	}
}
