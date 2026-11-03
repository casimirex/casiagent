import { timingSafeEqual } from "node:crypto";
import type { AttentionStorePort, ClockPort, ObserveLogPort } from "@superagent/domain";
import type { Server } from "bun";

export interface PanelServerOptions {
	readonly attention: AttentionStorePort;
	readonly observeLog: ObserveLogPort;
	readonly clock: ClockPort;
	/** 0 picks a free port. Default 0. */
	readonly port?: number;
	/** Default 127.0.0.1: the panel is not exposed to the network unless asked. */
	readonly hostname?: string;
	/** If set, every /api request needs `Authorization: Bearer <token>`. Open the panel with `#token=…`. */
	readonly token?: string;
}

const STATIC: Readonly<Record<string, { file: string; type: string }>> = {
	"/": { file: "index.html", type: "text/html; charset=utf-8" },
	"/panel.js": { file: "panel.js", type: "text/javascript; charset=utf-8" },
	"/panel.css": { file: "panel.css", type: "text/css; charset=utf-8" },
};

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"Content-Security-Policy":
		"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Cache-Control": "no-store",
};

const RESOLVE_PATH = /^\/api\/attention-items\/([^/]+)\/resolve$/;
const DEFAULT_OBSERVE_LIMIT = 100;
const MAX_OBSERVE_LIMIT = 500;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" },
	});
}

function safeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The attention panel: a read-only JSON API plus a static page. It shows only items that
 * need a human and the observe log; healthy work in progress is never exposed.
 *
 *   GET  /api/attention-items               open items, newest first
 *   GET  /api/observe-log?limit=N           observations, newest first (N <= 500)
 *   POST /api/attention-items/:id/resolve   200 resolved, 404 unknown, 409 already resolved
 *
 * The resolve endpoint is the only write. It requires a JSON body and, when the browser
 * sends an Origin, the panel's own origin, so other websites cannot trigger it.
 */
export class BunPanelServer {
	readonly #options: PanelServerOptions;
	#server: Server<undefined> | undefined;

	constructor(options: PanelServerOptions) {
		this.#options = options;
	}

	start(): URL {
		if (this.#server !== undefined) return this.#server.url;
		this.#server = Bun.serve({
			port: this.#options.port ?? 0,
			hostname: this.#options.hostname ?? "127.0.0.1",
			fetch: (request) => this.handle(request),
			error: () => json({ error: "internal error" }, 500),
		});
		return this.#server.url;
	}

	async stop(): Promise<void> {
		await this.#server?.stop(true);
		this.#server = undefined;
	}

	get url(): URL | undefined {
		return this.#server?.url;
	}

	/** Exposed for tests; the server routes every request through here. */
	async handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const page = STATIC[url.pathname];
		if (page !== undefined) {
			if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
			const file = Bun.file(new URL(`./static/${page.file}`, import.meta.url));
			return new Response(file, { headers: { ...SECURITY_HEADERS, "Content-Type": page.type } });
		}
		if (!url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
		if (!this.#authorized(request)) return json({ error: "unauthorized" }, 401);

		if (url.pathname === "/api/attention-items") {
			if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
			return json({ items: await this.#options.attention.listOpen() });
		}
		if (url.pathname === "/api/observe-log") {
			if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
			const requested = Number(url.searchParams.get("limit") ?? DEFAULT_OBSERVE_LIMIT);
			const limit = Number.isInteger(requested)
				? Math.min(Math.max(requested, 0), MAX_OBSERVE_LIMIT)
				: DEFAULT_OBSERVE_LIMIT;
			return json({ entries: await this.#options.observeLog.list(limit) });
		}
		const resolve = RESOLVE_PATH.exec(url.pathname);
		if (resolve !== null) {
			if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
			const origin = request.headers.get("origin");
			if (origin !== null && origin !== url.origin)
				return json({ error: "cross-origin request refused" }, 403);
			if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
				return json({ error: "expected application/json" }, 415);
			}
			let id: string;
			try {
				id = decodeURIComponent(resolve[1] as string);
			} catch {
				return json({ error: "bad id" }, 400);
			}
			const result = await this.#options.attention.resolve(id, this.#options.clock.now());
			const status = result === "RESOLVED" ? 200 : result === "NOT_FOUND" ? 404 : 409;
			return json({ status: result }, status);
		}
		return json({ error: "not found" }, 404);
	}

	#authorized(request: Request): boolean {
		const token = this.#options.token;
		if (token === undefined) return true;
		const header = request.headers.get("authorization") ?? "";
		return header.startsWith("Bearer ") && safeEqual(header.slice("Bearer ".length), token);
	}
}
