import {
	ActionOrigin,
	AuthorizationDecision,
	type AuthorizationPort,
	type ClockPort,
	FilterDecision,
	type FilterRules,
	fastFilter,
	isTriggerPriority,
	type LlmPort,
	type ObserveLogPort,
	payloadText,
	type SessionStorePort,
	type Trigger,
	type TriggerDecision,
	TriggerPriority,
	TriggerStatus,
	type TriggerVerdict,
	transitionTrigger,
	WorkItemStatus,
} from "@superagent/domain";
import {
	EVALUATE_TRIGGER_PROMPT_VERSION,
	renderEvaluateTriggerPrompt,
} from "../prompts/evaluateTrigger";

export interface EvaluateTriggerDeps {
	readonly store: SessionStorePort;
	/** Checked first, before any filtering. */
	readonly authorization: AuthorizationPort;
	readonly observeLog: ObserveLogPort;
	readonly clock: ClockPort;
	readonly llm: LlmPort;
	readonly rules: FilterRules;
	/** The team's written authorization rules, given to the LLM verbatim. */
	readonly authorizationRules: string;
}

export type EvaluationOutcome =
	| {
			/** OBSERVED: authorized for observation only; logged, not acted on. */
			readonly status: "ACCEPTED" | "REJECTED" | "OBSERVED";
			readonly trigger: Trigger;
			readonly decision: TriggerDecision;
	  }
	/** Not PENDING (already handled, or claimed by a concurrent evaluation). Nothing changed. */
	| { readonly status: "SKIPPED"; readonly reason: string }
	/** The LLM call failed or returned an invalid verdict. The Trigger is back in PENDING. */
	| { readonly status: "ERROR"; readonly trigger: Trigger; readonly error: string };

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The LLM's answer crosses a trust boundary; check its shape before acting on it. */
function validateVerdict(verdict: TriggerVerdict): string | undefined {
	const v = verdict as Partial<Record<keyof TriggerVerdict, unknown>> | null;
	if (typeof v !== "object" || v === null) return "verdict is not an object";
	if (typeof v.accepted !== "boolean") return "verdict.accepted is not a boolean";
	if (typeof v.reason !== "string" || v.reason.trim() === "") return "verdict.reason is missing";
	if (!isTriggerPriority(v.priority)) return `verdict.priority is invalid: ${String(v.priority)}`;
	return undefined;
}

/** What the model sees of a Trigger: the event content, never internal ids or state. */
function serializeForModel(trigger: Trigger): string {
	return JSON.stringify(
		{
			source: trigger.sourceId,
			...(trigger.threadId === undefined ? {} : { thread: trigger.threadId }),
			author: trigger.authorId,
			authorIsBot: trigger.authorIsBot,
			payload: trigger.payload,
		},
		null,
		2,
	);
}

const MAX_INTENDED_ACTION_CHARS = 500;

/**
 * Evaluation of a PENDING Trigger:
 *   0. Authorization (Phase 5): DENY -> REJECTED; OBSERVE_ONLY -> OBSERVED plus an
 *      observe-log entry saying what would have been done. No WorkItem is ever created
 *      for these. Proactive (inferred) work is observe-only unless a rule says auto_act.
 *   1. `fastFilter` (domain, synchronous): DISCARD -> REJECTED, PASS -> ACCEPTED.
 *   2. AMBIGUOUS only: claim the Trigger (PENDING -> EVALUATING), ask the LLM, and
 *      record its verdict. On LLM failure the Trigger returns to PENDING for retry.
 *
 * Every status change is a compare-and-set, so concurrent evaluations of the same
 * Trigger never both act; the loser gets SKIPPED.
 */
export class EvaluateTriggerUseCase {
	readonly #store: SessionStorePort;
	readonly #authorization: AuthorizationPort;
	readonly #observeLog: ObserveLogPort;
	readonly #clock: ClockPort;
	readonly #llm: LlmPort;
	readonly #rules: FilterRules;
	readonly #authorizationRules: string;

	constructor(deps: EvaluateTriggerDeps) {
		this.#store = deps.store;
		this.#authorization = deps.authorization;
		this.#observeLog = deps.observeLog;
		this.#clock = deps.clock;
		this.#llm = deps.llm;
		this.#rules = deps.rules;
		this.#authorizationRules = deps.authorizationRules;
	}

