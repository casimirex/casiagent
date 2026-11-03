import type { Database } from "bun:sqlite";
import type { AttentionItem, AttentionStorePort, ResolveResult } from "@superagent/domain";

export class SqliteAttentionStore implements AttentionStorePort {
	readonly #db: Database;

	constructor(db: Database) {
		this.#db = db;
	}

	async raise(item: AttentionItem): Promise<boolean> {
		const { changes } = this.#db
			.query(
				`INSERT OR IGNORE INTO attention_items (id, created_at, resolved_at, data_json)
				VALUES ($id, $created_at, NULL, $data_json)`,
			)
			.run({ id: item.id, created_at: item.createdAt, data_json: JSON.stringify(item) });
		return changes > 0;
	}

	async listOpen(): Promise<readonly AttentionItem[]> {
		const rows = this.#db
			.query(
				"SELECT data_json FROM attention_items WHERE resolved_at IS NULL ORDER BY created_at DESC, rowid DESC",
			)
			.all() as { data_json: string }[];
		return rows.map((r) => JSON.parse(r.data_json) as AttentionItem);
	}

	async resolve(id: string, at: number): Promise<ResolveResult> {
		return this.#db.transaction((): ResolveResult => {
			const row = this.#db
				.query("SELECT resolved_at, data_json FROM attention_items WHERE id = $id")
				.get({ id }) as { resolved_at: number | null; data_json: string } | null;
			if (row === null) return "NOT_FOUND";
			if (row.resolved_at !== null) return "ALREADY_RESOLVED";
			const item: AttentionItem = {
				...(JSON.parse(row.data_json) as AttentionItem),
				resolvedAt: at,
			};
			this.#db
				.query(
					"UPDATE attention_items SET resolved_at = $at, data_json = $data_json WHERE id = $id",
				)
				.run({ id, at, data_json: JSON.stringify(item) });
			return "RESOLVED";
		})();
	}
}
