export const TriggerPriority = {
	LOW: "low",
	NORMAL: "normal",
	HIGH: "high",
} as const;
export type TriggerPriority = (typeof TriggerPriority)[keyof typeof TriggerPriority];

const RANK: Readonly<Record<TriggerPriority, number>> = { high: 0, normal: 1, low: 2 };

/** Sort comparator: high before normal before low. */
export function comparePriority(a: TriggerPriority, b: TriggerPriority): number {
	return RANK[a] - RANK[b];
}

export function isTriggerPriority(value: unknown): value is TriggerPriority {
	return value === "low" || value === "normal" || value === "high";
}
