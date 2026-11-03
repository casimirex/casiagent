import { DomainError } from "../DomainError";
import type { SourceId } from "./SourceId";

declare const threadKeyBrand: unique symbol;

/**
 * A conversation thread, unique across sources: `<sourceId>::<threadId>`.
 * Thread ids alone collide (PR #42 exists in many repos), so they are always paired.
 */
export type ThreadKey = string & { readonly [threadKeyBrand]: true };

export const ThreadKey = {
	of(sourceId: SourceId, threadId: string): ThreadKey {
		if (threadId.trim().length === 0) throw new DomainError("threadId must not be empty");
		return `${sourceId}::${threadId}` as ThreadKey;
	},
} as const;
