import {
	ActionOrigin,
	AuthorizationDecision,
	type AuthorizationPort,
	type ClockPort,
	type ObserveLogPort,
	payloadText,
	type SourceEvent,
	type Subscription,
	type Trigger,
} from "@superagent/domain";
import type { IntakeTriggerUseCase } from "../use-cases/IntakeTriggerUseCase";
import type { SubscriptionRegistry } from "./SubscriptionRegistry";

export type RoutingDecision =
	/** The thread has an owner: deliver with WorkerExecutionUseCase.deliverFollowUp. */
	| { readonly type: "DIRECT"; readonly workerId: string; readonly subscription: Subscription }
	/** No owner: a Trigger was taken in (or already existed) for normal evaluation. */
	| { readonly type: "ROUTER"; readonly trigger: Trigger; readonly created: boolean }
	/** Dropped before routing. */
	| { readonly type: "IGNORED"; readonly reason: string }
	/** A follow-up the author may not direct at the Worker in action; logged, not delivered. */
	| { readonly type: "OBSERVED"; readonly reason: string };

export interface SubscriptionRouterDeps {
	readonly registry: SubscriptionRegistry;
	readonly intake: IntakeTriggerUseCase;
	/**
	 * Author ids the agent itself posts as. Its own replies come back as events on the
	 * threads it subscribed to; routing them to the Worker would loop forever.
	 */
	readonly selfAuthorIds: ReadonlySet<string>;
	/** Gates DIRECT follow-ups, which skip the Router's filters. */
	readonly authorization: AuthorizationPort;
	readonly observeLog: ObserveLogPort;
	readonly clock: ClockPort;
}

/**
 * Decides where an inbound event goes, from registry state alone (no LLM).
 *
 * DIRECT events skip the Router's filters (so CI bots can reach the Worker), but are still
 * authorized as FOLLOW_UP actions: otherwise anyone able to comment on the Worker's PR
 * could instruct it. ROUTER events are authorized later, in EvaluateTriggerUseCase.
 */
export class SubscriptionRouter {
	readonly #registry: SubscriptionRegistry;
	readonly #intake: IntakeTriggerUseCase;
	readonly #selfAuthorIds: ReadonlySet<string>;
	readonly #authorization: AuthorizationPort;
	readonly #observeLog: ObserveLogPort;
	readonly #clock: ClockPort;

	constructor(deps: SubscriptionRouterDeps) {
		this.#registry = deps.registry;
		this.#intake = deps.intake;
		this.#selfAuthorIds = deps.selfAuthorIds;
		this.#authorization = deps.authorization;
		this.#observeLog = deps.observeLog;
		this.#clock = deps.clock;
	}

	async routeEvent(event: SourceEvent): Promise<RoutingDecision> {
		if (this.#selfAuthorIds.has(event.authorId)) {
			return { type: "IGNORED", reason: `event ${event.id} was posted by the agent itself` };
		}
		const subscription = await this.#registry.lookup(event);
		if (subscription !== undefined) {
			const description = payloadText(event.payload);
			const auth = this.#authorization.canAct(event.authorId, event.sourceId, {
				origin: ActionOrigin.FOLLOW_UP,
				description,
			});
			if (auth.decision === AuthorizationDecision.DENY) {
				return { type: "IGNORED", reason: auth.reason };
			}
			if (auth.decision === AuthorizationDecision.OBSERVE_ONLY) {
				await this.#observeLog.record({
					id: `observe:${event.sourceId}#${event.id}`,
					sourceId: event.sourceId,
					...(event.threadId === undefined ? {} : { threadId: event.threadId }),
					authorId: event.authorId,
					intendedAction: `Deliver follow-up to worker ${subscription.workerId}: ${description.slice(0, 500)}`,
					rationale: auth.reason,
					createdAt: this.#clock.now(),
				});
				return { type: "OBSERVED", reason: auth.reason };
			}
			return { type: "DIRECT", workerId: subscription.workerId, subscription };
		}
		const { trigger, created } = await this.#intake.execute(event);
		return { type: "ROUTER", trigger, created };
	}
}