	async execute(triggerId: string): Promise<EvaluationOutcome> {
		const trigger = await this.#store.loadTrigger(triggerId);
		if (trigger === undefined)
			return { status: "SKIPPED", reason: `Trigger ${triggerId} not found` };
		if (trigger.status !== TriggerStatus.PENDING) {
			return {
				status: "SKIPPED",
				reason: `Trigger ${triggerId} is ${trigger.status}, not PENDING`,
			};
		}

		const description = payloadText(trigger.payload);
		const origin = trigger.explicitRequest ? ActionOrigin.EXPLICIT_REQUEST : ActionOrigin.INFERRED;
		const auth = this.#authorization.canAct(trigger.authorId, trigger.sourceId, {
			origin,
			description,
		});
		if (auth.decision === AuthorizationDecision.DENY) {
			return this.#decide(trigger, TriggerStatus.PENDING, TriggerStatus.REJECTED, {
				stage: "AUTHORIZATION",
				reason: auth.reason,
				priority: TriggerPriority.NORMAL,
			});
		}
		if (auth.decision === AuthorizationDecision.OBSERVE_ONLY) {
			// Log first (idempotent by id) so a crash cannot leave an OBSERVED trigger unlogged.
			const kind = origin === ActionOrigin.INFERRED ? "inferred" : "explicit";
			await this.#observeLog.record({
				id: `observe:${trigger.id}`,
				triggerId: trigger.id,
				sourceId: trigger.sourceId,
				...(trigger.threadId === undefined ? {} : { threadId: trigger.threadId }),
				authorId: trigger.authorId,
				intendedAction: `Act on ${kind} request: ${description.slice(0, MAX_INTENDED_ACTION_CHARS)}`,
				rationale: auth.reason,
				createdAt: this.#clock.now(),
			});
			return this.#decide(trigger, TriggerStatus.PENDING, TriggerStatus.OBSERVED, {
				stage: "AUTHORIZATION",
				reason: auth.reason,
				priority: TriggerPriority.NORMAL,
			});
		}

		const filter = fastFilter(trigger, this.#rules);
		switch (filter.decision) {
			case FilterDecision.DISCARD:
				return this.#decide(trigger, TriggerStatus.PENDING, TriggerStatus.REJECTED, {
					stage: "FAST_FILTER",
					reason: filter.reason,
					priority: TriggerPriority.NORMAL,
				});
			case FilterDecision.PASS:
				return this.#decide(trigger, TriggerStatus.PENDING, TriggerStatus.ACCEPTED, {
					stage: "FAST_FILTER",
					reason: filter.reason,
					priority: TriggerPriority.NORMAL,
				});
			case FilterDecision.AMBIGUOUS:
				return this.#evaluateWithLlm(trigger);
		}
	}

	async #evaluateWithLlm(pending: Trigger): Promise<EvaluationOutcome> {
		const evaluating = await this.#store.compareAndSetTrigger(
			TriggerStatus.PENDING,
			transitionTrigger(pending, TriggerStatus.EVALUATING),
		);
		if (evaluating === undefined) {
			return { status: "SKIPPED", reason: `Trigger ${pending.id} was claimed concurrently` };
		}

		let verdict: TriggerVerdict;
		try {
			const queueDepth = await this.#queueDepth();
			const prompt = renderEvaluateTriggerPrompt({
				trigger: serializeForModel(evaluating),
				authorizationRules: this.#authorizationRules,
				queueDepth,
			});
			verdict = await this.#llm.evaluateTrigger({
				triggerId: evaluating.id,
				promptVersion: EVALUATE_TRIGGER_PROMPT_VERSION,
				prompt,
			});
			const invalid = validateVerdict(verdict);
			if (invalid !== undefined) throw new Error(`Invalid LLM verdict: ${invalid}`);
		} catch (error) {
			const reverted = await this.#store.compareAndSetTrigger(
				TriggerStatus.EVALUATING,
				transitionTrigger(evaluating, TriggerStatus.PENDING),
			);
			return { status: "ERROR", trigger: reverted ?? evaluating, error: messageOf(error) };
		}

		const verdictStatus = verdict.accepted ? TriggerStatus.ACCEPTED : TriggerStatus.REJECTED;
		return this.#decide(evaluating, TriggerStatus.EVALUATING, verdictStatus, {
			stage: "LLM",
			reason: verdict.reason,
			priority: verdict.priority,
		});
	}

	async #decide(
		trigger: Trigger,
		expectedStatus: TriggerStatus,
		status:
			| typeof TriggerStatus.ACCEPTED
			| typeof TriggerStatus.REJECTED
			| typeof TriggerStatus.OBSERVED,
		decision: TriggerDecision,
	): Promise<EvaluationOutcome> {
		const stored = await this.#store.compareAndSetTrigger(
			expectedStatus,
			transitionTrigger(trigger, status, decision),
		);
		if (stored === undefined) {
			return { status: "SKIPPED", reason: `Trigger ${trigger.id} changed concurrently` };
		}
		return { status, trigger: stored, decision };
	}

	/** Work not yet finished: accepted Triggers awaiting dispatch plus open WorkItems. */
	async #queueDepth(): Promise<number> {
		const [accepted, open] = await Promise.all([
			this.#store.listTriggersByStatus(TriggerStatus.ACCEPTED),
			this.#store.countWorkItemsByStatus([WorkItemStatus.PENDING, WorkItemStatus.RUNNING]),
		]);
		return accepted.length + open;
	}
}
