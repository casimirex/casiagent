import {
	type ClockPort,
	type OutboundMessage,
	type SourceEvent,
	type SourceEventHandler,
	SourceId,
	type SourcePort,
	type Unsubscribe,
} from "@casiagent/domain";
import type { CursorStore } from "./cursorStore";
import { GitHubApiError, type GitHubClient } from "./GitHubClient";

interface GhUser {
	readonly login: string;
	readonly type: string;
}
interface GhIssue {
	readonly id: number;
	readonly number: number;
	readonly title: string;
	readonly body: string | null;
	readonly user: GhUser;
	readonly created_at: string;
	readonly html_url: string;
	readonly pull_request?: unknown;
}
interface GhComment {
	readonly id: number;
	readonly body: string;
	readonly user: GhUser;
	readonly created_at: string;
	readonly updated_at: string;
	readonly html_url: string;
}
interface GhIssueComment extends GhComment {
	readonly issue_url: string;
}
interface GhReviewComment extends GhComment {
	readonly pull_request_url: string;
	readonly path?: string;
	readonly line?: number | null;
}
interface GhIssueEvent {
	readonly id: number;
	readonly event: string;
	readonly actor: GhUser | null;
	readonly created_at: string;
	readonly issue?: GhIssue;
	readonly assignee?: GhUser | null;
	readonly label?: { readonly name: string } | null;
}

export interface GitHubPollingSourceOptions {
	readonly client: GitHubClient;
	readonly owner: string;
	readonly repo: string;
	/** The login the agent posts as (also add it to the runtime's selfAuthorIds). */
	readonly botLogin: string;
	/** Adding one of these labels to an issue or PR counts as an explicit request. */
	readonly requestLabels?: readonly string[];
	/** Default 30 s. */
	readonly intervalMs?: number;
	/** Each poll re-reads this far back to cover GitHub's eventual consistency. Default 60 s. */
	readonly overlapMs?: number;
	/** Where the read position survives restarts. Without one, polling starts from "now" each run. */
	readonly cursors?: CursorStore;
	readonly clock?: ClockPort;
	/** Poll failures (the poller keeps running). Default: console.error. */
	readonly onError?: (error: unknown) => void;
}

const ms = (iso: string) => Date.parse(iso);
const lastSegment = (url: string) => url.slice(url.lastIndexOf("/") + 1);
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * SourcePort for one GitHub repository, by polling the REST API (no public URL needed).
 *
 * Events: issues opened, issue/PR conversation comments, PR review comments, and
 * assigned/labeled issue events. Thread id = issue or PR number. An event is an explicit
 * request when it @-mentions the bot, assigns it, or adds a request label; everything else
 * is inferred (observe-only by default policy). Event ids are stable, so re-reads from the
 * overlap window are deduplicated by trigger intake.
 */
