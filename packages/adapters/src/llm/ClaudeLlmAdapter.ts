import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat, betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { EXECUTE_TASK_SYSTEM_PROMPT, SUBMIT_RESULT_TOOL } from "@casiagent/application";
import {
	type ArtifactRef,
	type ContextMessage,
	DomainError,
	type LlmPort,
	SourceId,
	type TaskExecutionRequest,
	type TriggerEvaluationRequest,
	type TriggerVerdict,
	type WorkItem,
	type WorkResult,
} from "@casiagent/domain";
import { z } from "zod";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

/** The tools a Worker gets for one WorkItem (Phase 6 step 2 supplies real ones). */
export interface TaskToolset {
	// biome-ignore lint/suspicious/noExplicitAny: matches the SDK's own runnable-tool arrays (inputs are validated per tool)
	readonly tools: readonly BetaRunnableTool<any>[];
	/** Task-specific setup the model should know (e.g. "the repository is checked out at …"). */
	readonly briefing?: string;
	/** Called after the run, whatever its outcome. */
	dispose?(): Promise<void>;
}

export type TaskToolsetFactory = (workItem: WorkItem) => Promise<TaskToolset>;

export interface ClaudeLlmAdapterOptions {
	/** Defaults to `new Anthropic(...)`, which reads ANTHROPIC_API_KEY or an `ant auth login` profile. */
	readonly client?: Anthropic;
	/** Default claude-opus-5-5. */
	readonly model?: string;
	/** Default "low": evaluation is a classification. Opus 5.5 defaults to medium, so it is always set. */
	readonly evaluationEffort?: Effort;
	/** Default "high". */
	readonly taskEffort?: Effort;
	/** Wall-clock limit for one task run. Default 30 minutes. */
	readonly taskTimeoutMs?: number;
	/** Advisory token budget the model paces itself against (min 20,000). Default 200,000. */
	readonly taskTokenBudget?: number;
	/** Cap on API requests in one task run. Default 60. */
	readonly maxIterations?: number;
	/** Server-side refusal fallbacks. Default true. */
	readonly refusalFallbacks?: boolean;
	/** Tools for each task. Default: none besides submit_result. */
	readonly toolsets?: TaskToolsetFactory;
}

/** The model declined the request (stop_reason "refusal", after any fallbacks). */
export class ModelRefusalError extends Error {
	override readonly name = "ModelRefusalError";
}

const DEFAULT_MODEL = "claude-opus-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const TASK_BUDGET_BETA = "task-budgets-2026-03-13";

const VerdictSchema = z.object({
	accepted: z.boolean(),
	reason: z.string(),
	priority: z.enum(["low", "normal", "high"]),
});

const WorkResultSchema = z.object({
	output: z
		.string()
		.min(1)
		.describe("What you did or found, for the person who asked. Posted as a reply."),
	status: z
		.enum(["DONE", "AWAITING_FEEDBACK"])
		.describe("DONE when finished; AWAITING_FEEDBACK when waiting on a review or reply."),
	artifacts: z
		.array(
			z.object({
				sourceId: z.string().describe('Source of the thread, like "github:org/repo"'),
				threadId: z.string().describe("Thread id within the source, e.g. the pull request number"),
				url: z.string().optional(),
			}),
		)
		.optional()
		.describe("Threads whose follow-ups should come to you, e.g. a pull request you opened."),
	attention: z
		.object({
			kind: z.enum(["QUESTION", "REVIEW_REQUEST"]),
			message: z.string().min(1),
			url: z.string().optional(),
		})
		.optional()
		.describe("Set only when a human must act."),
});

/**
 * LlmPort on the Claude API (`@anthropic-ai/sdk`).
 *
 * - evaluateTrigger: one request, structured output constrained to the verdict schema.
 *   A refusal fails closed (accepted: false) so a declined trigger is not retried forever.
 * - executeTask: the SDK tool runner over the toolset's tools plus `submit_result`, whose
 *   validated input becomes the WorkResult. No further turns run once it is submitted.
 *   Streams every turn; bounded by a wall-clock timeout and an advisory token budget.
 *   Each run is a fresh, append-only conversation built from the Worker's stored context.
 */
export class ClaudeLlmAdapter implements LlmPort {
	readonly #client: Anthropic;
	readonly #model: string;
	readonly #evaluationEffort: Effort;
	readonly #taskEffort: Effort;
	readonly #taskTimeoutMs: number;
	readonly #taskTokenBudget: number;
	readonly #maxIterations: number;
	readonly #fallbacks: boolean;
	readonly #toolsets: TaskToolsetFactory;

	constructor(options: ClaudeLlmAdapterOptions = {}) {
		this.#client = options.client ?? new Anthropic({ maxRetries: 2 });
		this.#model = options.model ?? DEFAULT_MODEL;
		this.#evaluationEffort = options.evaluationEffort ?? "low";
		this.#taskEffort = options.taskEffort ?? "high";
		this.#taskTimeoutMs = options.taskTimeoutMs ?? 30 * 60_000;
		this.#taskTokenBudget = Math.max(20_000, options.taskTokenBudget ?? 200_000);
		this.#maxIterations = options.maxIterations ?? 60;
		this.#fallbacks = options.refusalFallbacks ?? true;
		this.#toolsets = options.toolsets ?? (async () => ({ tools: [] }));
	}

