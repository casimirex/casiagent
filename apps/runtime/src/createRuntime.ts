import type { Database } from "bun:sqlite";
import {
	AttentionPanelAdapter,
	type AuthorizationConfig,
	BunPanelServer,
	IntervalWatchdog,
	openDatabase,
	RuleBasedAuthorization,
	SqliteAttentionStore,
	SqliteContextSpillStore,
	SqliteObserveLog,
	SqliteSessionStore,
	SqliteSubscriptionStore,
	SystemClock,
	TimerScheduler,
	UuidGenerator,
} from "@casiagent/adapters";
import {
	AbandonStaleWorkUseCase,
	ContextManager,
	DispatchWorkUseCase,
	EvaluateTriggerUseCase,
	type FollowUpOutcome,
	IntakeTriggerUseCase,
	type RoutingDecision,
	SubscriptionRegistry,
	SubscriptionRouter,
	type WorkerAssignment,
	WorkerExecutionUseCase,
} from "@casiagent/application";
import {
	type ClockPort,
	createFilterRules,
	type FilterRulesConfig,
	type IdGeneratorPort,
	isTerminalWorkItem,
	type LlmPort,
	RouterState,
	type SourceEvent,
	type SourceId,
	type SourcePort,
	TriggerStatus,
	type Unsubscribe,
} from "@casiagent/domain";

/** Per-task workspaces the runtime cleans up once their WorkItem has finished. */
export interface WorkspaceCleaner {
	/** WorkItem ids that currently have a workspace. */
	list(): Promise<readonly string[]>;
	remove(workItemId: string): Promise<void>;
}

export interface RuntimeConfig {
	/** SQLite file path, or ":memory:". Ignored when `database` is given. */
	readonly databasePath?: string;
	/** An already-open database (e.g. shared with a source's cursor store). The runtime closes it on stop. */
	readonly database?: Database;
	/** Removed by the maintenance pass when their WorkItem is finished. */
	readonly workspaces?: WorkspaceCleaner;
	/** How often maintenance runs (retries, dispatch, abandonment, cleanup). Default 60 s. */
	readonly maintenanceIntervalMs?: number;
	readonly authorization: AuthorizationConfig;
	readonly filterRules: FilterRulesConfig;
	/** The team's written rules, given to the LLM when a trigger is ambiguous. */
	readonly authorizationRules: string;
	/** Author ids the agent posts as; their events are ignored to prevent loops. */
	readonly selfAuthorIds: readonly string[];
	readonly llm: LlmPort;
	readonly sources: readonly SourcePort[];
	/** Default 100,000. */
	readonly contextBudgetTokens?: number;
	readonly limits?: {
		/** LLM evaluation failures before a trigger is rejected. Default 3. */
		readonly maxEvaluationAttempts?: number;
		/** How long work may wait for feedback before it is abandoned. Default 7 days. */
		readonly abandonAwaitingAfterMs?: number;
	};
	readonly watchdog?: { readonly intervalMs?: number; readonly maxRestarts?: number };
	/** `false` disables the panel. Defaults: 127.0.0.1, a free port, no token. */
	readonly panel?:
		| false
		| { readonly port?: number; readonly hostname?: string; readonly token?: string };
	/** Background failures. Default: console.error. */
	readonly onError?: (error: unknown, context: string) => void;
	/** For tests. */
	readonly clock?: ClockPort;
	readonly ids?: IdGeneratorPort;
}

export interface Runtime {
	/** Route one event and start processing it. Resolves with the routing decision. */
	handleEvent(event: SourceEvent): Promise<RoutingDecision>;
	/** Recover unfinished work, subscribe to sources, start the Watchdog and panel. */
	start(): Promise<{ readonly panelUrl?: URL }>;
	/** Stop intake, wait for in-flight work, close the database. */
	stop(): Promise<void>;
	/** Resolves when no background work is in flight. */
	idle(): Promise<void>;
	/**
	 * One maintenance pass: retry PENDING triggers, dispatch ACCEPTED ones, abandon work
	 * that waited too long, and remove workspaces of finished WorkItems. Runs on a timer
	 * after start(); public for tests and operators.
	 */
	maintain(): Promise<void>;
	readonly parts: ReturnType<typeof wire>;
}

