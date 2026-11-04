import type { Database } from "bun:sqlite";
import type { CursorStore } from "../github/cursorStore";

export class SqliteCursorStore implements CursorStore {
	readonly #db: Database;

	constructor(db: Database) {
		this.#db = db;
	}

	async get(key: string): Promise<number | undefined> {
		const row = this.#db
			.query("SELECT value FROM source_cursors WHERE key = $key")
			.get({ key }) as {
			value: number;
		} | null;
		return row?.value;
	}

	async set(key: string, value: number): Promise<void> {
		this.#db
			.query(
				"INSERT INTO source_cursors (key, value) VALUES ($key, $value) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
			)
			.run({ key, value });
	}
}
