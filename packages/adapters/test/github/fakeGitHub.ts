/** A fake GitHub REST API for one repository, served through an injected `fetch`. */
export interface Recorded {
	readonly method: string;
	readonly url: URL;
	readonly headers: Headers;
	readonly body: unknown;
}

type Json = Record<string, unknown>;

const user = (login: string, type = "User") => ({ login, type });

export class FakeGitHub {
	readonly requests: Recorded[] = [];
	issues: Json[] = [];
	comments: Json[] = [];
	reviewComments: Json[] = [];
	/** Newest first, as GitHub returns them. */
	events: Json[] = [];
	pulls: Json[] = [];
	pageSize = 100;
	/** Make the next N requests fail with a rate-limit response. */
	rateLimitNext = 0;
	rateLimitResetAt = 0;
	nextPrNumber = 100;

	readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
		this.requests.push({ method, url, headers: new Headers(init?.headers), body });
		if (this.rateLimitNext > 0) {
			this.rateLimitNext -= 1;
			return Response.json(
				{ message: "API rate limit exceeded" },
				{
					status: 403,
					headers: {
						"x-ratelimit-remaining": "0",
						"x-ratelimit-reset": String(this.rateLimitResetAt / 1000),
					},
				},
			);
		}
		const path = url.pathname.replace("/repos/org/repo", "");
		const since = url.searchParams.get("since");
		const after = (items: Json[], field: string) =>
			since === null
				? items
				: items.filter((i) => Date.parse(String(i[field])) >= Date.parse(since));

		if (method === "GET" && path === "/issues")
			return this.#page(url, after(this.issues, "updated_at"));
		if (method === "GET" && path === "/issues/comments")
			return this.#page(url, after(this.comments, "updated_at"));
		if (method === "GET" && path === "/pulls/comments")
			return this.#page(url, after(this.reviewComments, "updated_at"));
		if (method === "GET" && path === "/issues/events") return this.#page(url, this.events);
		const comment = /^\/issues\/(\d+)\/comments$/.exec(path);
		if (method === "POST" && comment !== null) {
			return Response.json({ id: 999, body: (body as Json).body }, { status: 201 });
		}
		if (method === "POST" && path === "/pulls") {
			const b = body as Json;
			if (this.pulls.some((p) => p.head === b.head)) {
				return Response.json({ message: "Validation Failed" }, { status: 422 });
			}
			const pr = {
				number: this.nextPrNumber++,
				html_url: `https://github.test/org/repo/pull/${this.nextPrNumber - 1}`,
				head: b.head,
			};
			this.pulls.push(pr);
			return Response.json(pr, { status: 201 });
		}
		if (method === "GET" && path === "/pulls") {
			const head = url.searchParams.get("head")?.split(":")[1];
			return Response.json(this.pulls.filter((p) => p.head === head));
		}
		return Response.json({ message: "Not Found" }, { status: 404 });
	};

	#page(url: URL, items: Json[]): Response {
		const page = Number(url.searchParams.get("page") ?? "1");
		const slice = items.slice((page - 1) * this.pageSize, page * this.pageSize);
		const headers: Record<string, string> = {};
		if (page * this.pageSize < items.length) {
			const next = new URL(url);
			next.searchParams.set("page", String(page + 1));
			headers.link = `<${next}>; rel="next"`;
		}
		return Response.json(slice, { headers });
	}
}

export const at = (ms: number) => new Date(ms).toISOString();

export function issue(
	id: number,
	number: number,
	createdAt: number,
	body: string,
	login = "alice",
	extra: Json = {},
): Json {
	return {
		id,
		number,
		title: `Issue ${number}`,
		body,
		user: user(login),
		created_at: at(createdAt),
		updated_at: at(createdAt),
		html_url: `https://github.test/org/repo/issues/${number}`,
		...extra,
	};
}

export function comment(
	id: number,
	number: number,
	createdAt: number,
	body: string,
	login = "alice",
	type = "User",
): Json {
	return {
		id,
		body,
		user: user(login, type),
		created_at: at(createdAt),
		updated_at: at(createdAt),
		html_url: `https://github.test/org/repo/issues/${number}#issuecomment-${id}`,
		issue_url: `https://api.github.test/repos/org/repo/issues/${number}`,
	};
}

export function reviewComment(
	id: number,
	pr: number,
	createdAt: number,
	body: string,
	login = "bob",
): Json {
	return {
		id,
		body,
		user: user(login),
		created_at: at(createdAt),
		updated_at: at(createdAt),
		html_url: `https://github.test/org/repo/pull/${pr}#discussion_r${id}`,
		pull_request_url: `https://api.github.test/repos/org/repo/pulls/${pr}`,
		path: "src/a.ts",
		line: 3,
	};
}

export function issueEvent(
	id: number,
	kind: string,
	createdAt: number,
	number: number,
	extra: Json = {},
): Json {
	return {
		id,
		event: kind,
		actor: user("alice"),
		created_at: at(createdAt),
		issue: issue(5000 + number, number, createdAt - 1_000_000, "please handle this"),
		...extra,
	};
}