/** Composition root: the only place that knows every concrete adapter. */
function wire(config: RuntimeConfig) {
	const clock = config.clock ?? new SystemClock();
	const ids = config.ids ?? new UuidGenerator();
	if (config.database === undefined && config.databasePath === undefined) {
		throw new Error("RuntimeConfig needs databasePath or database");
	}
	const db = config.database ?? openDatabase(config.databasePath as string);

	const store = new SqliteSessionStore(db);
	const subscriptionStore = new SqliteSubscriptionStore(db);
	const attention = new SqliteAttentionStore(db);
	const observeLog = new SqliteObserveLog(db);
	const authorization = new RuleBasedAuthorization(config.authorization);
	const sources = new Map<SourceId, SourcePort>(config.sources.map((s) => [s.sourceId, s]));
	const registry = new SubscriptionRegistry({ store: subscriptionStore, clock });

	const intake = new IntakeTriggerUseCase({ store });
	const router = new SubscriptionRouter({
		registry,
		intake,
		selfAuthorIds: new Set(config.selfAuthorIds),
		authorization,
		observeLog,
		clock,
	});
	const evaluate = new EvaluateTriggerUseCase({
		store,
		authorization,
		observeLog,
		clock,
		llm: config.llm,
		rules: createFilterRules(config.filterRules),
		authorizationRules: config.authorizationRules,
		panel: new AttentionPanelAdapter(attention),
		...(config.limits?.maxEvaluationAttempts === undefined
			? {}
			: { maxEvaluationAttempts: config.limits.maxEvaluationAttempts }),
	});
	const dispatch = new DispatchWorkUseCase({ store, ids, clock });

	const watchdogInterval = config.watchdog?.intervalMs ?? 30_000;
	// The Watchdog's restart callback needs the worker, and the worker heartbeats through the
	// Watchdog; the late-bound reference breaks that cycle.
	let worker: WorkerExecutionUseCase | undefined;
	const restarts = new Set<Promise<unknown>>();
	const watchdog = new IntervalWatchdog({
		store,
		subscriptions: subscriptionStore,
		attention,
		clock,
		intervalMs: watchdogInterval,
		...(config.watchdog?.maxRestarts === undefined
			? {}
			: { maxRestarts: config.watchdog.maxRestarts }),
		onRestart: (s) => {
			if (worker === undefined) return Promise.resolve();
			const assignment: WorkerAssignment = {
				workItemId: s.workItemId,
				workerId: s.workerId,
				sessionId: s.id,
			};
			const run = worker.execute(assignment);
			restarts.add(run);
			void run.finally(() => restarts.delete(run)).catch(() => {});
			return run;
		},
		onError: (error, s) => (config.onError ?? defaultOnError)(error, `watchdog restart of ${s.id}`),
	});
	worker = new WorkerExecutionUseCase({
		store,
		llm: config.llm,
		sources,
		subscriptions: registry,
		context: new ContextManager({
			spill: new SqliteContextSpillStore(db),
			budgetTokens: config.contextBudgetTokens ?? 100_000,
		}),
		panel: new AttentionPanelAdapter(attention),
		clock,
		heartbeat: { watchdog, scheduler: new TimerScheduler(), intervalMs: watchdogInterval },
	});

	const abandon = new AbandonStaleWorkUseCase({
		store,
		subscriptions: registry,
		panel: new AttentionPanelAdapter(attention),
		clock,
		...(config.limits?.abandonAwaitingAfterMs === undefined
			? {}
			: { maxAwaitMs: config.limits.abandonAwaitingAfterMs }),
	});

	const panel =
		config.panel === false
			? undefined
			: new BunPanelServer({
					attention,
					observeLog,
					clock,
					...(config.panel?.port === undefined ? {} : { port: config.panel.port }),
					...(config.panel?.hostname === undefined ? {} : { hostname: config.panel.hostname }),
					...(config.panel?.token === undefined ? {} : { token: config.panel.token }),
				});

	return {
		db,
		clock,
		store,
		subscriptionStore,
		attention,
		observeLog,
		authorization,
		registry,
		router,
		evaluate,
		dispatch,
		abandon,
		worker,
		watchdog,
		panel,
		sources,
		restarts,
	};
}

function defaultOnError(error: unknown, context: string): void {
	console.error(`[casiagent] ${context}:`, error);
}

