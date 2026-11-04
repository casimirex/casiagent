import type { Database } from "bun:sqlite";
import {
	type Session,
	type SessionId,
	SessionStatus,
	type SessionStorePort,
	type SourceEvent,
	type Trigger,
	TriggerStatus,
	type WorkItem,
	type WorkItemStatus,
} from "@casiagent/domain";

interface SessionRow {
	id: string;
	worker_id: string;
	work_item_id: string;
	status: string;
	context_json: string;
	created_at: number;
	updated_at: number;
	last_heartbeat_at: number;
	restart_count: number;
}

function toSession(row: SessionRow): Session {
	return {
		id: row.id as SessionId,
		workerId: row.worker_id,
		workItemId: row.work_item_id,
		status: row.status as SessionStatus,
		context: JSON.parse(row.context_json),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastHeartbeatAt: row.last_heartbeat_at,
		restartCount: row.restart_count,
	};
}

function sessionParams(s: Session) {
	return {
		id: s.id,
		worker_id: s.workerId,
		work_item_id: s.workItemId,
		status: s.status,
		context_json: JSON.stringify(s.context),
		created_at: s.createdAt,
		updated_at: s.updatedAt,
		last_heartbeat_at: s.lastHeartbeatAt,
		restart_count: s.restartCount,
	};
}

const parse = <T>(row: { data_json: string } | null): T | undefined =>
	row === null ? undefined : (JSON.parse(row.data_json) as T);

/**
 * SessionStorePort on SQLite (bun:sqlite). Entities are stored as JSON plus the columns
 * needed for querying. Every compare-and-set is a single conditional UPDATE, and
 * multi-step operations run in a transaction, so they are atomic across processes too.
 */
export class SqliteSessionStore implements SessionStorePort {
	readonly #db: Database;

	constructor(db: Database) {
		this.#db = db;
	}

	async save(session: Session): Promise<void> {
		this.#upsertSession(session);
	}

