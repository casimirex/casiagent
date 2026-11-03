import { describe, expect, test } from "bun:test";
import { type DispatchRecord, RouterState, SessionId } from "@casiagent/domain";

const record = (n: number): DispatchRecord => ({
	triggerId: `t${n}`,
	workItemId: `w${n}`,
	workerId: `x${n}`,
	sessionId: SessionId.of(`s${n}`),
});

describe("RouterState", () => {
	test("withDispatched returns a new state and leaves the original unchanged", () => {
		const empty = RouterState.empty();
		const one = empty.withDispatched([record(1)]);
		expect(empty.size).toBe(0);
		expect(one.size).toBe(1);
		expect(one.isDispatched("t1")).toBe(true);
		expect(empty.isDispatched("t1")).toBe(false);
	});

	test("withDispatched([]) returns the same instance", () => {
		const s = RouterState.empty().withDispatched([record(1)]);
		expect(s.withDispatched([])).toBe(s);
	});

	test("records() is a copy, not live state", () => {
		const s = RouterState.empty().withDispatched([record(1), record(2)]);
		const list = s.records() as DispatchRecord[];
		list.pop();
		expect(s.size).toBe(2);
		expect(s.recordFor("t2")).toEqual(record(2));
	});
});
