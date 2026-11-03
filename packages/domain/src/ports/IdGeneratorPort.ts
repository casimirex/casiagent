/** Source of unique ids. Kept behind a port so the domain and use cases stay deterministic. */
export interface IdGeneratorPort {
	next(): string;
}
