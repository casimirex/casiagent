/** Raised when a domain invariant is violated. */
export class DomainError extends Error {
	override readonly name = "DomainError";
}
