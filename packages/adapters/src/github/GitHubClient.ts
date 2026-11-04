/** The subset of `fetch` the client uses (injectable for tests). */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GitHubClientOptions {
	/** Fine-grained token with Issues + Pull requests (read/write) and Contents (read). */
	readonly token: string;
	/** Default https://api.github.com. */
	readonly baseUrl?: string;
	/** For tests. */
	readonly fetch?: FetchLike;
	/** Per-request timeout. Default 30 s. */
	readonly timeoutMs?: number;
}

/** A failed GitHub API call. The message never contains the token. */
export class GitHubApiError extends Error {
	override readonly name = "GitHubApiError";
	readonly status: number;
	/** Epoch ms when the rate limit resets, if the call was rate limited. */
	readonly rateLimitResetAt: number | undefined;

	constructor(status: number, message: string, rateLimitResetAt?: number) {
		super(message);
		this.status = status;
		this.rateLimitResetAt = rateLimitResetAt;
	}
}

const MAX_PAGES = 10;

/** Minimal GitHub REST client: JSON in and out, pagination, rate-limit detection. */
export class GitHubClient {
	readonly #token: string;
	readonly #base: string;
	readonly #fetch: FetchLike;
	readonly #timeoutMs: number;

	constructor(options: GitHubClientOptions) {
		if (options.token.trim() === "") throw new Error("GitHub token is empty");
		this.#token = options.token;
		this.#base = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
		this.#fetch = options.fetch ?? fetch;
		this.#timeoutMs = options.timeoutMs ?? 30_000;
	}

	async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
		const { data } = await this.#send<T>(method, `${this.#base}${path}`, body);
		return data;
	}

	/** GET every page (following `Link: rel="next"`), up to a page cap. */
	async paginate<T>(path: string, stopWhen?: (page: readonly T[]) => boolean): Promise<T[]> {
		const all: T[] = [];
		let url: string | undefined = `${this.#base}${path}`;
		for (let page = 0; url !== undefined && page < MAX_PAGES; page++) {
			const { data, next }: { data: T[]; next: string | undefined } = await this.#send<T[]>(
				"GET",
				url,
			);
			all.push(...data);
			if (stopWhen?.(data)) break;
			url = next;
		}
		return all;
	}

	async #send<T>(
		method: string,
		url: string,
		body?: unknown,
	): Promise<{ data: T; next: string | undefined }> {
		if (!url.startsWith(`${this.#base}/`))
			throw new Error(`refusing to send the token to ${new URL(url).origin}`);
		const response = await this.#fetch(url, {
			method,
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${this.#token}`,
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "casiagent",
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(this.#timeoutMs),
		});
		if (!response.ok) {
			const remaining = response.headers.get("x-ratelimit-remaining");
			const reset = Number(response.headers.get("x-ratelimit-reset"));
			const limited = response.status === 429 || (response.status === 403 && remaining === "0");
			const detail = await response
				.json()
				.then((j: unknown) => {
					const message = (j as { message?: unknown } | null)?.message;
					return typeof message === "string" ? message : "";
				})
				.catch(() => "");
			const path = new URL(url).pathname;
			throw new GitHubApiError(
				response.status,
				`GitHub ${method} ${path} failed: ${response.status}${detail === "" ? "" : ` ${detail}`}`,
				limited && Number.isFinite(reset) && reset > 0 ? reset * 1000 : undefined,
			);
		}
		const data = (response.status === 204 ? undefined : await response.json()) as T;
		const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
		return { data, next };
	}
}
