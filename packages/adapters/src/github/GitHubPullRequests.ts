import type { PullRequestOpener } from "../workspace/GitWorktreeToolsets";
import { GitHubApiError, type GitHubClient } from "./GitHubClient";

interface GhPull {
	readonly number: number;
	readonly html_url: string;
}

/** PullRequestOpener on the GitHub REST API. Re-opening an existing PR returns it. */
export class GitHubPullRequests implements PullRequestOpener {
	readonly #client: GitHubClient;
	readonly #owner: string;
	readonly #repoPath: string;

	constructor(client: GitHubClient, owner: string, repo: string) {
		this.#client = client;
		this.#owner = owner;
		this.#repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
	}

	async open(request: {
		readonly branch: string;
		readonly base: string;
		readonly title: string;
		readonly body: string;
	}): Promise<{ readonly number: number; readonly url: string }> {
		try {
			const pr = await this.#client.request<GhPull>("POST", `${this.#repoPath}/pulls`, {
				title: request.title,
				head: request.branch,
				base: request.base,
				body: request.body,
			});
			return { number: pr.number, url: pr.html_url };
		} catch (error) {
			// 422 is returned when a PR for this branch already exists (e.g. a re-run): reuse it.
			if (!(error instanceof GitHubApiError) || error.status !== 422) throw error;
			const head = encodeURIComponent(`${this.#owner}:${request.branch}`);
			const [existing] = await this.#client.request<GhPull[]>(
				"GET",
				`${this.#repoPath}/pulls?head=${head}&state=open`,
			);
			if (existing === undefined) throw error;
			return { number: existing.number, url: existing.html_url };
		}
	}
}
