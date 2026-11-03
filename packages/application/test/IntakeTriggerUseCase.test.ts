import { describe, expect, test } from "bun:test";
import { IntakeTriggerUseCase, triggerIdFor } from "@superagent/application";
import { TriggerStatus } from "@superagent/domain";
import { FakeSessionStore, makeEvent } from "./fakes";

describe("IntakeTriggerUseCase", () => {
	test("maps a source event to a PENDING trigger and persists it", async () => {
		const store = new FakeSessionStore();
		const event = makeEvent();

		const { trigger, created } = await new IntakeTriggerUseCase({ store }).execute(event);

		expect(created).toBe(true);
		expect(trigger).toEqual({
			id: triggerIdFor(event),
			sourceId: event.sourceId,
			threadId: "pr-42",
			authorId: "alice",
			authorIsBot: false,
			payload: event.payload,
			timestamp: 500,
			status: TriggerStatus.PENDING,
		});
		expect(store.triggers.get(trigger.id)).toEqual(trigger);
	});

	test("omits threadId when the event has none", async () => {
		const { threadId: _, ...noThread } = makeEvent();
		const { trigger } = await new IntakeTriggerUseCase({ store: new FakeSessionStore() }).execute(
			noThread,
		);
		expect("threadId" in trigger).toBe(false);
	});

	test("taking in the same event twice never resets an already-progressed trigger", async () => {
		const store = new FakeSessionStore();
		const intake = new IntakeTriggerUseCase({ store });
		const event = makeEvent();
		const first = await intake.execute(event);
		store.setStatus(first.trigger.id, TriggerStatus.ACCEPTED);

		const second = await intake.execute(event);

		expect(second.created).toBe(false);
		expect(second.trigger.status).toBe(TriggerStatus.ACCEPTED);
		expect(store.triggers.size).toBe(1);
	});

	test("concurrent intake of the same event creates exactly one trigger", async () => {
		const store = new FakeSessionStore();
		const intake = new IntakeTriggerUseCase({ store });
		const results = await Promise.all([intake.execute(makeEvent()), intake.execute(makeEvent())]);
		expect(results.filter((r) => r.created)).toHaveLength(1);
		expect(store.triggers.size).toBe(1);
	});
});
