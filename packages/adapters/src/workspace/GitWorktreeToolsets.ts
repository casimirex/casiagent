import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import type { WorkItem } from "@casiagent/domain";
import { z } from "zod";
import type { TaskToolset } from "../llm/ClaudeLlmAdapter";
import { PathError, resolveInside } from "./paths";
import { type ProcessResult, runProcess } from "./process";

type RunnableTool = TaskToolset["tools"][number];

/** Opens a pull request for a pushed branch. Implemented by the GitHub adapter (step 3). */
export interface PullRequestOpener {
	open(request: {
		readonly branch: string;
		readonly base: string;
		readonly title: string;
		readonly body: string;
	}): Promise<{ readonly number: number; readonly url: string }>;
}

export interface GitWorktreeToolsetsConfig {
	/** A local clone of the repository. Worktrees are created from it. */
	readonly repoPath: string;
	/** Where per-task worktrees live. */
	readonly worktreesDir: string;
	/** Branch work starts from and PRs target. Default "main". */
	readonly baseBranch?: string;
	/** Default "origin". */
	readonly remote?: string;
	/** Default "casiagent/". Branches are `<prefix><workItemId>`. */
	readonly branchPrefix?: string;
	/** The test command as an argument list, e.g. ["bun", "test"]. Omit to not offer run_tests. */
	readonly testCommand?: readonly string[];
	/** Default 10 minutes. */
	readonly testTimeoutMs?: number;
	/** Extra environment for the test command (on top of a minimal safe base). */
	readonly testEnv?: Readonly<Record<string, string>>;
	/** Fetch the base branch before creating a worktree. Default true. */
	readonly fetch?: boolean;
	/** Commit author. Default "casiagent <casiagent@localhost>". */
	readonly author?: { readonly name: string; readonly email: string };
	/** Omit to not offer open_pr. */
	readonly pullRequests?: PullRequestOpener;
}

const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_LIST_ENTRIES = 2_000;
const MAX_TOOL_OUTPUT = 50_000;
const MAX_TEST_OUTPUT = 20_000;
const GIT_TIMEOUT_MS = 120_000;

/** Environment variables a test run may see. Everything else (API keys, tokens) is withheld. */
const SAFE_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "USER"] as const;

function safeEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
	const env: Record<string, string> = { CI: "1" };
	for (const key of SAFE_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return { ...env, ...extra };
}

/** Git keeps its normal environment (credential helpers need it) but never prompts. */
function gitEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
	return { ...env, GIT_TERMINAL_PROMPT: "0" };
}

function cap(text: string, max: number, where: "head" | "tail" = "head"): string {
	if (text.length <= max) return text;
	return where === "head"
		? `${text.slice(0, max)}\n…[truncated ${text.length - max} characters]`
		: `…[truncated ${text.length - max} characters]\n${text.slice(-max)}`;
}

function describe(result: ProcessResult): string {
	const status = result.timedOut ? "timed out" : `exit code ${result.code}`;
	return `${status}\n${result.stdout}${result.stderr === "" ? "" : `\n[stderr]\n${result.stderr}`}`;
}

/** Wrap a tool body so path problems and other failures reach the model as tool errors. */
function guarded<A>(body: (args: A) => Promise<string>): (args: A) => Promise<string> {
	return async (args) => {
		try {
			return await body(args);
		} catch (error) {
			if (error instanceof ToolError) throw error;
			if (error instanceof PathError) throw new ToolError(error.message);
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}
	};
}

/**
 * Per-WorkItem git worktrees and the fixed tool set a Worker uses inside one.
 *
 * Safety: every path is confined to the worktree (symlinks and `.git` included), git runs
 * from argument lists with hooks disabled so model-written files never execute through
 * git, pushes go only to the task's own branch, and the test command runs with a minimal
 * environment so credentials are not exposed to repository code.
 *
 * A worktree is kept across runs of the same WorkItem (follow-ups continue the work);
 * call `remove` when the WorkItem finishes.
 */
export class GitWorktreeToolsets {
	readonly #config: GitWorktreeToolsetsConfig;
	readonly #base: string;
	readonly #remote: string;
	readonly #prefix: string;
	/** Serializes operations on the shared repository (worktree add/remove, fetch). */
	#repoLock: Promise<unknown> = Promise.resolve();

	constructor(config: GitWorktreeToolsetsConfig) {
		this.#config = config;
		this.#base = config.baseBranch ?? "main";
		this.#remote = config.remote ?? "origin";
		this.#prefix = config.branchPrefix ?? "casiagent/";
	}