	async evaluateTrigger(request: TriggerEvaluationRequest): Promise<TriggerVerdict> {
		const response = await this.#client.beta.messages.parse({
			model: this.#model,
			max_tokens: 4_000,
			messages: [{ role: "user", content: request.prompt }],
			output_config: { effort: this.#evaluationEffort, format: betaZodOutputFormat(VerdictSchema) },
			...this.#fallbackParams([]),
		});
		if (response.stop_reason === "refusal") {
			// Fail closed: a declined evaluation must not become an action, nor loop as a retry.
			return {
				accepted: false,
				reason: `The model declined to evaluate this trigger (${response.stop_details?.category ?? "no category"}).`,
				priority: "normal",
			};
		}
		// A cut-off or malformed answer makes parse() throw, or leaves parsed_output null; either
		// way the use case gets an error and returns the trigger to PENDING.
		if (response.parsed_output === null) {
			throw new Error(`Evaluation of ${request.triggerId} returned no parseable verdict`);
		}
		return response.parsed_output;
	}

	async executeTask(request: TaskExecutionRequest): Promise<WorkResult> {
		const toolset = await this.#toolsets(request.workItem);
		let submitted: WorkResult | undefined;
		const submitResult = betaZodTool({
			name: SUBMIT_RESULT_TOOL,
			description: "Finish this run with its result. Call exactly once, then end your turn.",
			inputSchema: WorkResultSchema,
			eager_input_streaming: true,
			run: async (input) => {
				submitted = toWorkResult(input); // throws ToolError on bad artifacts, so the model can fix them
				return "Result recorded. End your turn now.";
			},
		});

		try {
			const runner = this.#client.beta.messages.toolRunner(
				{
					model: this.#model,
					max_tokens: 64_000,
					stream: true,
					thread: false, // stateless: full history each turn; our store owns persistence
					max_iterations: this.#maxIterations,
					system: [
						{
							type: "text",
							text: EXECUTE_TASK_SYSTEM_PROMPT,
							cache_control: { type: "ephemeral" },
						},
					],
					tools: [...toolset.tools, submitResult],
					messages: toMessages(request.context.messages, toolset.briefing),
					output_config: {
						effort: this.#taskEffort,
						task_budget: { type: "tokens", total: this.#taskTokenBudget },
					},
					...this.#fallbackParams([TASK_BUDGET_BETA]),
				},
				{ signal: AbortSignal.timeout(this.#taskTimeoutMs) },
			);

			// The runner runs submit_result when it continues past the turn that called it; the
			// model then gets "Result recorded" and ends its turn. Stop as soon as we have it.
			for await (const stream of runner) {
				const message = await stream.finalMessage();
				if (submitted !== undefined) break;
				if (message.stop_reason === "refusal") {
					throw new ModelRefusalError(
						`The model declined the task (${message.stop_details?.category ?? "no category"}).`,
					);
				}
				if (message.stop_reason === "max_tokens") {
					throw new Error(`Task ${request.workItem.id}: a response was cut off (max_tokens)`);
				}
			}
		} finally {
			await toolset.dispose?.();
		}

		if (submitted === undefined) {
			throw new Error(
				`Task ${request.workItem.id} ended without calling ${SUBMIT_RESULT_TOOL} (iteration cap or plain answer)`,
			);
		}
		return submitted;
	}

	#fallbackParams(extraBetas: string[]): { betas?: string[]; fallbacks?: "default" } {
		const betas = this.#fallbacks ? [FALLBACK_BETA, ...extraBetas] : extraBetas;
		return {
			...(betas.length > 0 ? { betas } : {}),
			...(this.#fallbacks ? { fallbacks: "default" as const } : {}),
		};
	}
}

function toWorkResult(input: z.infer<typeof WorkResultSchema>): WorkResult {
	const artifacts: ArtifactRef[] = (input.artifacts ?? []).map((a) => {
		let sourceId: SourceId;
		try {
			sourceId = SourceId.of(a.sourceId);
		} catch (error) {
			if (error instanceof DomainError) {
				throw new ToolError(
					`Invalid artifact sourceId ${JSON.stringify(a.sourceId)}: ${error.message}`,
				);
			}
			throw error;
		}
		return a.url === undefined
			? { sourceId, threadId: a.threadId }
			: { sourceId, threadId: a.threadId, url: a.url };
	});
	const attention =
		input.attention === undefined
			? undefined
			: input.attention.url === undefined
				? { kind: input.attention.kind, message: input.attention.message }
				: {
						kind: input.attention.kind,
						message: input.attention.message,
						url: input.attention.url,
					};
	return {
		output: input.output,
		status: input.status,
		...(artifacts.length > 0 ? { artifacts } : {}),
		...(attention === undefined ? {} : { attention }),
	};
}

/**
 * Worker context -> API messages. Our own `system`/`tool` notes (spill pointer, recalled
 * context, tool output) become tagged user text: a mid-conversation system message may
 * not be followed by a user turn, and API tool results need tool_use ids we don't keep.
 * The conversation must end on a user turn, so a resumed run gets an explicit nudge.
 */
const ROLE_TAG: Readonly<Record<ContextMessage["role"], string>> = {
	user: "",
	assistant: "",
	system: "[context note]\n",
	tool: "[tool output]\n",
};

export function toMessages(context: readonly ContextMessage[], briefing?: string): MessageParam[] {
	const messages: MessageParam[] = context.map((m) => ({
		role: m.role === "assistant" ? "assistant" : "user",
		content: `${ROLE_TAG[m.role]}${m.content}`,
	}));
	if (briefing !== undefined) messages.push({ role: "user", content: `[setup]\n${briefing}` });
	if (messages.length === 0 || messages.at(-1)?.role === "assistant") {
		messages.push({ role: "user", content: "Continue the task from where you left off." });
	}
	return messages;
}
