/** Remembers how far each poller has read, so a restart resumes instead of replaying or skipping. */
export interface CursorStore {
	get(key: string): Promise<number | undefined>;
	set(key: string, value: number): Promise<void>;
}

export class InMemoryCursorStore implements CursorStore {
	readonly #values = new Map<string, number>();
	async get(key: string): Promise<number | undefined> {
		return this.#values.get(key);
	}
	async set(key: string, value: number): Promise<void> {
		this.#values.set(key, value);
	}
}
