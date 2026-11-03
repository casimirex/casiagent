import type { AttentionItem, AttentionSinkPort } from "@superagent/domain";

/** Process-local attention items. Phase 5 adds a persistent store and the panel that reads it. */
export class InMemoryAttentionStore implements AttentionSinkPort {
	readonly #items = new Map<string, AttentionItem>();

	async raise(item: AttentionItem): Promise<boolean> {
		if (this.#items.has(item.id)) return false;
		this.#items.set(item.id, structuredClone(item));
		return true;
	}

	list(): readonly AttentionItem[] {
		return [...this.#items.values()].map((i) => structuredClone(i));
	}
}
