import { DomainError } from "../DomainError";

declare const sessionIdBrand: unique symbol;

/** Identifier of a persisted Worker session. Branded so it cannot be mixed with other ids. */
export type SessionId = string & { readonly [sessionIdBrand]: true };

export const SessionId = {
	of(value: string): SessionId {
		const trimmed = value.trim();
		if (trimmed.length === 0) {
			throw new DomainError("SessionId must not be empty");
		}
		return trimmed as SessionId;
	},
} as const;
