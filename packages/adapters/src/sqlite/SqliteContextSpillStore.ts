import type { Database } from "bun:sqlite";
import type {
	ContextMessage,
	ContextSpillPort,
	SessionId,
	SpilledMessage,
} from "@casiagent/domain";
import { rankByKeywords } from "../context/keywordRecall";

/**
 * Spill log on SQLite. Recall loads the session's log and ranks it in process
 * (keyword match). Fine for per-session logs; move to FTS5 or vectors if they grow large.
 */
export class SqliteContextSpillStore implements ContextSpillPort {
	readonly #db: Database;

	constructor(db: Database) {
		this.#db = db;
	}

	async spill(sessionId: SessionId, messages: readonly ContextMessage[]): Promise<number> {
		return this.#db.transaction(() => {
			let seq = this.#count(sessionId);
			const insert = this.#db.query(
				"INSERT INTO context_spill (session_id, seq, role, content) VALUES ($session_id, $seq, $role, $content)",
			);
			for (const m of messages) {
				insert.run({ session_id: sessionId, seq, role: m.role, content: m.content });
				seq += 1;
			}
			return seq;
		})();
	}

	async recall(
		sessionId: SessionId,
		query: string,
		limit: number,
	): Promise<readonly SpilledMessage[]> {
		const rows = this.#db
			.query(
				"SELECT seq, role, content FROM context_spill WHERE session_id = $session_id ORDER BY seq",
			)
			.all({ session_id: sessionId }) as {
			seq: number;
			role: ContextMessage["role"];
			content: string;
		}[];
		const candidates = rows.map((r) => ({
			seq: r.seq,
			message: { role: r.role, content: r.content },
		}));
		return rankByKeywords(candidates, query, limit);
	}

	async count(sessionId: SessionId): Promise<number> {
		return this.#count(sessionId);
	}

	#count(sessionId: SessionId): number {
		const row = this.#db
			.query("SELECT COUNT(*) AS n FROM context_spill WHERE session_id = $session_id")
			.get({ session_id: sessionId }) as { n: number };
		return row.n;
	}
}
