import type { Database } from "bun:sqlite";
import type { Observation, ObserveLogPort } from "@casiagent/domain";

export class SqliteObserveLog implements ObserveLogPort {
	readonly #db: Database;

	constructor(db: Database) {
		this.#db = db;
	}

	async record(observation: Observation): Promise<void> {
		this.#db
			.query(
				"INSERT OR IGNORE INTO observe_log (id, created_at, data_json) VALUES ($id, $created_at, $data_json)",
			)
			.run({
				id: observation.id,
				created_at: observation.createdAt,
				data_json: JSON.stringify(observation),
			});
	}

	async list(limit: number): Promise<readonly Observation[]> {
		const rows = this.#db
			.query("SELECT data_json FROM observe_log ORDER BY created_at DESC, rowid DESC LIMIT $limit")
			.all({ limit: Math.max(0, limit) }) as { data_json: string }[];
		return rows.map((r) => JSON.parse(r.data_json) as Observation);
	}
}
