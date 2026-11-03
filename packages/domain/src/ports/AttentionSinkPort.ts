import type { AttentionItem } from "../entities/AttentionItem";

/** Where escalations go. Phase 5's PanelPort reads what is written here. */
export interface AttentionSinkPort {
	/** Record an item. Returns false if an item with this id already exists. */
	raise(item: AttentionItem): Promise<boolean>;
}
