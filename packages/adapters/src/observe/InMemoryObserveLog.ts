import type { Observation, ObserveLogPort } from "@superagent/domain";

export class InMemoryObserveLog implements ObserveLogPort {
	readonly #entries = new Map<string, Observation>();

	async record(observation: Observation): Promise<void> {
		if (!this.#entries.has(observation.id))
			this.#entries.set(observation.id, structuredClone(observation));
	}

	async list(limit: number): Promise<readonly Observation[]> {
		return [...this.#entries.values()]
			.sort((a, b) => b.createdAt - a.createdAt)
			.slice(0, Math.max(0, limit))
			.map((o) => structuredClone(o));
	}
}
