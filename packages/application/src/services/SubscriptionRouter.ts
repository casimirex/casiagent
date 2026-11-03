import type { SourceEvent, Subscription, Trigger } from "@superagent/domain";
import type { IntakeTriggerUseCase } from "../use-cases/IntakeTriggerUseCase";
import type { SubscriptionRegistry } from "./SubscriptionRegistry";

export type RoutingDecision =
	/** The thread has an owner: deliver with WorkerExecutionUseCase.deliverFollowUp. */
	| { readonly type: "DIRECT"; readonly workerId: string; readonly subscription: Subscription }
	/** No owner: a Trigger was taken in (or already existed) for normal evaluation. */
	| { readonly type: "ROUTER"; readonly trigger: Trigger; readonly created: boolean }
	/** Dropped before routing. */
	| { readonly type: "IGNORED"; readonly reason: string };

export interface SubscriptionRouterDeps {
	readonly registry: SubscriptionRegistry;
	readonly intake: IntakeTriggerUseCase;
	/**
	 * Author ids the agent itself posts as. Its own replies come back as events on the
	 * threads it subscribed to; routing them to the Worker would loop forever.
	 */
	readonly selfAuthorIds: ReadonlySet<string>;
}

/**
 * Decides where an inbound event goes, from registry state alone (no LLM).
 *
 * Note: DIRECT events skip the Router's filters, including bot and user checks. That is
 * intended for CI results and review comments on a Worker's own PR. Phase 5 authorization
 * must also gate DIRECT deliveries.
 */
export class SubscriptionRouter {
	readonly #registry: SubscriptionRegistry;
	readonly #intake: IntakeTriggerUseCase;
	readonly #selfAuthorIds: ReadonlySet<string>;

	constructor(deps: SubscriptionRouterDeps) {
		this.#registry = deps.registry;
		this.#intake = deps.intake;
		this.#selfAuthorIds = deps.selfAuthorIds;
	}

	async routeEvent(event: SourceEvent): Promise<RoutingDecision> {
		if (this.#selfAuthorIds.has(event.authorId)) {
			return { type: "IGNORED", reason: `event ${event.id} was posted by the agent itself` };
		}
		const subscription = await this.#registry.lookup(event);
		if (subscription !== undefined) {
			return { type: "DIRECT", workerId: subscription.workerId, subscription };
		}
		const { trigger, created } = await this.#intake.execute(event);
		return { type: "ROUTER", trigger, created };
	}
}
