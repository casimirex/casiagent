// Renders untrusted text (user and model output) with textContent only. Never innerHTML.

const token = new URLSearchParams(location.hash.slice(1)).get("token");
const headers = token ? { Authorization: `Bearer ${token}` } : {};
const BAD = new Set(["WATCHDOG_ESCALATION", "WORKER_FAILED", "DELIVERY_FAILED"]);

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function when(ms) {
	return new Date(ms).toLocaleString();
}

function showError(message) {
	const box = document.getElementById("error");
	box.textContent = message;
	box.hidden = !message;
}

async function getJson(path) {
	const res = await fetch(path, { headers });
	if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
	return res.json();
}

async function resolve(id, button) {
	button.disabled = true;
	const res = await fetch(`/api/attention-items/${encodeURIComponent(id)}/resolve`, {
		method: "POST",
		headers: { ...headers, "Content-Type": "application/json" },
		body: "{}",
	});
	if (!res.ok && res.status !== 409) {
		button.disabled = false;
		showError(`Could not resolve: HTTP ${res.status}`);
		return;
	}
	await refresh();
}

function renderAttention(items) {
	const list = document.getElementById("attention-list");
	list.replaceChildren();
	document.getElementById("attention-empty").hidden = items.length > 0;
	document.getElementById("attention-count").textContent = items.length ? `(${items.length})` : "";
	for (const item of items) {
		const li = el("li", "item");
		li.append(el("div", BAD.has(item.kind) ? "kind bad" : "kind", item.kind.replaceAll("_", " ")));
		li.append(el("p", "message", item.message));
		const meta = el(
			"p",
			"meta",
			`${when(item.createdAt)}${item.workItemId ? ` · work item ${item.workItemId}` : ""}`,
		);
		if (typeof item.url === "string" && /^https?:\/\//.test(item.url)) {
			const link = el("a", "", " · open");
			link.href = item.url;
			link.rel = "noopener noreferrer";
			meta.append(link);
		}
		li.append(meta);
		const button = el("button", "", "Mark resolved");
		button.type = "button";
		button.addEventListener("click", () => resolve(item.id, button));
		li.append(button);
		list.append(li);
	}
}

function renderObservations(entries) {
	const list = document.getElementById("observe-list");
	list.replaceChildren();
	document.getElementById("observe-empty").hidden = entries.length > 0;
	for (const o of entries) {
		const li = el("li", "item");
		li.append(el("p", "message", o.intendedAction));
		li.append(el("p", "meta", `Why not: ${o.rationale}`));
		li.append(
			el(
				"p",
				"meta",
				`${when(o.createdAt)} · ${o.authorId} in ${o.sourceId}${o.threadId ? ` / ${o.threadId}` : ""}`,
			),
		);
		list.append(li);
	}
}

async function refresh() {
	try {
		const [attention, observations] = await Promise.all([
			getJson("/api/attention-items"),
			getJson("/api/observe-log?limit=50"),
		]);
		renderAttention(attention.items);
		renderObservations(observations.entries);
		showError("");
	} catch (error) {
		showError(String(error.message ?? error));
	}
}

void refresh();
setInterval(refresh, 15000);
