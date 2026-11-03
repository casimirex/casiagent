import type { Database } from "bun:sqlite";
import type { SessionId, Subscription, SubscriptionStorePort, ThreadKey } from "@superagent/domain";

interface SubscriptionRow {
	thread_key: string;
	worker_id: string;
	work_item_id: string;
	session_id: string;
	created_at: number;
}

const toSubscription = (r: SubscriptionRow): Subscription => ({
	threadKey: r.thread_key as ThreadKey,
	workerId: r.worker_id,
	workItemId: r.work_item_id,
	sessionId: r.session_id as SessionId,
	createdAt: r.created_at,
});

export class SqliteSubscriptionStore implements SubscriptionStorePort {
	readonly #db: Database;

	constructor(db: Database) {
		this.#db = db;
	}

	async subscribe(sub: Subscription): Promise<Subscription> {
		return this.#db.transaction(() => {
			// Insert, or refresh if this Worker already owns the thread; never steal it.
			this.#db
				.query(
					`INSERT INTO subscriptions (thread_key, worker_id, work_item_id, session_id, created_at)
					VALUES ($thread_key, $worker_id, $work_item_id, $session_id, $created_at)
					ON CONFLICT (thread_key) DO UPDATE SET
						work_item_id = excluded.work_item_id, session_id = excluded.session_id
					WHERE subscriptions.worker_id = excluded.worker_id`,
				)
				.run({
					thread_key: sub.threadKey,
					worker_id: sub.workerId,
					work_item_id: sub.workItemId,
					session_id: sub.sessionId,
					created_at: sub.createdAt,
				});
			const row = this.#db
				.query("SELECT * FROM subscriptions WHERE thread_key = $thread_key")
				.get({ thread_key: sub.threadKey }) as SubscriptionRow;
			return toSubscription(row);
		})();
	}

	async findByThread(threadKey: ThreadKey): Promise<Subscription | undefined> {
		const row = this.#db
			.query("SELECT * FROM subscriptions WHERE thread_key = $thread_key")
			.get({ thread_key: threadKey }) as SubscriptionRow | null;
		return row === null ? undefined : toSubscription(row);
	}

	async listByWorker(workerId: string): Promise<readonly Subscription[]> {
		const rows = this.#db
			.query("SELECT * FROM subscriptions WHERE worker_id = $worker_id ORDER BY created_at")
			.all({ worker_id: workerId }) as SubscriptionRow[];
		return rows.map(toSubscription);
	}

	async removeByWorker(workerId: string): Promise<number> {
		return this.#db
			.query("DELETE FROM subscriptions WHERE worker_id = $worker_id")
			.run({ worker_id: workerId }).changes;
	}
}
