# SuperAgent-like System: Complete Build Roadmap (Bun + TypeScript)

This roadmap describes how to build a SuperAgent-like system from scratch using **Bun** and **TypeScript**, following **Clean Architecture** principles. Each phase includes a context prompt for Claude Code to implement the phase.

---

## Working Notes (keep current)

**Progress**: Phases 0–5 — done. Phase 6 steps 1–4 — done (runnable: `bun run start`). Next: a live smoke test against real GitHub + Claude (costs money; needs the user's go-ahead and credentials).

**Phase 6 plan (approved 2026-11-03; not in the original roadmap)**
- `ClaudeLlmAdapter` (adapters, `@anthropic-ai/sdk`), model `claude-opus-5-5` for both calls; set effort explicitly (Opus 5.5 defaults to `medium`): `low` for `evaluateTrigger`, `high` for `executeTask`.
  - `evaluateTrigger`: structured outputs (`output_config.format`, JSON schema); prompt bumps to `evaluate-trigger/v2` without the "respond with only JSON" line. The use case still validates.
  - `executeTask`: SDK Tool Runner over our own tools; the run ends when the model calls a `submit_result` tool whose strict schema is `WorkResult`. Forced `tool_choice` is a 400 on Opus 5.5, so use `auto` + a prompt instruction. Stream; max_tokens ~64K.
  - Server-side refusal fallbacks on (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`). A chain refusal on evaluation → REJECTED (fail closed, no retry loop); on a task → FAILED + panel.
  - SDK timeout + default retries, typed error classes; per-task wall-clock limit (AbortController) and `task_budget` (beta). This closes the "hung LLM call heartbeats forever" gap.
  - Caching: system prompt and tool list are byte-stable and cached; volatile content goes after them. Each run is a fresh API conversation built from our stored context; within a run, history is append-only (Opus 5.5 preserved thinking rejects edited history). `ContextManager` applies between runs only; long runs use API compaction.
- _Step 1 (done)_: `packages/adapters/src/llm/ClaudeLlmAdapter.ts` (`@anthropic-ai/sdk` 1.4, `zod` 4). Decisions made while building it:
  - The tool runner uses `thread: false` (stateless, full history each turn). The default thread mode needs the server-side message-threads beta; our store already owns conversation state.
  - The runner runs `submit_result` when it continues past the turn that called it, so a run costs one extra short request ("Result recorded"; the prefix is cached). The adapter stops right after, even if the model keeps going.
  - Our `system`/`tool` context notes become tagged user text (`[context note]`, `[tool output]`): a mid-conversation system message may not be followed by a user turn, and API tool results need tool_use ids we don't keep. A resumed run ending on an assistant turn gets a "Continue" nudge.
  - An invalid `submit_result` input (schema, or a bad artifact `sourceId`) goes back to the model as a tool error so it can fix it; ending without `submit_result` is an error, never an implicit DONE.
  - The Worker system prompt lives in `application/src/prompts/executeTask.ts` (`execute-task/v1`, byte-stable for caching). The evaluation prompt is now `evaluate-trigger/v2` (structured outputs enforce the format).
  - Tests: `packages/adapters/test/llm/fakeAnthropic.ts` is a fake API behind the real SDK (JSON and SSE), with a 3 s client timeout so no test can hang the suite.
- _Step 2 (done)_: `packages/adapters/src/workspace/` — `GitWorktreeToolsets` (`forWorkItem` is the adapter's `TaskToolsetFactory`), `resolveInside` (path confinement), `runProcess` (argv only, timeout, bounded output).
  - One worktree per WorkItem at `<worktreesDir>/<id>` on branch `casiagent/<id>` from `origin/<base>`; reused across runs (follow-ups continue the work). `remove(id)` deletes it and keeps the branch; the runtime should call it when a WorkItem finishes (step 4).
  - All git runs with `-c core.hooksPath=/dev/null` (plus `--no-verify`): post-commit/post-checkout hooks are not skipped by `--no-verify`, so the override is what keeps model-written files from executing via git. Pushes use the explicit refspec `HEAD:refs/heads/<own branch>`. Search passes the pattern with `-e`.
  - `run_tests` gets only PATH/HOME/LANG/LC_ALL/TERM/TMPDIR/USER + `CI=1` + `testEnv`. It still runs repository code on the host with the user's file access (the chosen trade-off; the Docker option was declined). Killing the test process does not kill its children.
  - `open_pr` needs a `PullRequestOpener` (step 3's GitHub client) and is offered only when one is configured.
- _Step 3 (done)_: `packages/adapters/src/github/` — `GitHubClient` (REST, pagination, rate-limit detection; never sends the token to another host or puts it in errors), `GitHubPollingSource` (SourcePort), `GitHubPullRequests` (PullRequestOpener; a 422 for an existing PR returns that PR), `SqliteCursorStore` (migration 3, `source_cursors`).
  - Polls four endpoints every 30 s: issues (only those *created* after the cursor count as new), issue/PR conversation comments, PR review comments, issue events (only "assigned to the bot" and "request label added"). Event ids: `issue:` / `comment:` / `review-comment:` / `event:` + GitHub id. Thread = issue/PR number (same number space, so it matches `open_pr` artifacts).
  - `explicitRequest` = whole-word `@<botLogin>` mention (case-insensitive), assignment to the bot, or a `requestLabels` label. Everything else is inferred.
  - Cursor: persisted; a first-ever run starts at "now" (no history replay); advanced only after delivery; each poll re-reads `overlapMs` (60 s) and intake deduplicates by event id. "Since" is strictly newer-than. A poll with no subscriber does nothing (it must not advance past events nobody received). Rate-limited → paused until the reset time.
  - Not polled yet: PR reviews (approve/request changes summary) and CI check runs/statuses. CI that reports by commenting does arrive.
- _Step 4 (done)_: `apps/runtime/src/config.ts` (zod; strict keys; relative paths resolve against the config file; secrets only as env var names), `apps/runtime/src/main.ts` (`buildApp` wires everything without network; `main` loads `config/casiagent.yaml` or `--config`, SIGINT/SIGTERM drain, a second signal exits now). Example: `config/casiagent.example.yaml` (tested). `config/casiagent.yaml`, `config/authorization.yaml` and `data/` are gitignored.
  - `createRuntime` accepts an open `database` (shared with the GitHub cursor store) and a `workspaces` cleaner. `maintain()` runs every 60 s: re-evaluate PENDING triggers, dispatch ACCEPTED, `AbandonStaleWorkUseCase` (WAITING sessions idle > `abandon_awaiting_after_days` → WorkItem ABANDONED via CAS, session FAILED, unsubscribed, `WORK_ABANDONED` panel item, orphaned follow-ups re-routed), remove worktrees whose WorkItem is terminal or unknown.
  - Evaluation retries are capped: `Trigger.evaluationAttempts`; at `max_evaluation_attempts` (3) the trigger is REJECTED with an `EVALUATION_FAILED` panel item. `start()` first calls `EvaluateTriggerUseCase.recoverInterrupted()` (EVALUATING → PENDING, counted). Assumes one runtime process per database.
  - `SessionStorePort.listSessionsByStatus` added (both stores; contract-tested).
- Worker tools: run on the host in a per-WorkItem git worktree. Fixed tool set only: `read_file`, `list_files`, `search`, `write_file`, `run_tests` (command from config), `commit_and_push` (own branch only), `open_pr`. Paths are confined to the worktree; no general shell.
- First source: GitHub, polling (`fetchEvents` every N s; no public URL needed). `explicitRequest` = bot @-mentioned, assigned, or a configured label. `reply` = issue/PR comment; the bot login goes in `selfAuthorIds`. GitHub token and Anthropic credentials come from env / `ant auth`, never from config files.
- `apps/runtime/src/main.ts` + `config/casiagent.yaml`; `bun run start`; clean shutdown on SIGTERM.
- Also: abandon AWAITING WorkItems after N days (+ panel item); cap EVALUATING → PENDING retries (+ panel item).
- Tests: `bun run check` never calls the real API (stubbed `fetch`). One opt-in live smoke test behind an env var, which costs money: ask before running it.

**Commands**: `bun run check` = type-check + lint + architecture check + unawaited-assertion check (`scripts/check-tests.ts`) + tests. Must pass before a phase is considered done.

**Conventions**
- The repo root is the workspace root (no nested `casiagent/` folder).
- Named exports only. `interface` for object shapes. Status "enums" are `as const` objects + a derived union type (no TS `enum`).
- `packages/domain` compiles with `types: []`, so Bun/Node globals are a type error there, not just a lint issue. `bun run arch` enforces the Dependency Rule on imports, type-only imports included (rules in `scripts/architecture.ts`).
- Tests live in `packages/*/test/` and `apps/*/test/` and use `bun:test`. The roadmap's per-phase verify paths (e.g. `bun test packages/domain/src/services`) therefore map to `bun test packages/<pkg>`.
- IDs and timestamps are generated outside the domain (an `IdGenerator`/`Clock` port or the caller supplies them); domain code is deterministic.

**Gaps in the roadmap below, and how we resolve them** (ports grow in the phase that first needs them; record each extension here):
- _Status values_: Trigger uses `PENDING | EVALUATING | ACCEPTED | REJECTED | CONSUMED`, plus `OBSERVED` added in Phase 5. WorkItem uses `PENDING | RUNNING | COMPLETED | FAILED | ABANDONED` (Phase 3 refers to COMPLETED/ABANDONED). Session uses `ACTIVE | STALLED | COMPLETED | FAILED` (Phase 4 refers to STALLED).
- _Phase 1 (done)_: `SessionStorePort` gained `createTrigger` (insert-only), `loadTrigger`, `listTriggersByStatus`, `compareAndSetTrigger(expectedStatus, next)` (atomic replace-if-status-matches; every Trigger update goes through it — renamed and widened in Phase 2 so decisions are stored atomically with the status) and `saveWorkItem/loadWorkItem`. Any persistent adapter must keep `createTrigger` insert-only and the CAS atomic.
- _Phase 1 (done)_: "Spawning" a Worker = persisting an ACTIVE session. `DispatchWorkUseCase` returns `DispatchRecord`s and the caller runs `WorkerExecutionUseCase` for each. No spawner port.
- _Phase 1 (done)_: `SourcePort.reply(OutboundMessage)` added. `Trigger` gained `threadId?`, `authorId`, `authorIsBot` (copied from `SourceEvent`; Phase 2/3 need them). Trigger ids are `${sourceId}#${eventId}`, so intake is idempotent.
- _Phase 1 (done)_: Domain ports `IdGeneratorPort` and `ClockPort` added; adapters `UuidGenerator`, `SystemClock`, `InMemorySessionStore`.
- _Phase 1 (done)_: The Worker persists its result before replying; a failed reply is reported as `delivery: { delivered: false }`, never re-runs the task. A RUNNING WorkItem is resumed rather than rejected (for the Phase 4 Watchdog).
- _Phase 4 (done)_: The Phase 1 dispatch crash gap is closed at the source: `SessionStorePort.claimTriggerForWork(consumed, item, session)` claims the Trigger and creates the WorkItem and session atomically.
- _Phase 2 (done)_: Queue depth = ACCEPTED Triggers + PENDING/RUNNING WorkItems (`countWorkItemsByStatus` added to the store).
- _Phase 2 (done)_: `FilterRules` allow-lists are an explicit list or `"any"`; an empty list allows nothing. Config is compiled once by `createFilterRules` (bad regex fails at startup; patterns are case-insensitive, never `g`/`y`). Keywords match string values in the payload, up to 5 levels deep.
- _Phase 2 (done)_: The application renders the prompt (`application/src/prompts/evaluateTrigger.ts`, versioned), so `LlmPort.evaluateTrigger` takes `{ triggerId, promptVersion, prompt }`. The adapter's job is transport + parsing the JSON verdict; the use case still validates the verdict before acting. The payload is fenced as untrusted data and substitution is single-pass.
- _Phase 2 (done)_: An LLM error or invalid verdict sends the Trigger EVALUATING → PENDING (new transition) for retry. There is no retry limit yet; add one with Phase 4's escalation if needed.
- _Phase 2 (done)_: `Trigger.decision` records `{ stage, reason, priority }`. Dispatch orders ACCEPTED Triggers high → normal → low, then oldest first. `TriggerPriority` moved to `value-objects/`.
- _Phase 3 (done)_: The roadmap's flow (subscribe after opening a PR, keep the subscription until the WorkItem is terminal) needs the WorkItem to stay open after the PR exists. Added WorkItem `AWAITING` and Session `WAITING`; `WorkResult.status` is `DONE` (default) or `AWAITING_FEEDBACK`, and `WorkResult.artifacts` lists threads to subscribe to. Lifecycle: PENDING → RUNNING → (AWAITING ↔ RUNNING)* → COMPLETED | FAILED.
- _Phase 3 (done)_: Threads are keyed `ThreadKey = <sourceId>::<threadId>`. First Worker to subscribe keeps a thread. The Worker subscribes to the originating thread on start and to artifacts on AWAITING_FEEDBACK; all its subscriptions are removed on COMPLETED or FAILED.
- _Phase 3 (done)_: `routeEvent` returns DIRECT / ROUTER / IGNORED. IGNORED = authored by one of `selfAuthorIds`, which prevents the agent's own replies looping back to it. The caller delivers DIRECT events with `WorkerExecutionUseCase.deliverFollowUp`.
- _Phase 3 (done)_: Follow-ups go to a per-session inbox in `SessionStorePort` (`enqueueFollowUp` dedupes by event id; `drainFollowUps`; `countFollowUps`), separate from the Session record. WorkItem status changes use `compareAndSetWorkItem`; whoever moves AWAITING → RUNNING runs the Worker, others get QUEUED. The Worker re-checks the inbox after going AWAITING. Events that reach a finished WorkItem come back as `STALE` / `orphanedFollowUps`: the caller must re-route them (they go to the Router).
- _Still open_: an AWAITING WorkItem can wait forever (no timeout or ABANDONED path yet). WAITING sessions are deliberately not in `listActive`, so the Watchdog ignores them. A hung LLM call keeps heartbeating, so it is never "stalled"; add an LLM-call timeout in the adapter (Phase 6).
- _Phase 5 (done)_: DIRECT follow-ups are authorized as `FOLLOW_UP` actions in `SubscriptionRouter` (DENY → IGNORED, OBSERVE_ONLY → OBSERVED + observe log). Only `allowed_users` and `trusted_followup_authors` can reach a Worker.
- _Phase 4 (done)_: SQLite adapters (`openDatabase` + `PRAGMA user_version` migrations; never edit an applied migration) for sessions, triggers, work items, the follow-up inbox, subscriptions and context spill. Session context lives on `sessions.context_json` (the roadmap put it on `work_items`; our Session entity owns it). Every store is checked by a shared contract suite in `packages/adapters/test/contracts/`; a new store implementation must run it.
- _Phase 4 (done)_: `save` never moves `lastHeartbeatAt`/`restartCount` backwards, and `recordHeartbeat` updates only that field, so heartbeats and a Worker's saves never clobber each other and a stale copy cannot reset the restart count.
- _Phase 4 (done)_: `ContextManager` (budget, default 25% reserved for recall): the first message (the task) is never spilled; a pointer message `[context-spill] N earlier message(s)…` replaces spilled ones; an oversized newest message is truncated inline and spilled in full; before each run, spilled messages matching the latest user message are recalled into the working context (not persisted). Tokens are estimated at ~4 chars/token (`approximateTokens`, injectable).
- _Phase 4 (done)_: `IntervalWatchdog` (adapter) uses the pure domain `assessSessionHealth`. Stalled = no heartbeat for > 3 × interval; restart up to 3 times (STALLED, `restartCount+1`, grace period); then escalate: session FAILED, WorkItem FAILED (or ABANDONED if never started), subscriptions removed, `AttentionItem` raised via `AttentionSinkPort` (id `watchdog:<sessionId>`, idempotent). The composition root wires `onRestart` to `WorkerExecutionUseCase.execute`.
- _Phase 4 (done)_: Workers heartbeat during LLM calls via `SchedulerPort` (optional `heartbeat` dep). A restarted run and a slow original can overlap; the WorkItem compare-and-set lets exactly one result be saved, and the other run fails before replying.
- _Phase 5 (done)_: `SourceEvent`/`Trigger` gained `explicitRequest` (mention/DM/assignment; set by the source adapter). Authorization runs first in `EvaluateTriggerUseCase`: DENY → REJECTED; OBSERVE_ONLY → `OBSERVED` (terminal) + observe-log entry (`observe:<triggerId>`, written before the status change). No WorkItem is created for either.
- _Phase 5 (done)_: `RuleBasedAuthorization` + `loadAuthorizationConfig` (YAML via `Bun.YAML`, or JSON; strict validation). Rule scope defaults to `new_work`, so the roadmap's "CI failure → observe_only" rule does not block CI follow-ups to a Worker. `allow` on inferred work is forced to observe-only; only `auto_act` lets proactive work run; `defaults.inferred` may not be `allow`. Example: `config/authorization.example.yaml` (tested).
- _Phase 5 (done)_: `PanelPort` (application) ← `AttentionPanelAdapter` (DB write into `SqliteAttentionStore`). The Worker raises WORKER_FAILED, DELIVERY_FAILED, and QUESTION/REVIEW_REQUEST (from `WorkResult.attention`); the Watchdog raises WATCHDOG_ESCALATION. Healthy work raises nothing.
- _Phase 5 (done)_: `BunPanelServer`: binds 127.0.0.1 by default, optional bearer token (open the page with `#token=…`), strict CSP, untrusted text rendered via `textContent` only, resolve requires JSON + same Origin (CSRF). Endpoints as in the roadmap; resolve returns 200/404/409.
- _Phase 5 (done)_: `apps/runtime/src/createRuntime.ts` is the composition root. `start()` recovers PENDING triggers and undispatched ACCEPTED ones, subscribes sources, starts the Watchdog and panel. STALE follow-ups: the stale subscription is dropped before re-routing; as a backstop an event re-routed more than 3 times is dropped and raised as `ROUTING_LOOP`.
- _Not covered by any phase_: real `LlmPort` (Claude API) and `SourcePort` (e.g. GitHub) adapters. Add them as a Phase 6 once Phase 5 is done.
- The two reference projects named below have not been checked; treat them as unconfirmed.

---

## Foundational Design Decisions (Before Writing Code)

- **Dependency Rule**: Inner layers (Domain, Use Cases) must not import from outer layers (Infrastructure, Adapters). Dependencies point inward.
- **Ports & Adapters**: The Domain defines interfaces (ports); Bun/Node, GitHub, LLM providers, and persistence are adapters injected at composition time.
- **Project Structure**: A Bun workspace monorepo with `packages/domain`, `packages/application`, `packages/adapters`, and `apps/runtime` (the composition root). This isolates the Router/Worker logic from external I/O.

The official **`dsh-superagent-prototype`** is MIT-licensed TypeScript and serves as the architectural reference. The **`LofiSu/deepseek-super-agent`** project shows a thin-harness alternative with the same Router/Worker + Trigger + Watchdog decomposition. Your build should follow the _same decomposition_ but implement it independently in Clean Architecture.

---

## Phase 0: Monorepo Scaffolding & Shared Kernel

**Goal**: Establish the Bun workspace, TypeScript strict config, and the shared domain kernel (types, ports) that every other package depends on.

**Claude Code Prompt**:

> **Context**: We are building a SuperAgent-like system from scratch using Bun and TypeScript. The architecture is a Clean Architecture monorepo with four packages: `domain` (entities, value objects, ports), `application` (use cases), `adapters` (infrastructure implementations), and `apps/runtime` (composition root). This is Phase 0: scaffolding and shared kernel.
>
> **Task**: Initialize the Bun monorepo with the following exact structure:
>
> ```
> ./ (repo root)
> ├── package.json (workspaces: packages/*, apps/*)
> ├── tsconfig.base.json (strict: true, module: ESNext, moduleResolution: Bundler)
> ├── biome.json
> ├── packages/
> │   ├── domain/
> │   │   ├── package.json (name: "@casiagent/domain")
> │   │   ├── tsconfig.json
> │   │   └── src/
> │   │       ├── index.ts
> │   │       ├── entities/ (WorkItem.ts, Session.ts, Trigger.ts)
> │   │       ├── value-objects/ (TaskStatus.ts, SessionId.ts, SourceId.ts)
> │   │       └── ports/ (SourcePort.ts, LlmPort.ts, SessionStorePort.ts, WatchdogPort.ts)
> │   ├── application/ (use cases, depends only on domain)
> │   └── adapters/ (depends on domain + application, implements ports)
> └── apps/
>     └── runtime/ (composition root, wiring)
> ```
>
> **Clean Architecture constraints**:
> - `packages/domain` must have **zero** dependencies on external libraries or other workspace packages.
> - Define the `Trigger` entity with fields: `id`, `sourceId`, `payload`, `timestamp`, `status` (enum: `PENDING`, `EVALUATING`, `ACCEPTED`, `REJECTED`, `CONSUMED`).
> - Define `WorkItem` with fields: `id`, `triggerId`, `assignedWorkerId?`, `status`, `result?`.
> - Define ports as TypeScript interfaces: `SourcePort` (subscribe, fetchEvents), `LlmPort` (evaluateTrigger, executeTask), `SessionStorePort` (save, load, listActive), `WatchdogPort` (start, stop, heartbeat).
> - Use **named exports** only. No default exports. Interface over type for object shapes.
>
> **Bun commands** to verify: `bun install`, `bun run type-check`, `bun run lint`.

---

## Phase 1: Router/Worker Split & Task Dispatch

**Goal**: The foundational concurrency model. A persistent Router receives events, creates WorkItems, and dispatches them to isolated Worker sessions. Workers execute independently and report back.

**Claude Code Prompt**:

> **Context**: Phase 1 of the SuperAgent build. The monorepo from Phase 0 is in place. We are now implementing the core Router/Worker split in the `application` and `domain` packages.
>
> **Task**: Implement the following use cases in `packages/application/src/use-cases/`:
> 1. **`IntakeTriggerUseCase`**: Receives a raw event from any SourcePort, maps it to a `Trigger` entity (status `PENDING`), and persists it via `SessionStorePort`. It must not perform LLM evaluation yet — only structural intake.
> 2. **`DispatchWorkUseCase`**: Reads accepted `Trigger` entities (status `ACCEPTED`), creates a `WorkItem` for each, assigns an isolated `workerId` (generated UUID), and spawns a Worker via the `SessionStorePort`. Each WorkItem gets its own **isolated context** — never share mutable state between WorkItems.
> 3. **`WorkerExecutionUseCase`**: Given a `WorkItem` and its assigned `workerId`, calls `LlmPort.executeTask()` with a **Worker-scoped context window**. The context must contain only the WorkItem data, not global Router state. On completion, update WorkItem status and write the result back to the originating SourcePort (e.g., post a PR comment).
>
> **Clean Architecture constraints**:
> - `DispatchWorkUseCase` must depend only on `SessionStorePort` and `WorkItem` domain entities — no direct Bun/Node APIs.
> - The Worker's context isolation is enforced by the `SessionStorePort` implementation (adapter layer), not by the use case itself.
> - Add a `RouterState` value object (immutable) that the Router uses to track dispatched work, but **never** passes to Workers.
>
> **Testing**: Write unit tests for all three use cases using `bun:test`. Mock `SessionStorePort` and `LlmPort` with in-memory fakes. Verify that two concurrent `DispatchWorkUseCase` calls produce two distinct `workerId`s and isolated contexts.

---

## Phase 2: Event-Driven Triggers & Two-Stage Filtering

**Goal**: The system observes its environment and acts proactively, but without noise. A fast programmatic filter discards irrelevant events; only ambiguous events reach an LLM for semantic evaluation.

**Claude Code Prompt**:

> **Context**: Phase 2 of the SuperAgent build. The Router/Worker split is working. Now we add event-driven triggers with a two-stage filtering pipeline, implemented as a use case that composes a deterministic filter and an LLM-based evaluator.
>
> **Task**: Implement `EvaluateTriggerUseCase` in `packages/application/src/use-cases/` with the following pipeline:
>
> **Stage 1 — Deterministic Filter (Fast Path)**:
> - Create a pure function `fastFilter(trigger: Trigger, rules: FilterRules): FilterResult` in `packages/domain/src/services/`.
> - `FilterRules` include: `allowedSourceIds`, `allowedUserIds`, `keywordPatterns`, `ignoreBots` (boolean).
> - Return `DISCARD` if the event fails any rule. Return `PASS` if it matches a deterministic allow-rule. Return `AMBIGUOUS` if rules are inconclusive.
> - `fastFilter` must be **synchronous and side-effect free** — no I/O, no LLM calls.
>
> **Stage 2 — Semantic Evaluator (Slow Path)**:
> - Only `AMBIGUOUS` triggers reach `LlmPort.evaluateTrigger()`. The prompt must include: the trigger payload, the team's written authorization rules (from config), and the current work queue depth (to avoid overload).
> - The LLM returns a structured verdict: `{ accepted: boolean, reason: string, priority: "low" | "normal" | "high" }`.
>
> **Use Case orchestration**:
> - `EvaluateTriggerUseCase` first calls `fastFilter`. If `DISCARD`, update Trigger status to `REJECTED` and return. If `PASS`, update to `ACCEPTED` immediately. If `AMBIGUOUS`, call the LLM and update based on the verdict.
> - The use case depends on `LlmPort` (injected), not on any specific LLM provider.
>
> **Clean Architecture constraints**:
> - `fastFilter` lives in the Domain layer as a pure service. It must not import from `application` or `adapters`.
> - The LLM prompt template should be externalized as a string constant in `packages/application/src/prompts/` so it can be versioned independently.
>
> **Testing**: Unit-test `fastFilter` with a table of 20+ rule/payload combinations. Use a fake `LlmPort` that returns predefined verdicts and assert that the use case transitions Trigger status correctly.

---

## Phase 3: Subscription & Direct Routing (Pass-Through)

**Goal**: Once a Worker owns a task, subsequent events on that task (new comments, CI results) bypass the Router and go **directly** to the responsible Worker. This eliminates Router round-trips and reduces token usage.

**Claude Code Prompt**:

> **Context**: Phase 3 of the SuperAgent build. Workers are executing tasks, but every follow-up event still routes through the Router. We need subscription-based direct routing so that a Worker subscribed to a WorkItem receives related events without Router mediation.
>
> **Task**: Implement `SubscriptionRouter` in `packages/application/src/services/`:
>
> 1. **Subscription Registry**: A `SubscriptionRegistry` class (in the application layer) that maps `sourceThreadId` → `workerId`. When a Worker starts a WorkItem, it registers the originating thread (e.g., GitHub PR number, chat thread ID) with its `workerId`.
> 2. **Routing Logic**: Implement `routeEvent(event: SourceEvent): RoutingDecision` where `RoutingDecision` is either `{ type: "DIRECT", workerId: string }` or `{ type: "ROUTER", trigger: Trigger }`.
>    - If the event's `threadId` exists in the registry, return `DIRECT` with the subscribed `workerId`.
>    - Otherwise, return `ROUTER` and create a new `Trigger` for normal evaluation.
   3. **Worker-Side Subscription**: Extend `WorkerExecutionUseCase` so that after a Worker creates a pull request (or equivalent reviewable artifact), it calls `SubscriptionRegistry.subscribe(threadId, workerId)`. The subscription persists until the WorkItem reaches a terminal status (`COMPLETED` or `ABANDONED`).
> 3. **Unsubscription**: When a WorkItem completes, remove its subscription. Stale subscriptions must not accumulate.
>
> **Clean Architecture constraints**:
> - `SubscriptionRegistry` is an application-layer service, not a domain entity. It holds **routing state** that is ephemeral to the routing decision.
> - The registry can be backed by an in-memory Map for the first implementation. Define a `SubscriptionStorePort` in the domain so a persistent adapter can replace it later without touching the application layer.
> - `routeEvent` must be deterministic given the registry state — no LLM calls in the routing path.
>
> **Testing**: Simulate a sequence: Worker subscribes to `thread-A` → event on `thread-A` → assert `DIRECT` routing to the correct worker. Assert that after unsubscription, the same event routes to `ROUTER`.

---

## Phase 4: Persistence, Context Spill & Watchdog Self-Healing

**Goal**: The system survives crashes, runs unattended, and keeps context windows bounded. Persist session state externally, spill oversized context to a store, and run a Watchdog that restarts stalled sessions from persisted state.

**Claude Code Prompt**:

> **Context**: Phase 4 of the SuperAgent build. The system is functional but in-memory. It cannot survive process restarts, and Workers risk context-window overflow on long tasks. We need persistence, context spill, and a Watchdog.
>
> **Task**: Implement three independent mechanisms in the `adapters` and `application` layers:
>
> **A. Session Persistence (`SessionStorePort` adapter)**:
> - Implement `SqliteSessionStore` using Bun's built-in `bun:sqlite`. Tables: `sessions` (id, worker_id, status, created_at, updated_at), `work_items` (id, session_id, context_json, status), `triggers` (id, source_id, payload_json, status).
> - `save(session)` and `load(sessionId)` must round-trip the full session state, including the Worker's inline context.
>
> **B. Context Spill & Chain-of-Recall**:
> - In `packages/application/src/services/`, create `ContextManager`:
>   - `inlineContext`: the immediate context kept in the LLM window (bounded by a token budget).
>   - `spillContext`: when inline context exceeds the budget, serialize the oldest messages to a `ContextSpillPort` (adapter: SQLite or file store) and keep only a reference/pointer in the inline context.
>   - `recall(sessionId, query)`: retrieve relevant spilled context via a simple keyword match or vector similarity (start with keyword; the port allows swapping).
  - The Worker's `executeTask` call must use `ContextManager.getWorkingContext()` instead of raw session context.
>
> **C. Watchdog (`WatchdogPort` adapter)**:
> - Implement `IntervalWatchdog` in `adapters/watchdog/` using `setInterval` (Bun native).
> - Every 30 seconds, list active sessions from `SessionStorePort`. For each session, check `lastHeartbeatAt`. If a session has not heartbeated for > 3× the watchdog interval, mark it as `STALLED`, then **restart** it: load the persisted session state and re-invoke `WorkerExecutionUseCase` with that state.
> - The Watchdog must **not** restart a session more than 3 times; after 3 failed restarts, escalate by creating a `NeedsHumanAttention` event in the panel store.
>
> **Clean Architecture constraints**:
> - The `ContextManager` orchestrates ports but is itself a pure application service.
> - `IntervalWatchdog` is an adapter — it depends on `WatchdogPort` (domain) and `SessionStorePort` (domain), not on application use cases directly. The composition root wires the restart callback.
>
> **Testing**: Simulate a crash by killing the session process mid-execution. Assert that the Watchdog restarts it and the WorkItem eventually completes. Test context spill by feeding 10,000 tokens of context with a 2,000-token budget and asserting that only the budgeted portion remains inline.

---

## Phase 5: Authorization, Attention Minimization & Human-in-the-Loop

**Goal**: Enforce the operating philosophy: act only when authorized, speak only when a human must act. Proactive inferred work starts in **observe mode** (logs what it _would_ do) before auto-action is enabled.

**Claude Code Prompt**:

> **Context**: Phase 5 (final) of the SuperAgent build. The system is persistent, self-healing, and event-driven. The final layer is the authorization model and attention-minimization interface that makes it safe for a team.
>
> **Task**: Implement the following in the `application` and `adapters` layers:
>
> **A. Authorization Gate (`AuthorizationPort`)**:
> - Define `AuthorizationPort` in the domain: `canAct(userId: string, sourceId: string, action: Action): AuthorizationVerdict`.
> - `AuthorizationVerdict` is one of `ALLOW`, `DENY`, or `OBSERVE_ONLY`.
> - Implement a `RuleBasedAuthorization` adapter that reads a YAML/JSON config:
>
>   ```yaml
>   allowed_users: ["alice", "bob"]
>   allowed_sources: ["github:org/repo"]
>   rules:
>     - pattern: "fix bug|reproduce issue"
>       action: allow
>       scope: explicit_request
>     - pattern: "CI failure"
>       action: observe_only  # logs but does not act
>   ```
> - In `EvaluateTriggerUseCase`, the **first** step (before `fastFilter`) must call `AuthorizationPort.canAct()`. If `DENY`, reject immediately. If `OBSERVE_ONLY`, record the Trigger as `OBSERVED` (a terminal status) and log what would have been done — **do not** create a WorkItem.
>
> **B. Observe Mode for Proactive Work**:
> - For any trigger that was not an explicit human request (e.g., inferred from a group chat), force `OBSERVE_ONLY` regardless of other rules, unless a specific `auto_act` rule exists for that pattern.
> - Observed triggers are written to a `observe_log` table with the intended action and rationale, visible in the panel.
>
> **C. Web Panel (`PanelPort`)**:
> - Implement a minimal Bun HTTP server (`Bun.serve`) adapter that serves a read-only JSON API and a static HTML panel.
> - The panel shows **only** items requiring human attention: `NeedsHumanAttention` events (questions, review requests, failures after 3 Watchdog restarts). Healthy WorkItems in progress are **not** shown — the system stays quiet unless it matters.
> - Endpoints: `GET /api/attention-items`, `GET /api/observe-log`, `POST /api/attention-items/:id/resolve`.
>
> **Clean Architecture constraints**:
> - `AuthorizationPort` is domain; the YAML adapter is infrastructure. The use case never reads YAML directly.
> - The `PanelPort` is an application-layer output port. The Bun HTTP server is an adapter. The application layer defines `PanelPort.showAttentionItem()`; the adapter implements it as an HTTP push or a database write that the server reads.
> - The composition root wires all adapters: `RuleBasedAuthorization`, `SqliteSessionStore`, `IntervalWatchdog`, `BunPanelAdapter`.

---

## Summary: Phases at a Glance

| Phase | Focus                       | Key Clean Architecture Artifact                            | Claude Code Verify Command                   |
| :---- | :-------------------------- | :--------------------------------------------------------- | :------------------------------------------- |
| **0** | Scaffolding & Shared Kernel | `packages/domain/` (entities, ports)                       | `bun run type-check`                         |
| **1** | Router/Worker Split         | `IntakeTriggerUseCase`, `DispatchWorkUseCase`              | `bun test packages/application`              |
| **2** | Two-Stage Triggers          | `fastFilter` (domain service), `EvaluateTriggerUseCase`    | `bun test packages/domain/src/services`      |
| **3** | Subscription Pass-Through   | `SubscriptionRegistry`, `routeEvent`                       | `bun test packages/application/src/services` |
| **4** | Persistence & Watchdog      | `SqliteSessionStore`, `ContextManager`, `IntervalWatchdog` | `bun test packages/adapters`                 |
| **5** | Authorization & Attention   | `AuthorizationPort`, `RuleBasedAuthorization`, `PanelPort` | `bun run check` (full pipeline)              |

Each prompt is designed to be given to Claude Code **sequentially**. After each phase, run `bun run type-check && bun test && bun run lint` before proceeding. The Dependency Rule is the non-negotiable invariant: if a Domain file ever imports from `bun`, `node:fs`, or `adapters/`, the build is architecturally broken — fix it before moving on.
