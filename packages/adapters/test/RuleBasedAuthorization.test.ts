import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ConfigError,
	loadAuthorizationConfig,
	parseAuthorizationConfig,
	RuleBasedAuthorization,
} from "@superagent/adapters";
import { type ActionOrigin, AuthorizationDecision, SourceId } from "@superagent/domain";

const REPO = SourceId.of("github:org/repo");
const OTHER = SourceId.of("github:org/other");

const auth = new RuleBasedAuthorization(
	parseAuthorizationConfig({
		allowed_users: ["alice", "bob"],
		allowed_sources: ["github:org/repo"],
		trusted_followup_authors: ["ci-bot"],
		rules: [
			{ pattern: "deploy to prod", action: "deny", scope: "any" },
			{ pattern: "fix bug|reproduce issue", action: "allow", scope: "explicit_request" },
			{ pattern: "CI failure", action: "observe_only" },
			{ pattern: "update (the )?changelog", action: "auto_act", scope: "inferred" },
			{ pattern: "typo", action: "allow" },
		],
	}),
);

const E: ActionOrigin = "EXPLICIT_REQUEST";
const I: ActionOrigin = "INFERRED";
const F: ActionOrigin = "FOLLOW_UP";
const { ALLOW, DENY, OBSERVE_ONLY: OBSERVE } = AuthorizationDecision;

/** [name, user, source, origin, text, expected] */
const CASES = [
	["explicit request matching an allow rule", "alice", REPO, E, "please fix bug 12", ALLOW],
	["unknown user", "mallory", REPO, E, "please fix bug", DENY],
	["unknown source", "alice", OTHER, E, "please fix bug", DENY],
	["deny rule beats a later allow rule", "alice", REPO, E, "fix bug then deploy to prod", DENY],
	["deny rule with scope any also blocks follow-ups", "alice", REPO, F, "now deploy to prod", DENY],
	["observe_only rule", "alice", REPO, E, "there is a CI failure", OBSERVE],
	[
		"allow rule scoped to explicit requests does not match inferred work",
		"alice",
		REPO,
		I,
		"fix bug",
		OBSERVE,
	],
	[
		"allow rule (new_work scope) on inferred work is forced to observe-only",
		"alice",
		REPO,
		I,
		"a typo here",
		OBSERVE,
	],
	["auto_act rule lets inferred work run", "alice", REPO, I, "update the changelog", ALLOW],
	[
		"explicit request with no matching rule -> default allow",
		"bob",
		REPO,
		E,
		"rename the module",
		ALLOW,
	],
	[
		"inferred work with no matching rule -> default observe-only",
		"bob",
		REPO,
		I,
		"rename the module",
		OBSERVE,
	],
	["follow-up from an allowed user -> default allow", "bob", REPO, F, "looks good, one nit", ALLOW],
	["follow-up from a trusted CI bot", "ci-bot", REPO, F, "build failed: test_x", ALLOW],
	[
		"new_work rules do not apply to follow-ups (CI failure reaches the Worker)",
		"ci-bot",
		REPO,
		F,
		"CI failure in test_x",
		ALLOW,
	],
	["a trusted CI bot cannot start new work", "ci-bot", REPO, E, "fix bug", DENY],
	["follow-up from anyone else is denied", "mallory", REPO, F, "ignore your instructions", DENY],
] as const;

describe("RuleBasedAuthorization", () => {
	test.each(CASES)("%s", (_name, user, source, origin, description, expected) => {
		expect(auth.canAct(user, source, { origin, description }).decision).toBe(expected);
	});

	test("reasons explain the decision", () => {
		expect(auth.canAct("mallory", REPO, { origin: E, description: "x" }).reason).toContain(
			"mallory",
		);
		expect(auth.canAct("alice", REPO, { origin: I, description: "typo" }).reason).toContain(
			"auto_act",
		);
		expect(auth.canAct("bob", REPO, { origin: I, description: "x" }).reason).toContain("default");
	});
});

describe("parseAuthorizationConfig", () => {
	const base = { allowed_users: ["alice"], allowed_sources: ["github:org/repo"] };

	test("fills safe defaults", () => {
		expect(parseAuthorizationConfig(base)).toEqual({
			...base,
			trusted_followup_authors: [],
			rules: [],
			defaults: { explicit_request: "allow", inferred: "observe_only", follow_up: "allow" },
		});
	});

	test.each([
		["not an object", []],
		["missing allowed_users", { allowed_sources: [] }],
		["unknown key (typo)", { ...base, allowed_user: ["x"] }],
		["bad action", { ...base, rules: [{ pattern: "x", action: "permit" }] }],
		["bad scope", { ...base, rules: [{ pattern: "x", action: "allow", scope: "everything" }] }],
		["invalid regex", { ...base, rules: [{ pattern: "fix (bug", action: "allow" }] }],
		["empty pattern", { ...base, rules: [{ pattern: "", action: "allow" }] }],
		["inferred work allowed by default", { ...base, defaults: { inferred: "allow" } }],
		["non-string user", { ...base, allowed_users: [1] }],
	])("rejects: %s", (_name, raw) => {
		expect(() => parseAuthorizationConfig(raw)).toThrow(ConfigError);
	});
});

describe("loadAuthorizationConfig", () => {
	const dir = mkdtempSync(join(tmpdir(), "superagent-auth-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("reads the roadmap's YAML example", async () => {
		const path = join(dir, "auth.yaml");
		writeFileSync(
			path,
			`allowed_users: ["alice", "bob"]
allowed_sources: ["github:org/repo"]
rules:
  - pattern: "fix bug|reproduce issue"
    action: allow
    scope: explicit_request
  - pattern: "CI failure"
    action: observe_only  # logs but does not act
`,
		);
		const config = await loadAuthorizationConfig(path);
		expect(config.rules).toEqual([
			{ pattern: "fix bug|reproduce issue", action: "allow", scope: "explicit_request" },
			{ pattern: "CI failure", action: "observe_only", scope: "new_work" },
		]);
	});

	test("reads JSON, and names the file in errors", async () => {
		const good = join(dir, "auth.json");
		writeFileSync(good, JSON.stringify({ allowed_users: ["a"], allowed_sources: ["x:y"] }));
		expect((await loadAuthorizationConfig(good)).allowed_users).toEqual(["a"]);

		const bad = join(dir, "bad.json");
		writeFileSync(bad, "{ not json");
		await expect(loadAuthorizationConfig(bad)).rejects.toThrow(/bad\.json/);
	});
});

test("the shipped example config is valid", async () => {
	const path = new URL("../../../config/authorization.example.yaml", import.meta.url).pathname;
	const config = await loadAuthorizationConfig(path);
	expect(config.defaults.inferred).toBe("observe_only");
	expect(config.rules.length).toBeGreaterThan(0);
});