export class GitHubPollingSource implements SourcePort {
	readonly sourceId: SourceId;
	readonly #o: Required<Omit<GitHubPollingSourceOptions, "cursors" | "requestLabels">> & {
		readonly cursors: CursorStore | undefined;
	};
	readonly #requestLabels: ReadonlySet<string>;
	readonly #mention: RegExp;
	readonly #repoPath: string;
	readonly #handlers = new Set<SourceEventHandler>();
	#timer: ReturnType<typeof setInterval> | undefined;
	#polling = false;
	#pausedUntil = 0;
	#cursor: number | undefined;

	constructor(options: GitHubPollingSourceOptions) {
		this.sourceId = SourceId.of(`github:${options.owner}/${options.repo}`);
		this.#o = {
			client: options.client,
			owner: options.owner,
			repo: options.repo,
			botLogin: options.botLogin,
			intervalMs: options.intervalMs ?? 30_000,
			overlapMs: options.overlapMs ?? 60_000,
			cursors: options.cursors,
			clock: options.clock ?? { now: () => Date.now() },
			onError: options.onError ?? ((e) => console.error("[casiagent] GitHub poll failed:", e)),
		};
		this.#requestLabels = new Set(options.requestLabels ?? []);
		this.#mention = new RegExp(
			`(^|[^A-Za-z0-9_-])@${escapeRegExp(options.botLogin)}(?![A-Za-z0-9_-])`,
			"i",
		);
		this.#repoPath = `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`;
	}

	subscribe(handler: SourceEventHandler): Unsubscribe {
		this.#handlers.add(handler);
		if (this.#timer === undefined) {
			this.#timer = setInterval(() => void this.poll(), this.#o.intervalMs);
			void this.poll();
		}
		return () => {
			this.#handlers.delete(handler);
			if (this.#handlers.size === 0) {
				clearInterval(this.#timer);
				this.#timer = undefined;
			}
		};
	}

	/**
	 * One polling pass: read events since the stored cursor (minus the overlap), deliver
	 * them oldest first, then advance the cursor. Public so the runtime and tests can drive it.
	 * Returns the number of events delivered.
	 */
	async poll(): Promise<number> {
		const now = this.#o.clock.now();
		// No listener: don't read (and so don't advance the cursor past events nobody received).
		if (this.#polling || now < this.#pausedUntil || this.#handlers.size === 0) return 0;
		this.#polling = true;
		try {
			const cursor = await this.#loadCursor(now);
			const events = await this.fetchEvents(cursor - this.#o.overlapMs);
			for (const event of events) {
				for (const handler of this.#handlers) await handler(event);
			}
			// Advance only after delivery, so a crash mid-delivery re-reads rather than skips.
			await this.#saveCursor(events.reduce((max, e) => Math.max(max, e.timestamp), cursor));
			return events.length;
		} catch (error) {
			if (error instanceof GitHubApiError && error.rateLimitResetAt !== undefined) {
				this.#pausedUntil = error.rateLimitResetAt;
			}
			this.#o.onError(error);
			return 0;
		} finally {
			this.#polling = false;
		}
	}

	get #cursorKey(): string {
		return `github:${this.#o.owner}/${this.#o.repo}`;
	}

	/** The stored read position; on a first-ever run, "now" (history is never replayed). */
	async #loadCursor(now: number): Promise<number> {
		if (this.#cursor === undefined) {
			const stored = await this.#o.cursors?.get(this.#cursorKey);
			this.#cursor = stored ?? now;
			if (stored === undefined) await this.#o.cursors?.set(this.#cursorKey, now);
		}
		return this.#cursor;
	}

	async #saveCursor(value: number): Promise<void> {
		this.#cursor = value;
		await this.#o.cursors?.set(this.#cursorKey, value);
	}

	async fetchEvents(sinceTimestamp?: number): Promise<readonly SourceEvent[]> {
		const since = sinceTimestamp ?? this.#o.clock.now();
		const iso = encodeURIComponent(new Date(since).toISOString());
		const q = `since=${iso}&sort=updated&direction=asc&per_page=100`;
		const { client } = this.#o;
		const [issues, comments, reviewComments, issueEvents] = await Promise.all([
			client.paginate<GhIssue>(`${this.#repoPath}/issues?state=all&${q}`),
			client.paginate<GhIssueComment>(`${this.#repoPath}/issues/comments?${q}`),
			client.paginate<GhReviewComment>(`${this.#repoPath}/pulls/comments?${q}`),
			// No `since` here; newest first, so stop once a page reaches older events.
			client.paginate<GhIssueEvent>(`${this.#repoPath}/issues/events?per_page=100`, (page) =>
				page.some((e) => ms(e.created_at) < since),
			),
		]);

		const events: SourceEvent[] = [
			// `since` filters by update time; only issues *created* in the window are new requests.
			...issues.filter((i) => ms(i.created_at) > since).map((i) => this.#fromIssue(i)),
			...comments.filter((c) => ms(c.created_at) > since).map((c) => this.#fromIssueComment(c)),
			...reviewComments
				.filter((c) => ms(c.created_at) > since)
				.map((c) => this.#fromReviewComment(c)),
			...issueEvents
				.filter((e) => ms(e.created_at) > since)
				.flatMap((e) => this.#fromIssueEvent(e) ?? []),
		];
		const unique = new Map(events.map((e) => [e.id, e]));
		return [...unique.values()].sort(
			(a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id),
		);
	}

	async reply(message: OutboundMessage): Promise<void> {
		if (message.threadId === undefined || !/^\d+$/.test(message.threadId)) {
			throw new Error(
				`GitHub replies need an issue or PR number as threadId, got ${String(message.threadId)}`,
			);
		}
		await this.#o.client.request("POST", `${this.#repoPath}/issues/${message.threadId}/comments`, {
			body: message.body,
		});
	}

	#event(
		id: string,
		number: number,
		user: GhUser,
		createdAt: string,
		text: string,
		payload: Record<string, unknown>,
		explicit?: boolean,
	): SourceEvent {
		return {
			id,
			sourceId: this.sourceId,
			threadId: String(number),
			authorId: user.login,
			authorIsBot: user.type === "Bot",
			explicitRequest: explicit ?? this.#mention.test(text),
			payload,
			timestamp: ms(createdAt),
		};
	}

	#fromIssue(i: GhIssue): SourceEvent {
		const body = i.body ?? "";
		return this.#event(`issue:${i.id}`, i.number, i.user, i.created_at, `${i.title}\n${body}`, {
			kind: i.pull_request === undefined ? "issue_opened" : "pull_request_opened",
			number: i.number,
			title: i.title,
			body,
			url: i.html_url,
		});
	}

	#fromIssueComment(c: GhIssueComment): SourceEvent {
		const number = Number(lastSegment(c.issue_url));
		return this.#event(`comment:${c.id}`, number, c.user, c.created_at, c.body, {
			kind: "comment",
			number,
			body: c.body,
			url: c.html_url,
		});
	}

	#fromReviewComment(c: GhReviewComment): SourceEvent {
		const number = Number(lastSegment(c.pull_request_url));
		return this.#event(`review-comment:${c.id}`, number, c.user, c.created_at, c.body, {
			kind: "review_comment",
			number,
			body: c.body,
			...(c.path === undefined ? {} : { path: c.path }),
			...(c.line === undefined || c.line === null ? {} : { line: c.line }),
			url: c.html_url,
		});
	}

	/** Only "assigned to the bot" and "request label added" become events. */
	#fromIssueEvent(e: GhIssueEvent): SourceEvent | undefined {
		if (e.issue === undefined || e.actor === null) return undefined;
		const assignedToBot =
			e.event === "assigned" && e.assignee?.login.toLowerCase() === this.#o.botLogin.toLowerCase();
		const requestLabel =
			e.event === "labeled" && e.label != null && this.#requestLabels.has(e.label.name);
		if (!assignedToBot && !requestLabel) return undefined;
		const body = e.issue.body ?? "";
		return this.#event(
			`event:${e.id}`,
			e.issue.number,
			e.actor,
			e.created_at,
			body,
			{
				kind: assignedToBot ? "assigned" : "labeled",
				number: e.issue.number,
				title: e.issue.title,
				body,
				...(requestLabel && e.label != null ? { label: e.label.name } : {}),
				url: e.issue.html_url,
			},
			true,
		);
	}
}
