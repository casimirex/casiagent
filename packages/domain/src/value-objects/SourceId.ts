import { DomainError } from "../DomainError";

declare const sourceIdBrand: unique symbol;

/**
 * Identifier of an event source, written as `<provider>:<identifier>`,
 * e.g. `github:org/repo` or `slack:C0123`.
 */
export type SourceId = string & { readonly [sourceIdBrand]: true };

const SOURCE_ID_PATTERN = /^[a-z][a-z0-9-]*:\S+$/;

export const SourceId = {
	of(value: string): SourceId {
		if (!SOURCE_ID_PATTERN.test(value)) {
			throw new DomainError(`SourceId must look like "<provider>:<identifier>", got "${value}"`);
		}
		return value as SourceId;
	},
	provider(id: SourceId): string {
		return id.slice(0, id.indexOf(":"));
	},
} as const;