	/** A TaskToolsetFactory for ClaudeLlmAdapter. */
	readonly forWorkItem = async (workItem: WorkItem): Promise<TaskToolset> => {
		const branch = this.branchFor(workItem.id);
		const root = await this.#ensureWorktree(workItem.id, branch);
		const tools = this.#tools(root, branch);
		return {
			tools,
			briefing: [
				`You are working in a git worktree of the repository on branch ${branch}, based on ${this.#remote}/${this.#base}.`,
				"All tool paths are relative to the repository root.",
				this.#config.testCommand === undefined
					? "No test command is configured."
					: `run_tests runs: ${this.#config.testCommand.join(" ")}`,
				`When the change is ready: commit_and_push${this.#config.pullRequests === undefined ? "" : ", then open_pr"}.`,
			].join("\n"),
		};
	};

	branchFor(workItemId: string): string {
		return `${this.#prefix}${workItemId.replace(/[^A-Za-z0-9._-]/g, "-")}`;
	}

	worktreePath(workItemId: string): string {
		return resolve(this.#config.worktreesDir, workItemId.replace(/[^A-Za-z0-9._-]/g, "-"));
	}

	/** Ids of WorkItems that currently have a worktree (for cleanup sweeps). */
	async list(): Promise<string[]> {
		const entries = await readdir(this.#config.worktreesDir, { withFileTypes: true }).catch(
			() => [],
		);
		return entries.filter((e) => e.isDirectory()).map((e) => e.name);
	}

	/** Remove a finished WorkItem's worktree. The branch stays (it may back an open PR). */
	async remove(workItemId: string): Promise<void> {
		const path = this.worktreePath(workItemId);
		await this.#withRepoLock(async () => {
			if (await exists(path))
				await this.#git(this.#config.repoPath, ["worktree", "remove", "--force", path]);
			await this.#git(this.#config.repoPath, ["worktree", "prune"]);
		});
	}

	async #ensureWorktree(workItemId: string, branch: string): Promise<string> {
		const path = this.worktreePath(workItemId);
		return this.#withRepoLock(async () => {
			if (await exists(join(path, ".git"))) return path;
			await mkdir(this.#config.worktreesDir, { recursive: true });
			const repo = this.#config.repoPath;
			if (this.#config.fetch ?? true) await this.#git(repo, ["fetch", this.#remote, this.#base]);
			const hasBranch =
				(await this.#run(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]))
					.code === 0;
			await this.#git(
				repo,
				hasBranch
					? ["worktree", "add", path, branch]
					: ["worktree", "add", "-b", branch, path, `${this.#remote}/${this.#base}`],
			);
			return path;
		});
	}

	#withRepoLock<T>(work: () => Promise<T>): Promise<T> {
		const next = this.#repoLock.then(work, work);
		this.#repoLock = next.catch(() => {});
		return next;
	}

	#run(cwd: string, args: readonly string[]): Promise<ProcessResult> {
		// Hooks off: a model-written file must never run as a git hook.
		return runProcess(["git", "-c", "core.hooksPath=/dev/null", ...args], {
			cwd,
			env: gitEnv(),
			timeoutMs: GIT_TIMEOUT_MS,
			maxOutputBytes: MAX_TOOL_OUTPUT * 4,
		});
	}

	async #git(cwd: string, args: readonly string[]): Promise<string> {
		const result = await this.#run(cwd, args);
		if (result.code !== 0) {
			throw new ToolError(
				`git ${args[0]} failed (${result.timedOut ? "timed out" : `exit ${result.code}`}): ${cap(result.stderr.trim(), 2_000)}`,
			);
		}
		return result.stdout;
	}

	#tools(root: string, branch: string): RunnableTool[] {
		const config = this.#config;
		const tools: RunnableTool[] = [];

		tools.push(
			betaZodTool({
				name: "read_file",
				description: "Read a text file from the repository. Large files are truncated.",
				inputSchema: z.object({
					path: z.string().describe("Path relative to the repository root"),
				}),
				run: guarded(async ({ path }) => {
					const target = await resolveInside(root, path, "read");
					const info = await stat(target).catch(() => undefined);
					if (info === undefined) throw new ToolError(`${path} does not exist`);
					if (!info.isFile()) throw new ToolError(`${path} is not a file`);
					const bytes = await readFile(target);
					const text = bytes.subarray(0, MAX_READ_BYTES).toString("utf8");
					return bytes.length > MAX_READ_BYTES
						? `${text}\n…[truncated: file is ${bytes.length} bytes, showing the first ${MAX_READ_BYTES}]`
						: text;
				}),
			}),
			betaZodTool({
				name: "list_files",
				description:
					"List files (tracked and new, excluding ignored ones), optionally under a directory.",
				inputSchema: z.object({
					path: z.string().optional().describe("Directory relative to the root"),
				}),
				run: guarded(async ({ path }) => {
					const dir = path === undefined || path === "" ? "." : path;
					await resolveInside(root, dir, "read");
					const out = await this.#git(root, [
						"ls-files",
						"--cached",
						"--others",
						"--exclude-standard",
						"--",
						dir,
					]);
					const files = out.split("\n").filter((f) => f !== "");
					const shown = files.slice(0, MAX_LIST_ENTRIES).join("\n");
					return files.length > MAX_LIST_ENTRIES
						? `${shown}\n…[${files.length - MAX_LIST_ENTRIES} more files not shown]`
						: shown || "(no files)";
				}),
			}),
			betaZodTool({
				name: "search",
				description:
					"Search file contents with an extended regular expression (git grep). Returns path:line:text.",
				inputSchema: z.object({
					pattern: z.string().min(1),
					path: z.string().optional().describe("Directory or file to limit the search to"),
				}),
				run: guarded(async ({ pattern, path }) => {
					const where = path === undefined || path === "" ? "." : path;
					await resolveInside(root, where, "read");
					// -e keeps a pattern like "--output=x" from being read as an option.
					const result = await this.#run(root, [
						"grep",
						"-n",
						"-I",
						"-E",
						"--untracked",
						"-e",
						pattern,
						"--",
						where,
					]);
					if (result.code === 1) return "(no matches)";
					if (result.code !== 0)
						throw new ToolError(`search failed: ${cap(result.stderr.trim(), 2_000)}`);
					return cap(result.stdout, MAX_TOOL_OUTPUT);
				}),
			}),
			betaZodTool({
				name: "write_file",
				description:
					"Create or overwrite a text file in the repository with the full new contents.",
				inputSchema: z.object({ path: z.string(), content: z.string() }),
				eager_input_streaming: true,
				run: guarded(async ({ path, content }) => {
					if (Buffer.byteLength(content) > MAX_WRITE_BYTES) {
						throw new ToolError(`content is larger than ${MAX_WRITE_BYTES} bytes`);
					}
					const target = await resolveInside(root, path, "write");
					await mkdir(dirname(target), { recursive: true });
					// Re-check after creating directories, in case one of them is a symlink.
					await resolveInside(root, path, "write");
					await writeFile(target, content);
					return `Wrote ${Buffer.byteLength(content)} bytes to ${path}`;
				}),
			}),
		);

		if (config.testCommand !== undefined) {
			const command = config.testCommand;
			tools.push(
				betaZodTool({
					name: "run_tests",
					description: `Run the project's tests (${command.join(" ")}). Returns the exit code and the end of the output.`,
					inputSchema: z.object({}),
					run: guarded(async () => {
						const result = await runProcess(command, {
							cwd: root,
							env: safeEnv(config.testEnv),
							timeoutMs: config.testTimeoutMs ?? 10 * 60_000,
							maxOutputBytes: MAX_TEST_OUTPUT * 8,
						});
						return cap(describe(result), MAX_TEST_OUTPUT, "tail");
					}),
				}),
			);
		}

		tools.push(
			betaZodTool({
				name: "commit_and_push",
				description: `Commit all changes in the worktree and push them to branch ${branch}.`,
				inputSchema: z.object({ message: z.string().min(1).describe("Commit message") }),
				run: guarded(async ({ message }) => {
					const author = config.author ?? { name: "casiagent", email: "casiagent@localhost" };
					await this.#git(root, ["add", "--all"]);
					const status = await this.#git(root, ["status", "--porcelain"]);
					let committed = "No changes to commit.";
					if (status.trim() !== "") {
						await this.#git(root, [
							"-c",
							`user.name=${author.name}`,
							"-c",
							`user.email=${author.email}`,
							"commit",
							"--no-verify",
							"-m",
							message,
						]);
						committed = "Committed.";
					}
					// Explicit refspec: this can only ever update the task's own branch.
					await this.#git(root, ["push", "--no-verify", this.#remote, `HEAD:refs/heads/${branch}`]);
					return `${committed} Pushed to ${this.#remote}/${branch}.`;
				}),
			}),
		);

		const opener = config.pullRequests;
		if (opener !== undefined) {
			tools.push(
				betaZodTool({
					name: "open_pr",
					description: `Open a pull request from ${branch} into ${this.#base}. Push first with commit_and_push.`,
					inputSchema: z.object({ title: z.string().min(1), body: z.string() }),
					run: guarded(async ({ title, body }) => {
						const pr = await opener.open({ branch, base: this.#base, title, body });
						return `Opened pull request #${pr.number}: ${pr.url}. List it in submit_result artifacts (threadId "${pr.number}") to receive its reviews and CI results.`;
					}),
				}),
			);
		}
		return tools;
	}
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}
