/** Raised when a use case cannot proceed because stored state is missing or inconsistent. */
export class UseCaseError extends Error {
	override readonly name = "UseCaseError";
}
