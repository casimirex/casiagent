import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ConfigFileError,
	loadConfigFile,
	normalizeAnthropicEnv,
	parseConfig,
	requireEnv,
} from "../src/config";
import { buildApp } from "../src/main";

const dir = mkdtempSync(join(tmpdir(), "casiagent-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const EXAMPLE = new URL("../../../config/casiagent.example.yaml", import.meta.url).pathname;
const AUTH_EXAMPLE = new URL("../../../config/authorization.example.yaml", import.meta.url)
	.pathname;

const minimal = {
	database: "./db.sqlite",
	authorization_file: "./authorization.yaml",
	filter: {},
	github: { owner: "org", repo: "repo", bot_login: "casiagent-bot" },
	workspace: { repo_path: "./clone", worktrees_dir: "./worktrees" },
};

describe("config", () => {
	test("the shipped example is valid", async () => {
		const config = await loadConfigFile(EXAMPLE);
		expect(config.github.token_env).toBe("GITHUB_TOKEN");
		expect(config.llm.model).toBe("claude-opus-5-5");
		expect(config.panel.hostname).toBe("127.0.0.1");
	});

	test("fills defaults and resolves relative paths against the config file's directory", () => {
		const config = parseConfig(minimal, "/etc/casiagent");
		expect(config.database).toBe("/etc/casiagent/db.sqlite");
		expect(config.workspace.repo_path).toBe("/etc/casiagent/clone");
		expect(config.authorization_file).toBe("/etc/casiagent/authorization.yaml");
		expect(config.filter).toEqual({
			allowed_sources: "any",
			allowed_users: "any",
			keyword_patterns: [],
			ignore_bots: true,
		});
		expect(config.limits).toEqual({ max_evaluation_attempts: 3, abandon_awaiting_after_days: 7 });
		expect(config.panel.enabled).toBe(true);
	});

	test.each([
		["unknown key (typo)", { ...minimal, databse: "x" }],
		["missing github", { ...minimal, github: undefined }],
		[
			"secret in place of an env var name",
			{ ...minimal, github: { ...minimal.github, token_env: "ghp_abc123" } },
		],
		["empty test command", { ...minimal, workspace: { ...minimal.workspace, test_command: [] } }],
		["task budget below the API minimum", { ...minimal, llm: { task_token_budget: 1000 } }],
	])("rejects: %s", (_name, raw) => {
		expect(() => parseConfig(raw, "/x")).toThrow(ConfigFileError);
	});

	test("errors name the field and the file", async () => {
		const path = join(dir, "bad.yaml");
		writeFileSync(path, "database: x\n");
		const error = await loadConfigFile(path).catch((e: unknown) => e);
		expect(String(error)).toContain("bad.yaml");
		expect(String(error)).toContain("github");
	});

	test("empty Anthropic variables (e.g. copied from .env.example) are treated as unset", () => {
		const env: Record<string, string | undefined> = {
			ANTHROPIC_API_KEY: "",
			ANTHROPIC_AUTH_TOKEN: "  ",
			OTHER: "",
		};
		expect(normalizeAnthropicEnv(env)).toBe(false);
		expect(env).toEqual({ OTHER: "" });
		const withKey: Record<string, string | undefined> = {
			ANTHROPIC_API_KEY: "sk-ant-x",
			ANTHROPIC_AUTH_TOKEN: "",
		};
		expect(normalizeAnthropicEnv(withKey)).toBe(true);
		expect(withKey).toEqual({ ANTHROPIC_API_KEY: "sk-ant-x" });
	});

	test("the shipped .env.example lists the variables the default config reads, with no values", async () => {
		const text = await Bun.file(new URL("../../../.env.example", import.meta.url)).text();
		const names = [...text.matchAll(/^([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]);
		const config = await loadConfigFile(EXAMPLE);
		expect(names).toContain(config.github.token_env);
		expect(names).toContain("ANTHROPIC_API_KEY");
		expect(names).toContain("CASIAGENT_PANEL_TOKEN");
		expect(text).not.toMatch(/^[A-Z_][A-Z0-9_]*=\S/m);
	});

	test("requireEnv explains what is missing and why", () => {
		expect(requireEnv({ A: "x" }, "A", "p")).toBe("x");
		expect(() => requireEnv({}, "GITHUB_TOKEN", "GitHub token")).toThrow(
			/GITHUB_TOKEN is not set \(GitHub token\)/,
		);
		expect(() => requireEnv({ A: "  " }, "A", "p")).toThrow(ConfigFileError);
	});
});

describe("buildApp", () => {
	function writeSetup(name: string) {
		const root = join(dir, name);
		mkdirSync(join(root, "clone", ".git"), { recursive: true });
		copyFileSync(AUTH_EXAMPLE, join(root, "authorization.yaml"));
		return parseConfig({ ...minimal, database: ":memory:", panel: { enabled: false } }, root);
	}

	test("wires a runtime from config without touching the network", async () => {
		const app = await buildApp(writeSetup("ok"), { GITHUB_TOKEN: "github_pat_x" });
		expect(app.source.sourceId as string).toBe("github:org/repo");
		const decision = await app.runtime.parts.router.routeEvent({
			id: "own",
			sourceId: app.source.sourceId,
			threadId: "1",
			authorId: "casiagent-bot",
			authorIsBot: true,
			explicitRequest: false,
			payload: {},
			timestamp: 0,
		});
		expect(decision.type).toBe("IGNORED"); // the bot login is wired as a self author
		await app.runtime.stop();
	});

	test("fails clearly without the GitHub token", async () => {
		await expect(buildApp(writeSetup("no-token"), {})).rejects.toThrow(/GITHUB_TOKEN is not set/);
	});

	test("fails clearly when repo_path is not a git clone", async () => {
		const config = writeSetup("no-git");
		rmSync(join(config.workspace.repo_path, ".git"), { recursive: true });
		await expect(buildApp(config, { GITHUB_TOKEN: "t" })).rejects.toThrow(/not a git clone/);
	});
});
