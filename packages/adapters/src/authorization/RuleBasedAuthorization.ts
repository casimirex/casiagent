import {
	type Action,
	ActionOrigin,
	AuthorizationDecision,
	type AuthorizationPort,
	type AuthorizationVerdict,
	type SourceId,
} from "@casiagent/domain";
import type { AuthorizationConfig, Default, RuleAction, RuleScope } from "./authorizationConfig";

interface CompiledRule {
	readonly pattern: RegExp;
	readonly source: string;
	readonly action: RuleAction;
	readonly scope: RuleScope;
}

const SCOPE_ORIGINS: Readonly<Record<RuleScope, readonly ActionOrigin[]>> = {
	explicit_request: [ActionOrigin.EXPLICIT_REQUEST],
	inferred: [ActionOrigin.INFERRED],
	new_work: [ActionOrigin.EXPLICIT_REQUEST, ActionOrigin.INFERRED],
	follow_up: [ActionOrigin.FOLLOW_UP],
	any: [ActionOrigin.EXPLICIT_REQUEST, ActionOrigin.INFERRED, ActionOrigin.FOLLOW_UP],
};

const DECISION: Readonly<Record<Default, AuthorizationDecision>> = {
	allow: AuthorizationDecision.ALLOW,
	deny: AuthorizationDecision.DENY,
	observe_only: AuthorizationDecision.OBSERVE_ONLY,
};

/**
 * Authorization from a config file (see authorizationConfig.ts). Evaluation order:
 *   1. author must be in allowed_users (follow-ups: also trusted_followup_authors) -> else DENY
 *   2. source must be in allowed_sources -> else DENY
 *   3. first rule whose scope covers the action's origin and whose pattern matches:
 *        deny -> DENY, observe_only -> OBSERVE_ONLY, auto_act -> ALLOW,
 *        allow -> ALLOW, except INFERRED work, which is forced to OBSERVE_ONLY
 *   4. otherwise the default for the origin
 */
export class RuleBasedAuthorization implements AuthorizationPort {
	readonly #users: ReadonlySet<string>;
	readonly #followUpAuthors: ReadonlySet<string>;
	readonly #sources: ReadonlySet<string>;
	readonly #rules: readonly CompiledRule[];
	readonly #defaults: AuthorizationConfig["defaults"];

	constructor(config: AuthorizationConfig) {
		this.#users = new Set(config.allowed_users);
		this.#followUpAuthors = new Set(config.trusted_followup_authors);
		this.#sources = new Set(config.allowed_sources);
		this.#rules = config.rules.map((r) => ({
			pattern: new RegExp(r.pattern, "i"),
			source: r.pattern,
			action: r.action,
			scope: r.scope,
		}));
		this.#defaults = config.defaults;
	}

	canAct(userId: string, sourceId: SourceId, action: Action): AuthorizationVerdict {
		const isFollowUp = action.origin === ActionOrigin.FOLLOW_UP;
		if (!this.#users.has(userId) && !(isFollowUp && this.#followUpAuthors.has(userId))) {
			return deny(`user ${userId} is not allowed`);
		}
		if (!this.#sources.has(sourceId)) return deny(`source ${sourceId} is not allowed`);

		const rule = this.#rules.find(
			(r) => SCOPE_ORIGINS[r.scope].includes(action.origin) && r.pattern.test(action.description),
		);
		if (rule !== undefined) {
			const where = `rule /${rule.source}/`;
			switch (rule.action) {
				case "deny":
					return deny(`${where} denies this`);
				case "observe_only":
					return observe(`${where} is observe-only`);
				case "auto_act":
					return {
						decision: AuthorizationDecision.ALLOW,
						reason: `${where} allows automatic action`,
					};
				case "allow":
					return action.origin === ActionOrigin.INFERRED
						? observe(
								`${where} allows only explicit requests; inferred work is observe-only without an auto_act rule`,
							)
						: { decision: AuthorizationDecision.ALLOW, reason: `${where} allows this` };
			}
		}

		const fallback =
			action.origin === ActionOrigin.EXPLICIT_REQUEST
				? this.#defaults.explicit_request
				: action.origin === ActionOrigin.INFERRED
					? this.#defaults.inferred
					: this.#defaults.follow_up;
		return {
			decision: DECISION[fallback],
			reason: `no rule matched; default for ${action.origin} is ${fallback}`,
		};
	}
}

const deny = (reason: string): AuthorizationVerdict => ({
	decision: AuthorizationDecision.DENY,
	reason,
});
const observe = (reason: string): AuthorizationVerdict => ({
	decision: AuthorizationDecision.OBSERVE_ONLY,
	reason,
});
