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
} from "@superagent/adapters";
import {
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
} from "@superagent/application";
import {
	type ClockPort,
	createFilterRules,
	type FilterRulesConfig,
	type IdGeneratorPort,
	type LlmPort,
	RouterState,
	type SourceEvent,
	type SourceId,
	type SourcePort,
	TriggerStatus,
	type Unsubscribe,
} from "@superagent/domain";

export interface RuntimeConfig {
	/** SQLite file path, or ":memory:". */
	readonly databasePath: string;
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
	readonly parts: ReturnType<typeof wire>;
}

/** Composition root: the only place that knows every concrete adapter. */
function wire(config: RuntimeConfig) {
	const clock = config.clock ?? new SystemClock();
	const ids = config.ids ?? new UuidGenerator();
	const db = openDatabase(config.databasePath);

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
		worker,
		watchdog,
		panel,
		sources,
		restarts,
	};
}

function defaultOnError(error: unknown, context: string): void {
	console.error(`[superagent] ${context}:`, error);
}

export function createRuntime(config: RuntimeConfig): Runtime {
	const parts = wire(config);
	const { router, evaluate, dispatch, worker, registry, store, watchdog, panel } = parts;
	const onError = config.onError ?? defaultOnError;
	const inFlight = new Set<Promise<unknown>>();
	const unsubscribes: Unsubscribe[] = [];
	let routerState = RouterState.empty();

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

	async function idle(): Promise<void> {
		while (inFlight.size > 0 || parts.restarts.size > 0) {
			await Promise.allSettled([...inFlight, ...parts.restarts]);
		}
	}

	return {
		parts,
		handleEvent,
		idle,
		async start() {
			// Recover work left by a previous process: unevaluated or retry-pending triggers,
			// and accepted ones never dispatched. Stalled sessions are the Watchdog's job.
			for (const t of await store.listTriggersByStatus(TriggerStatus.PENDING)) {
				track(`recover trigger ${t.id}`, () => processTrigger(t.id));
			}
			track("recover dispatch", dispatchAndRun);
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
			watchdog.stop();
			await panel?.stop();
			await idle();
			parts.db.close();
		},
	};
}
