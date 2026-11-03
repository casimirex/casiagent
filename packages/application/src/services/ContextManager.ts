import type {
	ContextMessage,
	ContextSpillPort,
	Session,
	SessionId,
	SpilledMessage,
	WorkerContext,
} from "@superagent/domain";

/** Estimates how many model tokens a text uses. */
export type TokenEstimator = (text: string) => number;

/** About 4 characters per token for English text and code. Swap in a real tokenizer if needed. */
export const approximateTokens: TokenEstimator = (text) => Math.ceil(text.length / 4);

export interface ContextManagerDeps {
	readonly spill: ContextSpillPort;
	/** Hard ceiling for the working context sent to the LLM. */
	readonly budgetTokens: number;
	/** Share of the budget reserved for recalled messages. Default 0.25. */
	readonly recallShare?: number;
	readonly estimate?: TokenEstimator;
}

export interface WorkingContext {
	/** The session with its inline context compacted. Persist this. */
	readonly session: Session;
	/** What to send to the LLM: the inline context plus recalled messages. Not persisted. */
	readonly context: WorkerContext;
}

const POINTER_TAG = "[context-spill]";
const RECALL_TAG = "[recalled-context]";
const TRUNCATION_NOTE = "\n…[truncated; full text moved to spilled context]";
/** Per-message overhead for role and formatting. */
const MESSAGE_OVERHEAD = 4;
const RECALL_LIMIT = 20;

const isPointer = (m: ContextMessage) => m.role === "system" && m.content.startsWith(POINTER_TAG);

function pointerMessage(total: number): ContextMessage {
	return {
		role: "system",
		content: `${POINTER_TAG} ${total} earlier message(s) of this task were moved out of the context window. Relevant ones are recalled below when needed.`,
	};
}

/**
 * Keeps a Worker's context within a token budget.
 *
 * Inline context = the first message (the task itself, never spilled) + a pointer to the
 * spill log + the newest messages that fit. Older messages go to ContextSpillPort. Before
 * each LLM call, spilled messages relevant to the latest user message are recalled into
 * the working context (chain-of-recall), within the reserved recall share.
 *
 * Guarantee: the working context fits `budgetTokens`, unless the task message alone
 * exceeds the inline budget (it is never dropped or truncated).
 */
export class ContextManager {
	readonly #spill: ContextSpillPort;
	readonly #estimate: TokenEstimator;
	readonly #budget: number;
	readonly #recallBudget: number;

	constructor(deps: ContextManagerDeps) {
		this.#spill = deps.spill;
		this.#estimate = deps.estimate ?? approximateTokens;
		this.#budget = deps.budgetTokens;
		this.#recallBudget = Math.floor(deps.budgetTokens * (deps.recallShare ?? 0.25));
	}

	/** Token cost of messages, as counted against the budget. */
	tokens(messages: readonly ContextMessage[]): number {
		return messages.reduce((sum, m) => sum + this.#estimate(m.content) + MESSAGE_OVERHEAD, 0);
	}

	/** Spill the oldest messages until the inline context fits. Returns the updated session. */
	async compact(session: Session): Promise<Session> {
		const all = session.context.messages;
		const hadPointer = all.some(isPointer);
		const messages = all.filter((m) => !isPointer(m));
		const [task, ...rest] = messages;
		if (task === undefined) return session;

		const inlineBudget = this.#budget - this.#recallBudget;
		if (!hadPointer && this.tokens(messages) <= inlineBudget) return session;

		// Reserve room for the pointer using a generous count, so the result always fits.
		const available = inlineBudget - this.tokens([task, pointerMessage(Number.MAX_SAFE_INTEGER)]);
		const kept: ContextMessage[] = [];
		let used = 0;
		let firstSpilled = rest.length;
		for (let i = rest.length - 1; i >= 0; i--) {
			const message = rest[i] as ContextMessage;
			const cost = this.tokens([message]);
			if (used + cost <= available) {
				kept.unshift(message);
				used += cost;
				firstSpilled = i;
				continue;
			}
			if (kept.length === 0) {
				// The newest message alone is too big: keep a truncated copy, spill the full one.
				kept.unshift(this.#truncate(message, available));
				const toSpill = rest.slice(0, i + 1);
				const total = await this.#spill.spill(session.id, toSpill);
				return this.#withContext(session, [task, pointerMessage(total), ...kept]);
			}
			break;
		}

		const toSpill = rest.slice(0, firstSpilled);
		if (toSpill.length === 0 && !hadPointer) return session;
		const total =
			toSpill.length > 0
				? await this.#spill.spill(session.id, toSpill)
				: await this.#spill.count(session.id);
		return this.#withContext(session, [task, pointerMessage(total), ...kept]);
	}

	/** Compact, then add recalled messages relevant to the latest user message. */
	async getWorkingContext(session: Session): Promise<WorkingContext> {
		const compacted = await this.compact(session);
		const messages = compacted.context.messages;
		const pointerAt = messages.findIndex(isPointer);
		if (pointerAt === -1) return { session: compacted, context: compacted.context };

		const query = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
		const recalled = await this.recall(compacted.id, query, RECALL_LIMIT);
		const recallMessage = this.#recallMessage(recalled);
		if (recallMessage === undefined) return { session: compacted, context: compacted.context };

		const withRecall = [
			...messages.slice(0, pointerAt + 1),
			recallMessage,
			...messages.slice(pointerAt + 1),
		];
		return { session: compacted, context: { messages: withRecall } };
	}

	recall(sessionId: SessionId, query: string, limit: number): Promise<readonly SpilledMessage[]> {
		return this.#spill.recall(sessionId, query, limit);
	}

	#recallMessage(recalled: readonly SpilledMessage[]): ContextMessage | undefined {
		const header = `${RECALL_TAG} Earlier messages relevant to the latest request:`;
		const parts: string[] = [];
		for (const r of recalled) {
			const part = `\n\n(${r.message.role}, #${r.seq})\n${r.message.content}`;
			const candidate = { role: "system" as const, content: header + parts.join("") + part };
			if (this.tokens([candidate]) > this.#recallBudget) break;
			parts.push(part);
		}
		return parts.length === 0 ? undefined : { role: "system", content: header + parts.join("") };
	}

	#truncate(message: ContextMessage, budgetTokens: number): ContextMessage {
		const room = budgetTokens - MESSAGE_OVERHEAD - this.#estimate(TRUNCATION_NOTE);
		let content = message.content;
		// Shrink until it fits; estimators need not be linear, so check rather than compute.
		while (content.length > 0 && this.#estimate(content) > room) {
			content = content.slice(0, Math.floor(content.length * 0.9));
		}
		return { role: message.role, content: content + TRUNCATION_NOTE };
	}

	#withContext(session: Session, messages: ContextMessage[]): Session {
		return { ...session, context: { messages } };
	}
}
