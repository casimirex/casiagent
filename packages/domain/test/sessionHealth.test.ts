import { describe, expect, test } from "bun:test";
import { assessSessionHealth, type Session, SessionId, SessionStatus } from "@superagent/domain";

const policy = { stallAfterMs: 90_000, maxRestarts: 3 };
const at = (overrides: Partial<Session>): Session => ({
	id: SessionId.of("s"),
	workerId: "w",
	workItemId: "i",
	status: SessionStatus.ACTIVE,
	context: { messages: [] },
	createdAt: 0,
	updatedAt: 0,
	lastHeartbeatAt: 0,
	restartCount: 0,
	...overrides,
});

describe("assessSessionHealth", () => {
	test.each([
		["recent heartbeat -> HEALTHY", at({}), 90_000, "HEALTHY"],
		["just past the threshold -> RESTART", at({}), 90_001, "RESTART"],
		[
			"stalled with restarts left -> RESTART",
			at({ status: SessionStatus.STALLED, restartCount: 2 }),
			100_000,
			"RESTART",
		],
		["out of restarts -> ESCALATE", at({ restartCount: 3 }), 100_000, "ESCALATE"],
		[
			"WAITING is never stalled -> HEALTHY",
			at({ status: SessionStatus.WAITING }),
			10_000_000,
			"HEALTHY",
		],
		[
			"COMPLETED is never stalled -> HEALTHY",
			at({ status: SessionStatus.COMPLETED }),
			10_000_000,
			"HEALTHY",
		],
	] as const)("%s", (_name, session, now, action) => {
		expect(assessSessionHealth(session, now, policy).action).toBe(action);
	});

	test("escalation reason says what happened", () => {
		const verdict = assessSessionHealth(at({ restartCount: 3 }), 100_000, policy);
		expect(verdict).toMatchObject({ action: "ESCALATE" });
		if (verdict.action === "ESCALATE") expect(verdict.reason).toContain("after 3 restarts");
	});
});
