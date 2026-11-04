/**
 * casiagent entry point: `bun run start [--config path]` (default config/casiagent.yaml).
 *
 * Credentials come from the environment only: the GitHub token from `github.token_env`
 * (default GITHUB_TOKEN), the panel token from `panel.token_env` if set, and Anthropic
 * credentials as the SDK resolves them (ANTHROPIC_API_KEY, or an `ant auth login` profile).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	ClaudeLlmAdapter,
	GitHubClient,
	GitHubPollingSource,
	GitHubPullRequests,
	GitWorktreeToolsets,
	loadAuthorizationConfig,
	openDatabase,
	SqliteCursorStore,
} from "@casiagent/adapters";
import { SourceId } from "@casiagent/domain";
import {
	type CasiagentConfig,
	ConfigFileError,
	loadConfigFile,
	normalizeAnthropicEnv,
	requireEnv,
} from "./config";
import { createRuntime, type Runtime } from "./createRuntime";

export interface App {
	readonly runtime: Runtime;
	readonly source: GitHubPollingSource;
	readonly worktrees: GitWorktreeToolsets;
}

/** Wire every adapter from validated config. Does not touch the network. */
export async function buildApp(
	config: CasiagentConfig,
	env: Readonly<Record<string, string | undefined>>,
): Promise<App> {
	const githubToken = requireEnv(
		env,
		config.github.token_env,
		"GitHub token for polling, replies and PRs",
	);
	const panelToken =
		config.panel.token_env === undefined
			? undefined
			: requireEnv(env, config.panel.token_env, "panel bearer token");
	if (!existsSync(join(config.workspace.repo_path, ".git"))) {
		throw new ConfigFileError(
			`workspace.repo_path is not a git clone: ${config.workspace.repo_path}`,
		);
	}
	const authorization = await loadAuthorizationConfig(config.authorization_file);

	const db = openDatabase(config.database);
	const github = new GitHubClient({ token: githubToken, baseUrl: config.github.api_url });
	const source = new GitHubPollingSource({
		client: github,
		owner: config.github.owner,
		repo: config.github.repo,
		botLogin: config.github.bot_login,
		requestLabels: config.github.request_labels,
		intervalMs: config.github.poll_interval_seconds * 1000,
		cursors: new SqliteCursorStore(db),
	});
	const worktrees = new GitWorktreeToolsets({
		repoPath: config.workspace.repo_path,
		worktreesDir: config.workspace.worktrees_dir,
		baseBranch: config.workspace.base_branch,
		...(config.workspace.test_command === undefined
			? {}
			: { testCommand: config.workspace.test_command }),
		testTimeoutMs: config.workspace.test_timeout_seconds * 1000,
		author: {
			name: config.github.bot_login,
			email: `${config.github.bot_login}@users.noreply.github.com`,
		},
		pullRequests: new GitHubPullRequests(github, config.github.owner, config.github.repo),
	});
	const llm = new ClaudeLlmAdapter({
		model: config.llm.model,
		taskTimeoutMs: config.llm.task_timeout_minutes * 60_000,
		taskTokenBudget: config.llm.task_token_budget,
		refusalFallbacks: config.llm.refusal_fallbacks,
		toolsets: worktrees.forWorkItem,
	});

	const runtime = createRuntime({
		database: db,
		authorization,
		filterRules: {
			allowedSourceIds:
				config.filter.allowed_sources === "any"
					? "any"
					: config.filter.allowed_sources.map((id) => SourceId.of(id)),
			allowedUserIds: config.filter.allowed_users,
			keywordPatterns: config.filter.keyword_patterns,
			ignoreBots: config.filter.ignore_bots,
		},
		authorizationRules: config.authorization_rules,
		selfAuthorIds: [config.github.bot_login],
		llm,
		sources: [source],
		workspaces: worktrees,
		contextBudgetTokens: config.llm.context_budget_tokens,
		limits: {
			maxEvaluationAttempts: config.limits.max_evaluation_attempts,
			abandonAwaitingAfterMs: config.limits.abandon_awaiting_after_days * 24 * 60 * 60_000,
		},
		panel: config.panel.enabled
			? {
					hostname: config.panel.hostname,
					port: config.panel.port,
					...(panelToken === undefined ? {} : { token: panelToken }),
				}
			: false,
	});
	return { runtime, source, worktrees };
}

function configPathFromArgs(argv: readonly string[]): string {
	const i = argv.indexOf("--config");
	if (i !== -1) {
		const path = argv[i + 1];
		if (path === undefined) throw new ConfigFileError("--config needs a path");
		return path;
	}
	return "config/casiagent.yaml";
}

export async function main(argv: readonly string[] = Bun.argv.slice(2)): Promise<void> {
	const path = configPathFromArgs(argv);
	const config = await loadConfigFile(path);
	// Empty values (e.g. copied unchanged from .env.example) would hide an `ant auth` profile.
	if (!normalizeAnthropicEnv(process.env)) {
		console.warn(
			"[casiagent] ANTHROPIC_API_KEY is not set; relying on an `ant auth login` profile. Tasks will fail (and show on the panel) if none is active.",
		);
	}
	const { runtime } = await buildApp(config, process.env);
	const { panelUrl } = await runtime.start();
	console.log(
		`[casiagent] watching github:${config.github.owner}/${config.github.repo} as ${config.github.bot_login}` +
			(panelUrl === undefined ? "" : `; attention panel: ${panelUrl}`),
	);

	let stopping = false;
	const shutdown = async (signal: string) => {
		if (stopping) {
			console.log(
				`[casiagent] ${signal} again: exiting now; interrupted work resumes on the next start`,
			);
			process.exit(1);
		}
		stopping = true;
		console.log(`[casiagent] ${signal}: finishing in-flight work (press Ctrl-C again to exit now)`);
		await runtime.stop();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(`[casiagent] ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	});
}
