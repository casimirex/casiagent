import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BunPanelServer, InMemoryAttentionStore, InMemoryObserveLog } from "@superagent/adapters";
import { attentionItem, observation } from "./contracts/attention.contract";

const XSS = `<img src=x onerror="alert(1)">`;

async function setup(token?: string) {
	const attention = new InMemoryAttentionStore();
	const observeLog = new InMemoryObserveLog();
	await attention.raise(attentionItem("worker-failed:w1", 2));
	await attention.raise({ ...attentionItem("q:w2", 1), kind: "QUESTION", message: XSS });
	await observeLog.record(observation("observe:t1", 5));
	const server = new BunPanelServer({
		attention,
		observeLog,
		clock: { now: () => 100 },
		...(token === undefined ? {} : { token }),
	});
	const url = server.start();
	return { attention, server, url };
}

const post = (url: URL, path: string, init: RequestInit = {}) =>
	fetch(new URL(path, url), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "{}",
		...init,
	});

describe("BunPanelServer (no token)", () => {
	let ctx: Awaited<ReturnType<typeof setup>>;
	beforeAll(async () => {
		ctx = await setup();
	});
	afterAll(() => ctx.server.stop());

	test("binds to localhost by default", () => {
		expect(ctx.url.hostname).toBe("127.0.0.1");
	});

	test("GET /api/attention-items lists open items newest first", async () => {
		const res = await fetch(new URL("/api/attention-items", ctx.url));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: { id: string }[] };
		expect(body.items.map((i) => i.id)).toEqual(["worker-failed:w1", "q:w2"]);
	});

	test("GET /api/observe-log returns observations and clamps the limit", async () => {
		const res = await fetch(new URL("/api/observe-log?limit=9999", ctx.url));
		expect(((await res.json()) as { entries: unknown[] }).entries).toHaveLength(1);
		const bad = await fetch(new URL("/api/observe-log?limit=abc", ctx.url));
		expect(bad.status).toBe(200);
	});

	test("the page is served with a strict CSP and renders text safely", async () => {
		const page = await fetch(ctx.url);
		expect(page.headers.get("content-type")).toContain("text/html");
		expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
		expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		const js = await (await fetch(new URL("/panel.js", ctx.url))).text();
		// No HTML-parsing sinks: untrusted text must only ever go through textContent.
		expect(js).not.toMatch(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/);
		expect(js).toContain("textContent");
	});

	test("API responses are JSON, so injected markup is never served as HTML", async () => {
		const res = await fetch(new URL("/api/attention-items", ctx.url));
		expect(res.headers.get("content-type")).toStartWith("application/json");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(await res.text()).toContain("onerror"); // present only as JSON string data
	});

	test("resolve: 200, then 409, unknown id 404; resolved items disappear", async () => {
		const id = encodeURIComponent("worker-failed:w1");
		expect((await post(ctx.url, `/api/attention-items/${id}/resolve`)).status).toBe(200);
		expect((await post(ctx.url, `/api/attention-items/${id}/resolve`)).status).toBe(409);
		expect((await post(ctx.url, "/api/attention-items/nope/resolve")).status).toBe(404);
		const open = (await (await fetch(new URL("/api/attention-items", ctx.url))).json()) as {
			items: { id: string }[];
		};
		expect(open.items.map((i) => i.id)).toEqual(["q:w2"]);
	});

	test("resolve refuses cross-origin requests and non-JSON bodies (CSRF)", async () => {
		const path = "/api/attention-items/q%3Aw2/resolve";
		const cross = await post(ctx.url, path, {
			headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
		});
		expect(cross.status).toBe(403);
		const form = await post(ctx.url, path, {
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "a=1",
		});
		expect(form.status).toBe(415);
		const sameOrigin = await post(ctx.url, path, {
			headers: { "Content-Type": "application/json", Origin: ctx.url.origin },
		});
		expect(sameOrigin.status).toBe(200);
	});

	test("wrong methods and unknown paths", async () => {
		expect(
			(await fetch(new URL("/api/attention-items", ctx.url), { method: "DELETE" })).status,
		).toBe(405);
		expect((await fetch(new URL("/api/attention-items/x/resolve", ctx.url))).status).toBe(405);
		expect((await fetch(new URL("/api/nope", ctx.url))).status).toBe(404);
		expect((await fetch(new URL("/etc/passwd", ctx.url))).status).toBe(404);
		expect((await fetch(new URL("/static/../../package.json", ctx.url))).status).toBe(404);
	});
});

describe("BunPanelServer (with token)", () => {
	let ctx: Awaited<ReturnType<typeof setup>>;
	beforeAll(async () => {
		ctx = await setup("s3cret-token");
	});
	afterAll(() => ctx.server.stop());

	test("API requires the bearer token; the static page does not", async () => {
		const api = new URL("/api/attention-items", ctx.url);
		expect((await fetch(api)).status).toBe(401);
		expect((await fetch(api, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
		expect((await fetch(api, { headers: { Authorization: "Bearer s3cret-token" } })).status).toBe(
			200,
		);
		expect((await fetch(ctx.url)).status).toBe(200);
	});

	test("resolve also requires the token", async () => {
		const res = await post(ctx.url, "/api/attention-items/q%3Aw2/resolve");
		expect(res.status).toBe(401);
		expect((await ctx.attention.listOpen()).length).toBe(2);
	});
});
