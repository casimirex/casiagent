import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

/** Environment variable names: secrets are referenced by name, never written in the file. */
const EnvName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "must be an environment variable name");
const AllowList = z.union([z.literal("any"), z.array(z.string().min(1))]);
const Seconds = z.number().int().positive();

const ConfigSchema = z.strictObject({
	/** SQLite file. Relative paths are resolved against this config file's directory. */
	database: z.string().min(1),
	/** The authorization policy (see config/authorization.example.yaml). */
	authorization_file: z.string().min(1),
	/** The team's rules in plain language, given to the LLM for ambiguous requests. */
	authorization_rules: z.string().default(""),
	filter: z.strictObject({
		allowed_sources: AllowList.default("any"),
		allowed_users: AllowList.default("any"),
		keyword_patterns: z.array(z.string().min(1)).default([]),
		ignore_bots: z.boolean().default(true),
	}),
	github: z.strictObject({
		owner: z.string().min(1),
		repo: z.string().min(1),
		/** The account the agent posts as. Its own posts are ignored. */
		bot_login: z.string().min(1),
		request_labels: z.array(z.string().min(1)).default([]),
		poll_interval_seconds: Seconds.default(30),
		token_env: EnvName.default("GITHUB_TOKEN"),
		api_url: z.url().default("https://api.github.com"),
	}),
	workspace: z.strictObject({
		/** A local clone of the repository, with push access via its configured credentials. */
		repo_path: z.string().min(1),
		worktrees_dir: z.string().min(1),
		base_branch: z.string().min(1).default("main"),
		test_command: z.array(z.string().min(1)).min(1).optional(),
		test_timeout_seconds: Seconds.default(600),
	}),
	llm: z
		.strictObject({
			model: z.string().min(1).default("claude-opus-5-5"),
			task_timeout_minutes: z.number().positive().default(30),
			task_token_budget: z.number().int().min(20_000).default(200_000),
			refusal_fallbacks: z.boolean().default(true),
			context_budget_tokens: z.number().int().positive().default(100_000),
		})
		.prefault({}),
	limits: z
		.strictObject({
			max_evaluation_attempts: z.number().int().positive().default(3),
			abandon_awaiting_after_days: z.number().positive().default(7),
		})
		.prefault({}),
	panel: z
		.strictObject({
			enabled: z.boolean().default(true),
			hostname: z.string().min(1).default("127.0.0.1"),
			port: z.number().int().min(0).max(65_535).default(4317),
			/** If set, the panel requires this bearer token (open it with #token=…). */
			token_env: EnvName.optional(),
		})
		.prefault({}),
});

export type CasiagentConfig = z.infer<typeof ConfigSchema>;

export class ConfigFileError extends Error {
	override readonly name = "ConfigFileError";
}

/** Validate parsed config; resolve relative paths against `baseDir`. */
export function parseConfig(raw: unknown, baseDir: string): CasiagentConfig {
	const result = ConfigSchema.safeParse(raw);
	if (!result.success) {
		const problems = result.error.issues.map(
			(i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
		);
		throw new ConfigFileError(`invalid configuration:\n${problems.join("\n")}`);
	}
	const c = result.data;
	const abs = (p: string) => (isAbsolute(p) ? p : resolve(baseDir, p));
	return {
		...c,
		database: c.database === ":memory:" ? c.database : abs(c.database),
		authorization_file: abs(c.authorization_file),
		workspace: {
			...c.workspace,
			repo_path: abs(c.workspace.repo_path),
			worktrees_dir: abs(c.workspace.worktrees_dir),
		},
	};
}

/** Read and validate a YAML config file. */
export async function loadConfigFile(path: string): Promise<CasiagentConfig> {
	const file = Bun.file(path);
	if (!(await file.exists())) throw new ConfigFileError(`config file not found: ${path}`);
	let raw: unknown;
	try {
		raw = Bun.YAML.parse(await file.text());
	} catch (error) {
		throw new ConfigFileError(
			`${path}: cannot parse YAML (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	try {
		return parseConfig(raw, dirname(resolve(path)));
	} catch (error) {
		if (error instanceof ConfigFileError) throw new ConfigFileError(`${path}: ${error.message}`);
		throw error;
	}
}

/** Read a required secret from the environment, with an actionable message if missing. */
export function requireEnv(
	env: Readonly<Record<string, string | undefined>>,
	name: string,
	purpose: string,
): string {
	const value = env[name];
	if (value === undefined || value.trim() === "") {
		throw new ConfigFileError(`environment variable ${name} is not set (${purpose})`);
	}
	return value;
}

const ANTHROPIC_CREDENTIAL_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

/**
 * Remove Anthropic credential variables that are set but empty (e.g. copied unchanged
 * from .env.example). The SDK may treat an empty key as present, which would hide an
 * `ant auth login` profile. Returns whether any non-empty credential remains.
 */
export function normalizeAnthropicEnv(env: Record<string, string | undefined>): boolean {
	for (const name of ANTHROPIC_CREDENTIAL_VARS) {
		if (env[name] !== undefined && env[name].trim() === "") delete env[name];
	}
	return ANTHROPIC_CREDENTIAL_VARS.some((name) => env[name] !== undefined);
}
