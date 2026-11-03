import { describe, expect, test } from "bun:test";
import {
	createFilterRules,
	DomainError,
	FilterDecision,
	type FilterRulesConfig,
	fastFilter,
	payloadText,
	SourceId,
	type Trigger,
	TriggerStatus,
} from "@superagent/domain";

const REPO = SourceId.of("github:org/repo");
const OTHER = SourceId.of("github:org/other");

const BASE: FilterRulesConfig = {
	allowedSourceIds: [REPO],
	allowedUserIds: ["alice", "bob"],
	keywordPatterns: ["fix (the )?bug", "reproduce issue", "\\bdeploy\\b"],
	ignoreBots: true,
};

function trigger(overrides: Partial<Trigger> = {}): Trigger {
	return {
		id: "t1",
		sourceId: REPO,
		authorId: "alice",
		authorIsBot: false,
		explicitRequest: true,
		payload: { body: "hello" },
		timestamp: 0,
		status: TriggerStatus.PENDING,
		...overrides,
	};
}

const { DISCARD, PASS, AMBIGUOUS } = FilterDecision;
const deep = (depth: number, leaf: string): unknown =>
	depth === 0 ? leaf : { next: deep(depth - 1, leaf) };

/** [name, rule overrides, trigger overrides, expected decision] */
const CASES: ReadonlyArray<
	readonly [string, Partial<FilterRulesConfig>, Partial<Trigger>, FilterDecision]
> = [
	["allowed user + keyword", {}, { payload: { body: "please fix the bug" } }, PASS],
	[
		"second keyword",
		{},
		{ authorId: "bob", payload: { body: "can you reproduce issue #12" } },
		PASS,
	],
	["keywords are case-insensitive", {}, { payload: { body: "FIX BUG now" } }, PASS],
	["allowed user, no keyword", {}, { payload: { body: "what's for lunch?" } }, AMBIGUOUS],
	[
		"disallowed user, even with keyword",
		{},
		{ authorId: "carol", payload: { body: "fix the bug" } },
		DISCARD,
	],
	[
		"user ids match exactly (case-sensitive)",
		{},
		{ authorId: "Alice", payload: { body: "fix bug" } },
		DISCARD,
	],
	[
		"bot ignored, even with keyword",
		{},
		{ authorId: "alice", authorIsBot: true, payload: { body: "fix bug" } },
		DISCARD,
	],
	[
		"bot allowed when ignoreBots is off",
		{ ignoreBots: false },
		{ authorIsBot: true, payload: { body: "fix bug" } },
		PASS,
	],
	[
		"disallowed source, even with keyword",
		{},
		{ sourceId: OTHER, payload: { body: "fix bug" } },
		DISCARD,
	],
	[
		"any source",
		{ allowedSourceIds: "any" },
		{ sourceId: OTHER, payload: { body: "fix bug" } },
		PASS,
	],
	[
		"any user + keyword",
		{ allowedUserIds: "any" },
		{ authorId: "carol", payload: { body: "fix bug" } },
		PASS,
	],
	["any user, no keyword", { allowedUserIds: "any" }, { authorId: "carol" }, AMBIGUOUS],
	[
		"empty user list allows nobody",
		{ allowedUserIds: [] },
		{ payload: { body: "fix bug" } },
		DISCARD,
	],
	[
		"empty source list allows nothing",
		{ allowedSourceIds: [] },
		{ payload: { body: "fix bug" } },
		DISCARD,
	],
	[
		"no keyword patterns -> always ambiguous",
		{ keywordPatterns: [] },
		{ payload: { body: "fix bug" } },
		AMBIGUOUS,
	],
	["keyword in nested object", {}, { payload: { comment: { body: "fix the bug" } } }, PASS],
	["keyword in array", {}, { payload: { lines: ["first", "reproduce issue"] } }, PASS],
	["keyword only in a key name, not a value", {}, { payload: { "fix bug": 1 } }, AMBIGUOUS],
	[
		"non-string values are ignored",
		{},
		{ payload: { count: 42, ok: true, none: null } },
		AMBIGUOUS,
	],
	["keyword nested too deep is ignored", {}, { payload: { body: deep(6, "fix bug") } }, AMBIGUOUS],
	["keyword at max depth is found", {}, { payload: { body: deep(3, "fix bug") } }, PASS],
	["word boundary: 'redeploy' does not match", {}, { payload: { body: "redeploy it" } }, AMBIGUOUS],
	["word boundary: 'deploy' matches", {}, { payload: { body: "deploy staging" } }, PASS],
	["empty payload", {}, { payload: {} }, AMBIGUOUS],
];

describe("fastFilter decision table", () => {
	test.each(CASES)("%s", (_name, ruleOverrides, triggerOverrides, expected) => {
		const rules = createFilterRules({ ...BASE, ...ruleOverrides });
		expect(fastFilter(trigger(triggerOverrides), rules).decision).toBe(expected);
	});
});

describe("fastFilter properties", () => {
	const rules = createFilterRules(BASE);

	test("restrictions are checked in order bot -> source -> user, and reasons say why", () => {
		const t = trigger({ authorId: "carol", authorIsBot: true, sourceId: OTHER });
		expect(fastFilter(t, rules).reason).toContain("bot");
		expect(fastFilter({ ...t, authorIsBot: false }, rules).reason).toContain("source");
		expect(fastFilter({ ...t, authorIsBot: false, sourceId: REPO }, rules).reason).toContain(
			"user",
		);
	});

	test("PASS reason names the matching pattern", () => {
		expect(fastFilter(trigger({ payload: { body: "deploy" } }), rules).reason).toContain("deploy");
	});

	test("repeated calls give the same answer (patterns hold no state, even if config had /g)", () => {
		const t = trigger({ payload: { body: "fix bug" } });
		const results = Array.from({ length: 5 }, () => fastFilter(t, rules).decision);
		expect(new Set(results)).toEqual(new Set([PASS]));
	});

	test("does not mutate the trigger", () => {
		const t = trigger({ payload: { body: "fix bug", nested: { x: "y" } } });
		const snapshot = structuredClone(t);
		fastFilter(t, rules);
		expect(t).toEqual(snapshot);
	});
});

describe("createFilterRules", () => {
	test("rejects an invalid regular expression", () => {
		expect(() => createFilterRules({ ...BASE, keywordPatterns: ["fix (bug"] })).toThrow(
			DomainError,
		);
	});

	test("does not keep a reference to the config arrays", () => {
		const users = ["alice"];
		const rules = createFilterRules({ ...BASE, allowedUserIds: users });
		users.push("mallory");
		expect(fastFilter(trigger({ authorId: "mallory" }), rules).decision).toBe(DISCARD);
	});
});

describe("payloadText", () => {
	test("collects string values depth-first", () => {
		expect(payloadText({ a: "one", b: { c: "two", d: ["three"] }, e: 4 })).toBe("one\ntwo\nthree");
	});
});
