import type {
	ContextMessage,
	ContextSpillPort,
	SessionId,
	SpilledMessage,
} from "@casiagent/domain";
import { rankByKeywords } from "./keywordRecall";

export class InMemoryContextSpillStore implements ContextSpillPort {
	readonly #logs = new Map<string, SpilledMessage[]>();

	async spill(sessionId: SessionId, messages: readonly ContextMessage[]): Promise<number> {
		const log = this.#logs.get(sessionId) ?? [];
		for (const message of messages)
			log.push({ seq: log.length, message: structuredClone(message) });
		this.#logs.set(sessionId, log);
		return log.length;
	}

	async recall(
		sessionId: SessionId,
		query: string,
		limit: number,
	): Promise<readonly SpilledMessage[]> {
		return structuredClone(rankByKeywords(this.#logs.get(sessionId) ?? [], query, limit));
	}

	async count(sessionId: SessionId): Promise<number> {
		return this.#logs.get(sessionId)?.length ?? 0;
	}
}
