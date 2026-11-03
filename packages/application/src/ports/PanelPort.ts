import type { AttentionItem } from "@superagent/domain";

/**
 * Application output port: surface something a human must act on. The panel shows only
 * these items; healthy work in progress is never shown. The adapter decides how (e.g. a
 * database write the panel server reads).
 */
export interface PanelPort {
	showAttentionItem(item: AttentionItem): Promise<void>;
}
