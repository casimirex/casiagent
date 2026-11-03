import { describe, expect, test } from "bun:test";
import { DomainError, SessionId, SourceId } from "@superagent/domain";

describe("SourceId", () => {
	test.each(["github:org/repo", "slack:C0123", "ci-system:pipeline/42"])("accepts %p", (raw) => {
		expect(SourceId.of(raw) as string).toBe(raw);
	});

	test.each(["", "github", ":org/repo", "GitHub:org/repo", "github:", "github:org repo"])(
		"rejects %p",
		(raw) => {
			expect(() => SourceId.of(raw)).toThrow(DomainError);
		},
	);

	test("provider() returns the part before the first colon", () => {
		expect(SourceId.provider(SourceId.of("github:org/repo:extra"))).toBe("github");
	});
});

describe("SessionId", () => {
	test("trims and accepts non-empty values", () => {
		expect(SessionId.of("  abc  ") as string).toBe("abc");
	});

	test.each(["", "   "])("rejects blank %p", (raw) => {
		expect(() => SessionId.of(raw)).toThrow(DomainError);
	});
});
