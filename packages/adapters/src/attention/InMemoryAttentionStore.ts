import type { AttentionItem, AttentionStorePort, ResolveResult } from "@casiagent/domain";

export class InMemoryAttentionStore implements AttentionStorePort {
	readonly #items = new Map<string, AttentionItem>();

	async raise(item: AttentionItem): Promise<boolean> {
		if (this.#items.has(item.id)) return false;
		this.#items.set(item.id, structuredClone(item));
		return true;
	}

	async listOpen(): Promise<readonly AttentionItem[]> {
		return [...this.#items.values()]
			.filter((i) => i.resolvedAt === undefined)
			.sort((a, b) => b.createdAt - a.createdAt)
			.map((i) => structuredClone(i));
	}

	async resolve(id: string, at: number): Promise<ResolveResult> {
		const item = this.#items.get(id);
		if (item === undefined) return "NOT_FOUND";
		if (item.resolvedAt !== undefined) return "ALREADY_RESOLVED";
		this.#items.set(id, { ...item, resolvedAt: at });
		return "RESOLVED";
	}

	/** All items, including resolved ones. For tests. */
	list(): readonly AttentionItem[] {
		return [...this.#items.values()].map((i) => structuredClone(i));
	}
}
