import type { SessionId } from "./SessionId";

/** One dispatch decision the Router made. */
export interface DispatchRecord {
	readonly triggerId: string;
	readonly workItemId: string;
	readonly workerId: string;
	readonly sessionId: SessionId;
}

/**
 * The Router's own record of dispatched work. Immutable: every change returns a new
 * instance. Router-private: it is never part of any Worker's context.
 */
export class RouterState {
	private readonly byTrigger: ReadonlyMap<string, DispatchRecord>;

	private constructor(byTrigger: ReadonlyMap<string, DispatchRecord>) {
		this.byTrigger = byTrigger;
	}

	static empty(): RouterState {
		return new RouterState(new Map());
	}

	withDispatched(records: readonly DispatchRecord[]): RouterState {
		if (records.length === 0) return this;
		const next = new Map(this.byTrigger);
		for (const record of records) next.set(record.triggerId, record);
		return new RouterState(next);
	}

	get size(): number {
		return this.byTrigger.size;
	}

	isDispatched(triggerId: string): boolean {
		return this.byTrigger.has(triggerId);
	}

	recordFor(triggerId: string): DispatchRecord | undefined {
		return this.byTrigger.get(triggerId);
	}

	records(): readonly DispatchRecord[] {
		return [...this.byTrigger.values()];
	}
}