	#upsertSession(session: Session): void {
		this.#db
			.query(
				`INSERT INTO sessions (id, worker_id, work_item_id, status, context_json, created_at,
					updated_at, last_heartbeat_at, restart_count)
				VALUES ($id, $worker_id, $work_item_id, $status, $context_json, $created_at,
					$updated_at, $last_heartbeat_at, $restart_count)
				ON CONFLICT (id) DO UPDATE SET
					worker_id = excluded.worker_id,
					work_item_id = excluded.work_item_id,
					status = excluded.status,
					context_json = excluded.context_json,
					created_at = excluded.created_at,
					updated_at = excluded.updated_at,
					last_heartbeat_at = MAX(sessions.last_heartbeat_at, excluded.last_heartbeat_at),
					restart_count = MAX(sessions.restart_count, excluded.restart_count)`,
			)
			.run(sessionParams(session));
	}

	async load(id: SessionId): Promise<Session | undefined> {
		const row = this.#db
			.query("SELECT * FROM sessions WHERE id = $id")
			.get({ id }) as SessionRow | null;
		return row === null ? undefined : toSession(row);
	}

	async listActive(): Promise<readonly Session[]> {
		const rows = this.#db
			.query("SELECT * FROM sessions WHERE status IN ($active, $stalled) ORDER BY created_at")
			.all({ active: SessionStatus.ACTIVE, stalled: SessionStatus.STALLED }) as SessionRow[];
		return rows.map(toSession);
	}

	async listSessionsByStatus(status: SessionStatus): Promise<readonly Session[]> {
		const rows = this.#db
			.query("SELECT * FROM sessions WHERE status = $status ORDER BY updated_at, rowid")
			.all({ status }) as SessionRow[];
		return rows.map(toSession);
	}

	async recordHeartbeat(id: SessionId, at: number): Promise<boolean> {
		const { changes } = this.#db
			.query("UPDATE sessions SET last_heartbeat_at = MAX(last_heartbeat_at, $at) WHERE id = $id")
			.run({ id, at });
		return changes > 0;
	}

	async createTrigger(trigger: Trigger): Promise<boolean> {
		const { changes } = this.#db
			.query(
				`INSERT OR IGNORE INTO triggers (id, source_id, status, timestamp, data_json)
				VALUES ($id, $source_id, $status, $timestamp, $data_json)`,
			)
			.run({
				id: trigger.id,
				source_id: trigger.sourceId,
				status: trigger.status,
				timestamp: trigger.timestamp,
				data_json: JSON.stringify(trigger),
			});
		return changes > 0;
	}

	async loadTrigger(id: string): Promise<Trigger | undefined> {
		return parse<Trigger>(
			this.#db.query("SELECT data_json FROM triggers WHERE id = $id").get({ id }) as {
				data_json: string;
			} | null,
		);
	}

	async listTriggersByStatus(status: TriggerStatus): Promise<readonly Trigger[]> {
		const rows = this.#db
			.query("SELECT data_json FROM triggers WHERE status = $status ORDER BY timestamp, rowid")
			.all({ status }) as { data_json: string }[];
		return rows.map((r) => JSON.parse(r.data_json) as Trigger);
	}

	async compareAndSetTrigger(
		expectedStatus: TriggerStatus,
		next: Trigger,
	): Promise<Trigger | undefined> {
		return this.#casTrigger(expectedStatus, next) ? next : undefined;
	}

	#casTrigger(expectedStatus: TriggerStatus, next: Trigger): boolean {
		const { changes } = this.#db
			.query(
				`UPDATE triggers SET status = $status, data_json = $data_json
				WHERE id = $id AND status = $expected`,
			)
			.run({
				id: next.id,
				status: next.status,
				data_json: JSON.stringify(next),
				expected: expectedStatus,
			});
		return changes > 0;
	}

	async claimTriggerForWork(consumed: Trigger, item: WorkItem, session: Session): Promise<boolean> {
		return this.#db.transaction(() => {
			if (!this.#casTrigger(TriggerStatus.ACCEPTED, consumed)) return false;
			this.#db
				.query(
					`INSERT INTO work_items (id, trigger_id, status, data_json)
					VALUES ($id, $trigger_id, $status, $data_json)`,
				)
				.run(this.#workItemParams(item));
			this.#upsertSession(session);
			return true;
		})();
	}

	#workItemParams(item: WorkItem) {
		return {
			id: item.id,
			trigger_id: item.triggerId,
			status: item.status,
			data_json: JSON.stringify(item),
		};
	}

	async saveWorkItem(item: WorkItem): Promise<void> {
		this.#db
			.query(
				`INSERT INTO work_items (id, trigger_id, status, data_json)
				VALUES ($id, $trigger_id, $status, $data_json)
				ON CONFLICT (id) DO UPDATE SET
					trigger_id = excluded.trigger_id, status = excluded.status, data_json = excluded.data_json`,
			)
			.run(this.#workItemParams(item));
	}

	async compareAndSetWorkItem(
		expectedStatus: WorkItemStatus,
		next: WorkItem,
	): Promise<WorkItem | undefined> {
		const { changes } = this.#db
			.query(
				`UPDATE work_items SET status = $status, data_json = $data_json
				WHERE id = $id AND status = $expected`,
			)
			.run({
				id: next.id,
				status: next.status,
				data_json: JSON.stringify(next),
				expected: expectedStatus,
			});
		return changes > 0 ? next : undefined;
	}

	async loadWorkItem(id: string): Promise<WorkItem | undefined> {
		return parse<WorkItem>(
			this.#db.query("SELECT data_json FROM work_items WHERE id = $id").get({ id }) as {
				data_json: string;
			} | null,
		);
	}

	async countWorkItemsByStatus(statuses: readonly WorkItemStatus[]): Promise<number> {
		if (statuses.length === 0) return 0;
		const placeholders = statuses.map(() => "?").join(", ");
		const row = this.#db
			.query(`SELECT COUNT(*) AS n FROM work_items WHERE status IN (${placeholders})`)
			.get(...statuses) as { n: number };
		return row.n;
	}

	async enqueueFollowUp(sessionId: SessionId, event: SourceEvent): Promise<boolean> {
		const { changes } = this.#db
			.query(
				`INSERT OR IGNORE INTO follow_ups (session_id, event_id, event_json)
				VALUES ($session_id, $event_id, $event_json)`,
			)
			.run({ session_id: sessionId, event_id: event.id, event_json: JSON.stringify(event) });
		return changes > 0;
	}

	async drainFollowUps(sessionId: SessionId): Promise<readonly SourceEvent[]> {
		return this.#db.transaction(() => {
			const rows = this.#db
				.query(
					"SELECT event_json FROM follow_ups WHERE session_id = $session_id AND drained = 0 ORDER BY id",
				)
				.all({ session_id: sessionId }) as { event_json: string }[];
			this.#db
				.query("UPDATE follow_ups SET drained = 1 WHERE session_id = $session_id AND drained = 0")
				.run({ session_id: sessionId });
			return rows.map((r) => JSON.parse(r.event_json) as SourceEvent);
		})();
	}

	async countFollowUps(sessionId: SessionId): Promise<number> {
		const row = this.#db
			.query("SELECT COUNT(*) AS n FROM follow_ups WHERE session_id = $session_id AND drained = 0")
			.get({ session_id: sessionId }) as { n: number };
		return row.n;
	}
}