export function createRuntime(config: RuntimeConfig): Runtime {
	const parts = wire(config);
	const { router, evaluate, dispatch, abandon, worker, registry, store, watchdog, panel } = parts;
	const onError = config.onError ?? defaultOnError;
	const inFlight = new Set<Promise<unknown>>();
	const unsubscribes: Unsubscribe[] = [];
	let routerState = RouterState.empty();
	let maintenanceTimer: ReturnType<typeof setInterval> | undefined;
	let maintaining = false;

	/** Run in the background; failures go to onError, never to the caller. */
	function track(context: string, work: () => Promise<unknown>): void {
		const p = work().catch((error: unknown) => onError(error, context));
		inFlight.add(p);
		void p.finally(() => inFlight.delete(p));
	}

	/**
	 * Backstop against routing loops: an event handed back for re-routing more than this
	 * many times is dropped and raised on the panel. Normal operation needs at most one.
	 */
	const MAX_REROUTES = 3;

	async function reroute(events: readonly SourceEvent[], depth: number): Promise<void> {
		for (const event of events) {
			if (depth > MAX_REROUTES) {
				await parts.attention.raise({
					id: `routing-loop:${event.sourceId}#${event.id}`,
					kind: "ROUTING_LOOP",
					message: `Event ${event.id} on ${event.sourceId} was re-routed ${depth} times and has been dropped.`,
					createdAt: parts.clock.now(),
				});
				onError(new Error(`routing loop for event ${event.id}`), "reroute");
				continue;
			}
			await routeAndProcess(event, depth);
		}
	}

	async function afterFollowUp(
		outcome: FollowUpOutcome,
		workerId: string,
		depth: number,
	): Promise<void> {
		if (outcome.status === "STALE") {
			// The subscription outlived its WorkItem (e.g. a crash before unsubscribing).
			// Drop it first, or re-routing would send these events straight back here.
			await registry.unsubscribeWorker(workerId);
			await reroute(outcome.events, depth + 1);
		} else if (outcome.status === "COMPLETED" || outcome.status === "FAILED") {
			await reroute(outcome.orphanedFollowUps, depth + 1);
		}
	}

	async function dispatchAndRun(): Promise<void> {
		const { state, dispatched } = await dispatch.execute(routerState);
		routerState = state;
		for (const record of dispatched) {
			track(`worker ${record.workerId}`, async () =>
				afterFollowUp(await worker.execute(record), record.workerId, 0),
			);
		}
	}

	async function processTrigger(triggerId: string): Promise<void> {
		const outcome = await evaluate.execute(triggerId);
		if (outcome.status === "ACCEPTED") await dispatchAndRun();
	}

	function handleEvent(event: SourceEvent): Promise<RoutingDecision> {
		return routeAndProcess(event, 0);
	}

	async function routeAndProcess(event: SourceEvent, depth: number): Promise<RoutingDecision> {
		const decision = await router.routeEvent(event);
		if (decision.type === "DIRECT") {
			track(`follow-up ${event.id}`, async () =>
				afterFollowUp(
					await worker.deliverFollowUp(decision.subscription, event),
					decision.workerId,
					depth,
				),
			);
		} else if (decision.type === "ROUTER") {
			track(`trigger ${decision.trigger.id}`, () => processTrigger(decision.trigger.id));
		}
		return decision;
	}

	async function maintain(): Promise<void> {
		if (maintaining) return;
		maintaining = true;
		try {
			for (const t of await store.listTriggersByStatus(TriggerStatus.PENDING)) {
				await processTrigger(t.id).catch((e: unknown) => onError(e, `retry trigger ${t.id}`));
			}
			await dispatchAndRun();
			const { orphanedFollowUps } = await abandon.execute();
			await reroute(orphanedFollowUps, 1);
			if (config.workspaces !== undefined) {
				for (const id of await config.workspaces.list()) {
					const item = await store.loadWorkItem(id);
					if (item === undefined || isTerminalWorkItem(item)) {
						await config.workspaces
							.remove(id)
							.catch((e: unknown) => onError(e, `remove workspace ${id}`));
					}
				}
			}
		} finally {
			maintaining = false;
		}
	}

	async function idle(): Promise<void> {
		while (inFlight.size > 0 || parts.restarts.size > 0) {
			await Promise.allSettled([...inFlight, ...parts.restarts]);
		}
	}

	return {
		parts,
		handleEvent,
		idle,
		maintain,
		async start() {
			// Recover work left by a previous process: evaluations it was in the middle of,
			// unevaluated or retry-pending triggers, and accepted ones never dispatched.
			// Stalled sessions are the Watchdog's job.
			await evaluate.recoverInterrupted();
			track("maintenance", maintain);
			maintenanceTimer = setInterval(
				() => track("maintenance", maintain),
				config.maintenanceIntervalMs ?? 60_000,
			);
			for (const source of config.sources) {
				unsubscribes.push(
					source.subscribe((event) => {
						track(`event ${event.id}`, () => handleEvent(event));
					}),
				);
			}
			watchdog.start();
			const panelUrl = panel?.start();
			return panelUrl === undefined ? {} : { panelUrl };
		},
		async stop() {
			for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
			clearInterval(maintenanceTimer);
			watchdog.stop();
			await panel?.stop();
			await idle();
			parts.db.close();
		},
	};
}
