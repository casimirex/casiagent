import { describe, expect, test } from "bun:test";
import {
	GitHubApiError,
	GitHubClient,
	GitHubPollingSource,
	type GitHubPollingSourceOptions,
	GitHubPullRequests,
	InMemoryCursorStore,
	openDatabase,
	SqliteCursorStore,
} from "@casiagent/adapters";
import { comment, FakeGitHub, issue, issueEvent, reviewComment } from "./fakeGitHub";

const T0 = Date.parse("2026-11-03T10:00:00Z");
const TOKEN = "github_pat_SECRET123";

function setup(overrides: Partial<GitHubPollingSourceOptions> = {}) {
	const gh = new FakeGitHub();
	const clock = {
		time: T0,
		now() {
			return this.time;
		},
	};
	const errors: unknown[] = [];
	const client = new GitHubClient({
		token: TOKEN,
		baseUrl: "https://api.github.test",
		fetch: gh.fetch,
	});
	const source = new GitHubPollingSource({
		client,
		owner: "org",
		repo: "repo",
		botLogin: "casiagent-bot",
		requestLabels: ["casiagent"],
		clock,
		onError: (e) => errors.push(e),
		...overrides,
	});
	return { gh, clock, errors, client, source };
}

describe("GitHubPollingSource: mapping", () => {
	test("issues, comments, review comments and request events become SourceEvents on the right thread", async () => {
		const { gh, source } = setup();
		gh.issues = [issue(1, 7, T0 + 1_000, "@casiagent-bot please fix the flaky test")];
		gh.comments = [comment(2, 7, T0 + 2_000, "any update?", "bob")];
		gh.reviewComments = [reviewComment(3, 12, T0 + 3_000, "rename this")];
		gh.events = [
			issueEvent(4, "assigned", T0 + 4_000, 8, {
				assignee: { login: "casiagent-bot", type: "Bot" },
			}),
			issueEvent(5, "labeled", T0 + 5_000, 9, { label: { name: "casiagent" } }),
			issueEvent(6, "labeled", T0 + 6_000, 9, { label: { name: "bug" } }), // not a request label
		];

		const events = await source.fetchEvents(T0);

		expect(events.map((e) => [e.id, e.threadId, e.authorId, e.explicitRequest])).toEqual([
			["issue:1", "7", "alice", true],
			["comment:2", "7", "bob", false],
			["review-comment:3", "12", "bob", false],
			["event:4", "8", "alice", true],
			["event:5", "9", "alice", true],
		]);
		expect(events[0]).toMatchObject({
			sourceId: "github:org/repo",
			timestamp: T0 + 1_000,
			payload: {
				kind: "issue_opened",
				number: 7,
				body: "@casiagent-bot please fix the flaky test",
			},
		});
		expect(events[2]?.payload).toMatchObject({ kind: "review_comment", path: "src/a.ts", line: 3 });
	});

	test.each([
		["@casiagent-bot do it", true],
		["Hey @CASIAGENT-BOT, do it", true],
		["(@casiagent-bot)", true],
		["@casiagent-botx do it", false],
		["email casiagent-bot@x.com", false],
		["mentions casiagent-bot without @", false],
	])("mention detection: %p -> %p", async (body, explicit) => {
		const { gh, source } = setup();
		gh.comments = [comment(1, 3, T0 + 1, body)];
		expect((await source.fetchEvents(T0))[0]?.explicitRequest).toBe(explicit);
	});

	test("bot authors are flagged", async () => {
		const { gh, source } = setup();
		gh.comments = [comment(1, 3, T0 + 1, "CI failed", "github-actions[bot]", "Bot")];
		expect((await source.fetchEvents(T0))[0]).toMatchObject({ authorIsBot: true });
	});

	test("an old issue that was merely updated is not reported as a new request", async () => {
		const { gh, source } = setup();
		gh.issues = [
			{
				...issue(1, 7, T0 - 86_400_000, "@casiagent-bot old"),
				updated_at: new Date(T0 + 1).toISOString(),
			},
		];
		expect(await source.fetchEvents(T0)).toEqual([]);
	});

	test("pages are followed", async () => {
		const { gh, source } = setup();
		gh.pageSize = 2;
		gh.comments = Array.from({ length: 5 }, (_, i) => comment(i + 1, 3, T0 + i + 1, `c${i}`));
		expect((await source.fetchEvents(T0)).map((e) => e.id)).toHaveLength(5);
	});
});

