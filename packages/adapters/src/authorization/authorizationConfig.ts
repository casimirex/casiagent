/**
 * Authorization config, as written in YAML or JSON:
 *
 *   allowed_users: ["alice", "bob"]
 *   allowed_sources: ["github:org/repo"]
 *   trusted_followup_authors: ["github-actions[bot]"]   # may post follow-ups only
 *   rules:                                               # first match wins
 *     - pattern: "fix bug|reproduce issue"
 *       action: allow                                    # allow | deny | observe_only | auto_act
 *       scope: explicit_request                          # explicit_request | inferred | new_work | follow_up | any
 *     - pattern: "CI failure"
 *       action: observe_only
 *   defaults:                                            # when no rule matches
 *     explicit_request: allow
 *     inferred: observe_only                             # may not be "allow"
 *     follow_up: allow
 */
export type RuleAction = "allow" | "deny" | "observe_only" | "auto_act";
/** `new_work` (the default) = explicit_request + inferred; it never matches follow-ups. */
export type RuleScope = "explicit_request" | "inferred" | "new_work" | "follow_up" | "any";
export type Default = "allow" | "deny" | "observe_only";

export interface AuthorizationRuleConfig {
	readonly pattern: string;
	readonly action: RuleAction;
	readonly scope: RuleScope;
}

export interface AuthorizationConfig {
	readonly allowed_users: readonly string[];
	readonly allowed_sources: readonly string[];
	readonly trusted_followup_authors: readonly string[];
	readonly rules: readonly AuthorizationRuleConfig[];
	readonly defaults: {
		readonly explicit_request: Default;
		readonly inferred: "deny" | "observe_only";
		readonly follow_up: Default;
	};
}

export class ConfigError extends Error {
	override readonly name = "ConfigError";
}

const ACTIONS: readonly RuleAction[] = ["allow", "deny", "observe_only", "auto_act"];
const SCOPES: readonly RuleScope[] = [
	"explicit_request",
	"inferred",
	"new_work",
	"follow_up",
	"any",
];
const DEFAULTS: readonly Default[] = ["allow", "deny", "observe_only"];

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringList(v: unknown, path: string, required: boolean): string[] {
	if (v === undefined && !required) return [];
	if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.trim() !== "")) {
		throw new ConfigError(`${path} must be a list of non-empty strings`);
	}
	return v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], path: string, fallback?: T): T {
	if (v === undefined && fallback !== undefined) return fallback;
	if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
		throw new ConfigError(`${path} must be one of ${allowed.join(", ")}, got ${JSON.stringify(v)}`);
	}
	return v as T;
}

/** Validate untrusted parsed config. Throws ConfigError naming the offending field. */
export function parseAuthorizationConfig(raw: unknown): AuthorizationConfig {
	if (!isRecord(raw)) throw new ConfigError("authorization config must be an object");
	const known = new Set([
		"allowed_users",
		"allowed_sources",
		"trusted_followup_authors",
		"rules",
		"defaults",
	]);
	for (const key of Object.keys(raw)) {
		if (!known.has(key)) throw new ConfigError(`unknown key "${key}" (typo?)`);
	}

	const rulesRaw = raw.rules ?? [];
	if (!Array.isArray(rulesRaw)) throw new ConfigError("rules must be a list");
	const rules = rulesRaw.map((r: unknown, i): AuthorizationRuleConfig => {
		const path = `rules[${i}]`;
		if (!isRecord(r)) throw new ConfigError(`${path} must be an object`);
		if (typeof r.pattern !== "string" || r.pattern === "") {
			throw new ConfigError(`${path}.pattern must be a non-empty string`);
		}
		try {
			new RegExp(r.pattern, "i");
		} catch {
			throw new ConfigError(`${path}.pattern is not a valid regular expression`);
		}
		return {
			pattern: r.pattern,
			action: oneOf(r.action, ACTIONS, `${path}.action`),
			scope: oneOf(r.scope, SCOPES, `${path}.scope`, "new_work"),
		};
	});

	const d = raw.defaults ?? {};
	if (!isRecord(d)) throw new ConfigError("defaults must be an object");
	return {
		allowed_users: stringList(raw.allowed_users, "allowed_users", true),
		allowed_sources: stringList(raw.allowed_sources, "allowed_sources", true),
		trusted_followup_authors: stringList(
			raw.trusted_followup_authors,
			"trusted_followup_authors",
			false,
		),
		rules,
		defaults: {
			explicit_request: oneOf(d.explicit_request, DEFAULTS, "defaults.explicit_request", "allow"),
			// Proactive work may never be allowed by default: only an auto_act rule can do that.
			inferred: oneOf(
				d.inferred,
				["deny", "observe_only"] as const,
				"defaults.inferred",
				"observe_only",
			),
			follow_up: oneOf(d.follow_up, DEFAULTS, "defaults.follow_up", "allow"),
		},
	};
}

/** Read and validate a .yaml/.yml/.json config file. */
export async function loadAuthorizationConfig(path: string): Promise<AuthorizationConfig> {
	const text = await Bun.file(path).text();
	let raw: unknown;
	try {
		raw = /\.ya?ml$/i.test(path) ? Bun.YAML.parse(text) : JSON.parse(text);
	} catch (error) {
		throw new ConfigError(
			`${path}: cannot parse (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	try {
		return parseAuthorizationConfig(raw);
	} catch (error) {
		if (error instanceof ConfigError) throw new ConfigError(`${path}: ${error.message}`);
		throw error;
	}
}
