import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import {
	ClaudeLlmAdapter,
	GitWorktreeToolsets,
	type GitWorktreeToolsetsConfig,
	type TaskToolset,
} from "@casiagent/adapters";
import type { WorkItem } from "@casiagent/domain";
import { FakeAnthropic } from "../llm/fakeAnthropic";

const base = mkdtempSync(join(tmpdir(), "casiagent-wt-"));
const outside = mkdtempSync(join(tmpdir(), "casiagent-outside-"));
afterAll(() => {
	rmSync(base, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	const r = Bun.spawnSync(["git", ...args], {
		cwd,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString();
}

const remote = join(base, "remote.git");
const repo = join(base, "clone");

beforeAll(() => {
	writeFileSync(join(outside, "secret.txt"), "TOP SECRET");
	const seed = join(base, "seed");
	Bun.spawnSync(["git", "init", "-q", "-b", "main", seed]);
	writeFileSync(join(seed, "README.md"), "# demo\n");
	writeFileSync(join(seed, "app.ts"), "export const answer = 41;\n");
	git(seed, "add", ".");
	git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
	git(base, "clone", "-q", "--bare", seed, remote);
	git(base, "clone", "-q", remote, repo);
});

let n = 0;
function workItem(): WorkItem {
	n += 1;
	return { id: `item-${n}`, triggerId: "t", assignedWorkerId: "w", status: "RUNNING" };
}

function toolsets(overrides: Partial<GitWorktreeToolsetsConfig> = {}) {
	return new GitWorktreeToolsets({
		repoPath: repo,
		worktreesDir: join(base, "worktrees"),
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, evaluated by sh
		testCommand: ["sh", "-c", 'echo "tests ran"; echo "key=${ANTHROPIC_API_KEY:-unset}"'],
		...overrides,
	});
}

/** Call a tool the way the runner does: validate the raw input, then run it. */
async function call(toolset: TaskToolset, name: string, input: unknown): Promise<string> {
	const tool = toolset.tools.find((t) => t.name === name);
	if (tool === undefined) throw new Error(`no tool ${name}`);
	const result = await tool.run(tool.parse(input));
	return typeof result === "string" ? result : JSON.stringify(result);
}

async function rejectsWith(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
	const error = await promise.then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(ToolError);
	expect(String((error as ToolError).content)).toMatch(pattern);
}

describe("GitWorktreeToolsets: worktree lifecycle", () => {
	test("creates a worktree on its own branch from origin/main and describes it", async () => {
		const ts = toolsets();
		const item = workItem();
		const toolset = await ts.forWorkItem(item);

		const path = ts.worktreePath(item.id);
		expect(git(path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(`casiagent/${item.id}`);
		expect(toolset.briefing).toContain(`casiagent/${item.id}`);
		expect(toolset.tools.map((t) => t.name)).toEqual([
			"read_file",
			"list_files",
			"search",
			"write_file",
			"run_tests",
			"commit_and_push",
		]);
	});

	test("a follow-up run reuses the same worktree and keeps uncommitted work", async () => {
		const ts = toolsets();
		const item = workItem();
		await call(await ts.forWorkItem(item), "write_file", { path: "notes.md", content: "wip" });
		const again = await ts.forWorkItem(item);
		expect(await call(again, "read_file", { path: "notes.md" })).toBe("wip");
	});

	test("concurrent tasks get separate worktrees without git lock errors", async () => {
		const ts = toolsets();
		const items = [workItem(), workItem(), workItem()];
		await Promise.all(items.map((i) => ts.forWorkItem(i)));
		for (const i of items) expect(existsSync(join(ts.worktreePath(i.id), "app.ts"))).toBe(true);
	});

	test("remove deletes the worktree but keeps the branch", async () => {
		const ts = toolsets();
		const item = workItem();
		await ts.forWorkItem(item);
		await ts.remove(item.id);
		expect(existsSync(ts.worktreePath(item.id))).toBe(false);
		expect(git(repo, "branch", "--list", `casiagent/${item.id}`)).toContain(item.id);
	});

	test("run_tests and open_pr are offered only when configured", async () => {
		const ts = new GitWorktreeToolsets({ repoPath: repo, worktreesDir: join(base, "worktrees") });
		const names = (await ts.forWorkItem(workItem())).tools.map((t) => t.name);
		expect(names).not.toContain("run_tests");
		expect(names).not.toContain("open_pr");
	});
});

describe("GitWorktreeToolsets: file tools", () => {
	test("read, write, list and search work inside the worktree", async () => {
		const toolset = await toolsets().forWorkItem(workItem());
		expect(await call(toolset, "read_file", { path: "app.ts" })).toContain("answer = 41");
		await call(toolset, "write_file", {
			path: "src/new/deep.ts",
			content: "export const x = 1;\n",
		});
		expect(await call(toolset, "list_files", {})).toContain("src/new/deep.ts");
		expect(await call(toolset, "list_files", { path: "src" })).toBe("src/new/deep.ts");
		expect(await call(toolset, "search", { pattern: "answer = [0-9]+" })).toContain("app.ts:1:");
		expect(await call(toolset, "search", { pattern: "no-such-text" })).toBe("(no matches)");
	});

	test("a search pattern that looks like an option is treated as a pattern", async () => {
		const toolset = await toolsets().forWorkItem(workItem());
		expect(
			await call(toolset, "search", { pattern: "--open-files-in-pager=touch /tmp/pwned" }),
		).toBe("(no matches)");
	});

	test.each([
		["parent escape", "../../outside.txt"],
		["absolute path", "/etc/passwd"],
		["git metadata", ".git/config"],
		["nested git dir", "sub/.git/hooks/pre-commit"],
	])("rejects %s for reads and writes", async (_name, path) => {
		const toolset = await toolsets().forWorkItem(workItem());
		await rejectsWith(call(toolset, "read_file", { path }), /outside|relative|\.git/);
		await rejectsWith(
			call(toolset, "write_file", { path, content: "x" }),
			/outside|relative|\.git/,
		);
	});

	test("symlinks cannot be used to reach outside the worktree or into .git", async () => {
		const ts = toolsets();
		const item = workItem();
		const toolset = await ts.forWorkItem(item);
		const root = ts.worktreePath(item.id);
		symlinkSync(outside, join(root, "escape"));
		symlinkSync(join(outside, "secret.txt"), join(root, "secret-link"));
		symlinkSync(join(root, ".git"), join(root, "gitlink"));

		await rejectsWith(call(toolset, "read_file", { path: "escape/secret.txt" }), /outside/);
		await rejectsWith(call(toolset, "read_file", { path: "secret-link" }), /outside/);
		await rejectsWith(
			call(toolset, "write_file", { path: "escape/new.txt", content: "x" }),
			/outside/,
		);
		await rejectsWith(
			call(toolset, "write_file", { path: "secret-link", content: "x" }),
			/symlink/,
		);
		await rejectsWith(call(toolset, "read_file", { path: "gitlink" }), /\.git/);
		expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("TOP SECRET");
		expect(existsSync(join(outside, "new.txt"))).toBe(false);
	});

	test("large files are truncated on read; oversized writes are refused", async () => {
		const toolset = await toolsets().forWorkItem(workItem());
		await call(toolset, "write_file", { path: "big.txt", content: "a".repeat(300 * 1024) });
		expect(await call(toolset, "read_file", { path: "big.txt" })).toContain("[truncated");
		await rejectsWith(
			call(toolset, "write_file", { path: "huge.txt", content: "a".repeat(1024 * 1024 + 1) }),
			/larger/,
		);
	});
});

describe("GitWorktreeToolsets: tests and git", () => {
	test("run_tests runs the configured command without the agent's credentials", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
		try {
			const out = await call(await toolsets().forWorkItem(workItem()), "run_tests", {});
			expect(out).toContain("exit code 0");
			expect(out).toContain("tests ran");
			expect(out).toContain("key=unset");
		} finally {
			delete process.env.ANTHROPIC_API_KEY;
		}
	});

	test("run_tests reports a timeout instead of hanging", async () => {
		const ts = toolsets({ testCommand: ["sleep", "30"], testTimeoutMs: 200 });
		expect(await call(await ts.forWorkItem(workItem()), "run_tests", {})).toContain("timed out");
	});

	test("commit_and_push pushes only the task branch; main on the remote is untouched", async () => {
		const ts = toolsets();
		const item = workItem();
		const toolset = await ts.forWorkItem(item);
		const mainBefore = git(remote, "rev-parse", "refs/heads/main").trim();
		await call(toolset, "write_file", { path: "app.ts", content: "export const answer = 42;\n" });

		const out = await call(toolset, "commit_and_push", { message: "Fix the answer" });

		expect(out).toContain(`Pushed to origin/casiagent/${item.id}`);
		expect(
			git(remote, "log", "-1", "--format=%s %an", `refs/heads/casiagent/${item.id}`).trim(),
		).toBe("Fix the answer casiagent");
		expect(git(remote, "rev-parse", "refs/heads/main").trim()).toBe(mainBefore);
	});

	test("git hooks never run, so files the model writes cannot execute through git", async () => {
		const ts = toolsets();
		const item = workItem();
		const toolset = await ts.forWorkItem(item);
		const marker = join(outside, `hook-ran-${item.id}`);
		// Point the shared repo's hooks at a directory the model could write to.
		const hooks = join(ts.worktreePath(item.id), "hooks");
		// post-commit: `--no-verify` does not skip it, so only disabling hooks stops it.
		await call(toolset, "write_file", {
			path: "hooks/post-commit",
			content: `#!/bin/sh\ntouch ${marker}\n`,
		});
		Bun.spawnSync(["chmod", "+x", join(hooks, "post-commit")]);
		git(repo, "config", "core.hooksPath", hooks);
		try {
			await call(toolset, "write_file", { path: "x.txt", content: "x" });
			await call(toolset, "commit_and_push", { message: "with hooks configured" });
		} finally {
			git(repo, "config", "--unset", "core.hooksPath");
		}
		expect(existsSync(marker)).toBe(false);
	});

	test("open_pr opens a PR for the task branch via the configured opener", async () => {
		const opened: unknown[] = [];
		const ts = toolsets({
			pullRequests: {
				open: async (req) => {
					opened.push(req);
					return { number: 7, url: "https://x.test/pull/7" };
				},
			},
		});
		const item = workItem();
		const out = await call(await ts.forWorkItem(item), "open_pr", {
			title: "Fix",
			body: "Details",
		});
		expect(opened).toEqual([
			{ branch: `casiagent/${item.id}`, base: "main", title: "Fix", body: "Details" },
		]);
		expect(out).toContain('threadId "7"');
	});
});

describe("GitWorktreeToolsets + ClaudeLlmAdapter", () => {
	test("the tool runner executes the real worktree tools and returns the submitted result", async () => {
		const fake = new FakeAnthropic();
		const ts = toolsets();
		const item = workItem();
		fake.turns.push(
			{ blocks: [{ tool: "read_file", input: { path: "app.ts" } }], stop_reason: "tool_use" },
			{
				blocks: [
					{ tool: "write_file", input: { path: "app.ts", content: "export const answer = 42;\n" } },
				],
				stop_reason: "tool_use",
			},
			{
				blocks: [{ tool: "submit_result", input: { output: "Set answer to 42", status: "DONE" } }],
				stop_reason: "tool_use",
			},
			{ blocks: [{ text: "ok" }], stop_reason: "end_turn" },
		);
		const llm = new ClaudeLlmAdapter({ client: fake.client(), toolsets: ts.forWorkItem });

		const result = await llm.executeTask({
			workItem: item,
			context: { messages: [{ role: "user", content: "Make the answer 42" }] },
		});

		expect(result).toEqual({ output: "Set answer to 42", status: "DONE" });
		const firstResult = JSON.stringify(fake.requests[1]?.body.messages.at(-1));
		expect(firstResult).toContain("answer = 41"); // read_file's real output went back to the model
		expect(readFileSync(join(ts.worktreePath(item.id), "app.ts"), "utf8")).toBe(
			"export const answer = 42;\n",
		);
	});
});