describe("GitHubPollingSource: polling", () => {
	test("delivers new events oldest first and persists the cursor across restarts", async () => {
		const cursors = new InMemoryCursorStore();
		const first = setup({ cursors });
		const seen: string[] = [];
		const stopFirst = first.source.subscribe((e) => {
			seen.push(e.id);
		});
		await Bun.sleep(5); // the initial poll records "now" as the starting point
		first.gh.comments = [comment(2, 3, T0 + 2_000, "second"), comment(1, 3, T0 + 1_000, "first")];
		first.clock.time = T0 + 30_000;
		await first.source.poll();
		stopFirst();
		expect(seen).toEqual(["comment:1", "comment:2"]);
		expect(await cursors.get("github:org/repo")).toBe(T0 + 2_000);

		// A new process with the same cursor store resumes after them.
		const second = setup({ cursors, overlapMs: 0 });
		second.gh.comments = [...first.gh.comments, comment(3, 3, T0 + 40_000, "third")];
		second.clock.time = T0 + 60_000;
		const delivered: string[] = [];
		const stopSecond = second.source.subscribe((e) => {
			delivered.push(e.id);
		});
		await Bun.sleep(5);
		stopSecond();
		expect(delivered).toEqual(["comment:3"]);
	});

	test("the overlap window re-delivers recent events (trigger intake deduplicates them by id)", async () => {
		const cursors = new InMemoryCursorStore();
		await cursors.set("github:org/repo", T0 + 2_000);
		const { gh, clock, source } = setup({ cursors, overlapMs: 60_000 });
		gh.comments = [comment(1, 3, T0 + 1_000, "seen before"), comment(2, 3, T0 + 50_000, "new")];
		clock.time = T0 + 60_000;
		const delivered: string[] = [];
		const stop = source.subscribe((e) => {
			delivered.push(e.id);
		});
		await Bun.sleep(5);
		stop();
		expect(delivered).toEqual(["comment:1", "comment:2"]);
	});

	test("with no subscriber, poll reads nothing and does not advance the cursor", async () => {
		const cursors = new InMemoryCursorStore();
		await cursors.set("github:org/repo", T0);
		const { gh, source } = setup({ cursors });
		gh.comments = [comment(1, 3, T0 + 1_000, "unheard")];
		expect(await source.poll()).toBe(0);
		expect(gh.requests).toHaveLength(0);
		expect(await cursors.get("github:org/repo")).toBe(T0);
	});

	test("the first ever run starts from now instead of replaying history", async () => {
		const { gh, source } = setup({ cursors: new InMemoryCursorStore(), overlapMs: 0 });
		gh.comments = [comment(1, 3, T0 - 3_600_000, "@casiagent-bot ancient")];
		const seen: string[] = [];
		const stop = source.subscribe((e) => {
			seen.push(e.id);
		});
		await Bun.sleep(5);
		stop();
		expect(seen).toEqual([]);
	});

	test("a rate-limited poll pauses polling until the reset time", async () => {
		const { gh, clock, errors, source } = setup({ intervalMs: 3_600_000 });
		const stop = source.subscribe(() => {});
		await Bun.sleep(5);
		gh.requests.length = 0;
		errors.length = 0;
		gh.rateLimitNext = 4;
		gh.rateLimitResetAt = T0 + 600_000;
		await source.poll();
		expect(errors[0]).toBeInstanceOf(GitHubApiError);
		const calls = gh.requests.length;
		clock.time = T0 + 300_000;
		await source.poll();
		expect(gh.requests.length).toBe(calls); // still paused: no requests
		clock.time = T0 + 600_001;
		await source.poll();
		expect(gh.requests.length).toBeGreaterThan(calls);
		stop();
	});

	test("overlapping polls do not run concurrently", async () => {
		const { gh, source } = setup({ intervalMs: 3_600_000 });
		const stop = source.subscribe(() => {}); // starts one pass
		await Promise.all([source.poll(), source.poll(), source.poll()]);
		await Bun.sleep(5);
		stop();
		expect(gh.requests).toHaveLength(4); // a single pass = 4 endpoints
	});

	test("the SQLite cursor store round-trips", async () => {
		const store = new SqliteCursorStore(openDatabase(":memory:"));
		expect(await store.get("k")).toBeUndefined();
		await store.set("k", 5);
		await store.set("k", 9);
		expect(await store.get("k")).toBe(9);
	});
});

describe("GitHubPollingSource.reply and GitHubClient", () => {
	test("reply posts an issue comment with the token and API version headers", async () => {
		const { gh, source } = setup();
		await source.reply({ threadId: "7", body: "Done: opened #8" });
		const req = gh.requests[0];
		expect(req?.method).toBe("POST");
		expect(req?.url.pathname).toBe("/repos/org/repo/issues/7/comments");
		expect(req?.body).toEqual({ body: "Done: opened #8" });
		expect(req?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
		expect(req?.headers.get("x-github-api-version")).toBe("2022-11-28");
	});

	test("reply requires a numeric thread", async () => {
		const { source } = setup();
		await expect(source.reply({ body: "x" })).rejects.toThrow(/threadId/);
		await expect(source.reply({ threadId: "../../admin", body: "x" })).rejects.toThrow(/threadId/);
	});

	test("errors never include the token", async () => {
		const { client } = setup();
		const error = await client.request("GET", "/repos/org/repo/nope").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(GitHubApiError);
		expect(String(error)).toContain("404");
		expect(String(error)).not.toContain(TOKEN);
	});

	test("the token is never sent to another host (e.g. a hostile pagination link)", async () => {
		const gh = new FakeGitHub();
		const sentTo: string[] = [];
		const client = new GitHubClient({
			token: TOKEN,
			baseUrl: "https://api.github.test",
			fetch: async (input, init) => {
				sentTo.push(new URL(String(input)).host);
				if (sentTo.length === 1) {
					return Response.json([], { headers: { link: '<https://evil.test/steal>; rel="next"' } });
				}
				return gh.fetch(input, init);
			},
		});
		await expect(client.paginate("/repos/org/repo/issues")).rejects.toThrow(/refusing/);
		expect(sentTo).toEqual(["api.github.test"]);
	});
});

describe("GitHubPullRequests", () => {
	test("opens a PR from the task branch, and returns the existing one on a re-run", async () => {
		const gh = new FakeGitHub();
		const client = new GitHubClient({
			token: TOKEN,
			baseUrl: "https://api.github.test",
			fetch: gh.fetch,
		});
		const prs = new GitHubPullRequests(client, "org", "repo");
		const request = { branch: "casiagent/w1", base: "main", title: "Fix", body: "Details" };

		const first = await prs.open(request);
		const again = await prs.open(request);

		expect(first).toEqual({ number: 100, url: "https://github.test/org/repo/pull/100" });
		expect(again).toEqual(first);
		expect(gh.requests[0]?.body).toEqual({
			title: "Fix",
			head: "casiagent/w1",
			base: "main",
			body: "Details",
		});
	});
});
