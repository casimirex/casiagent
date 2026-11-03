import { DomainError } from "../DomainError";
import type { Trigger, TriggerPayload } from "../entities/Trigger";
import type { SourceId } from "../value-objects/SourceId";

export const FilterDecision = {
	/** Fails a rule: reject without asking the LLM. */
	DISCARD: "DISCARD",
	/** Matches a deterministic allow-rule: accept without asking the LLM. */
	PASS: "PASS",
	/** Rules are inconclusive: ask the LLM. */
	AMBIGUOUS: "AMBIGUOUS",
} as const;
export type FilterDecision = (typeof FilterDecision)[keyof typeof FilterDecision];

export interface FilterResult {
	readonly decision: FilterDecision;
	readonly reason: string;
}

/** `"any"` means no restriction. An empty list allows nothing. */
export type AllowList<T> = readonly T[] | "any";

/** Raw filter configuration, as it would come from a config file. */
export interface FilterRulesConfig {
	readonly allowedSourceIds: AllowList<SourceId>;
	readonly allowedUserIds: AllowList<string>;
	/** Regular-expression sources, matched case-insensitively against the payload's text. */
	readonly keywordPatterns: readonly string[];
	readonly ignoreBots: boolean;
}

/** Validated, compiled rules. Build with `createFilterRules`. */
export interface FilterRules {
	readonly allowedSourceIds: ReadonlySet<string> | "any";
	readonly allowedUserIds: ReadonlySet<string> | "any";
	readonly keywordPatterns: readonly RegExp[];
	readonly ignoreBots: boolean;
}

/**
 * Validates and compiles filter config. Throws DomainError on an invalid pattern, so
 * bad config fails at startup rather than on every event. Patterns are compiled without
 * the `g`/`y` flags, which would make `RegExp.test` stateful and `fastFilter` impure.
 */
export function createFilterRules(config: FilterRulesConfig): FilterRules {
	const keywordPatterns = config.keywordPatterns.map((source) => {
		try {
			return new RegExp(source, "i");
		} catch {
			throw new DomainError(`Invalid keyword pattern: ${JSON.stringify(source)}`);
		}
	});
	const toSet = <T extends string>(list: AllowList<T>) =>
		list === "any" ? "any" : new Set<string>(list);
	return {
		allowedSourceIds: toSet(config.allowedSourceIds),
		allowedUserIds: toSet(config.allowedUserIds),
		keywordPatterns,
		ignoreBots: config.ignoreBots,
	};
}

const MAX_TEXT_DEPTH = 5;

/** All string values in the payload, depth-first, joined by newlines. */
export function payloadText(payload: TriggerPayload): string {
	const parts: string[] = [];
	const visit = (value: unknown, depth: number): void => {
		if (typeof value === "string") {
			parts.push(value);
		} else if (depth < MAX_TEXT_DEPTH && typeof value === "object" && value !== null) {
			for (const child of Object.values(value)) visit(child, depth + 1);
		}
	};
	visit(payload, 0);
	return parts.join("\n");
}

/**
 * Stage 1 of trigger evaluation: a synchronous, side-effect-free check.
 *
 * Order: bot -> source -> user (each can DISCARD), then keywords (PASS), else AMBIGUOUS.
 * Restrictions run first, so a keyword match never lets a disallowed user or source through.
 */
export function fastFilter(trigger: Trigger, rules: FilterRules): FilterResult {
	if (rules.ignoreBots && trigger.authorIsBot) {
		return { decision: FilterDecision.DISCARD, reason: `author ${trigger.authorId} is a bot` };
	}
	if (rules.allowedSourceIds !== "any" && !rules.allowedSourceIds.has(trigger.sourceId)) {
		return {
			decision: FilterDecision.DISCARD,
			reason: `source ${trigger.sourceId} is not allowed`,
		};
	}
	if (rules.allowedUserIds !== "any" && !rules.allowedUserIds.has(trigger.authorId)) {
		return { decision: FilterDecision.DISCARD, reason: `user ${trigger.authorId} is not allowed` };
	}
	const text = payloadText(trigger.payload);
	const match = rules.keywordPatterns.find((pattern) => pattern.test(text));
	if (match !== undefined) {
		return { decision: FilterDecision.PASS, reason: `matched keyword pattern /${match.source}/` };
	}
	return { decision: FilterDecision.AMBIGUOUS, reason: "no deterministic rule matched" };
}
