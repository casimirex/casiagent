import type { AttentionItem } from "../entities/AttentionItem";

/** Where escalations go. */
export interface AttentionSinkPort {
	/** Record an item. Returns false if an item with this id already exists. */
	raise(item: AttentionItem): Promise<boolean>;
}

export type ResolveResult = "RESOLVED" | "NOT_FOUND" | "ALREADY_RESOLVED";

/** Attention items with the read and resolve side the panel needs. */
export interface AttentionStorePort extends AttentionSinkPort {
	/** Unresolved items, newest first. */
	listOpen(): Promise<readonly AttentionItem[]>;
	resolve(id: string, at: number): Promise<ResolveResult>;
}
