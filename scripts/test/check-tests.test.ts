import { expect, test } from "bun:test";
import { findUnawaited } from "../check-tests";

test("flags unawaited rejects/resolves and accepts awaited or returned ones", () => {
	const code = [
		"\texpect(p).rejects.toThrow();",
		"\tawait expect(p).rejects.toThrow();",
		"\treturn expect(p).resolves.toBe(1);",
		"\texpect(worker.execute(record)).resolves.toEqual(x);",
		"\texpect(value).toBe(1);",
	].join("\n");
	expect(findUnawaited(code)).toEqual([1, 4]);
});
