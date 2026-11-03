import { DomainError } from "../DomainError";

/** Map of each status to the statuses it may move to. Terminal statuses map to `[]`. */
export type TransitionTable<S extends string> = { readonly [K in S]: readonly S[] };

export function assertTransition<S extends string>(
	entity: string,
	table: TransitionTable<S>,
	from: S,
	to: S,
): void {
	if (!table[from].includes(to)) {
		throw new DomainError(`${entity}: illegal status transition ${from} -> ${to}`);
	}
}
