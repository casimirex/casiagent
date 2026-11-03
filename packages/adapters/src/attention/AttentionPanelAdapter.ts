import type { PanelPort } from "@superagent/application";
import type { AttentionItem, AttentionSinkPort } from "@superagent/domain";

/** PanelPort as a database write: the panel server reads the same attention store. */
export class AttentionPanelAdapter implements PanelPort {
	readonly #sink: AttentionSinkPort;

	constructor(sink: AttentionSinkPort) {
		this.#sink = sink;
	}

	async showAttentionItem(item: AttentionItem): Promise<void> {
		await this.#sink.raise(item);
	}
}
