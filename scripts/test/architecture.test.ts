import { describe, expect, test } from "bun:test";
import { checkFile, LAYERS, type LayerRule, scanSpecifiers } from "../architecture";

function layer(dir: string): LayerRule {
	const rule = LAYERS.find((l) => l.dir === dir);
	if (rule === undefined) throw new Error(`no layer ${dir}`);
	return rule;
}

const SRC = "/repo/packages/domain/src";

describe("scanSpecifiers", () => {
	test("finds type-only, re-export, side-effect, dynamic and multi-line imports", () => {
		const code = [
			`import type { A } from "type-only";`,
			`import { type B } from "inline-type";`,
			`export type { C } from "re-export-type";`,
			`export * from "star";`,
			`import "side-effect";`,
			`const d = await import("dynamic");`,
			`import {\n  e,\n  f,\n} from "multi-line";`,
			`import g from 'single-quoted';`,
		].join("\n");
		expect(scanSpecifiers(code).sort()).toEqual(
			[
				"type-only",
				"inline-type",
				"re-export-type",
				"star",
				"side-effect",
				"dynamic",
				"multi-line",
				"single-quoted",
			].sort(),
		);
	});
});

describe("checkFile", () => {
	const domain = layer("packages/domain");

	test("domain: relative imports inside src are allowed", () => {
		expect(
			checkFile(domain, SRC, `${SRC}/entities/A.ts`, `import { x } from "../ports/B";`),
		).toEqual([]);
	});

	test("domain: any bare import is rejected, including type-only and bun:", () => {
		const code = `import type { X } from "@superagent/adapters";\nimport { Database } from "bun:sqlite";`;
		expect(checkFile(domain, SRC, `${SRC}/A.ts`, code)).toHaveLength(2);
	});

	test("relative import escaping src is rejected, including a sibling with a shared prefix", () => {
		const file = `${SRC}/A.ts`;
		expect(checkFile(domain, SRC, file, `import "../../adapters/src/x";`)).toHaveLength(1);
		expect(checkFile(domain, SRC, file, `import "../src-old/x";`)).toHaveLength(1);
	});

	test("application: only @superagent/domain", () => {
		const app = layer("packages/application");
		const src = "/repo/packages/application/src";
		expect(checkFile(app, src, `${src}/a.ts`, `import { T } from "@superagent/domain";`)).toEqual(
			[],
		);
		expect(checkFile(app, src, `${src}/a.ts`, `import "@superagent/adapters";`)).toHaveLength(1);
		expect(checkFile(app, src, `${src}/a.ts`, `import "node:fs";`)).toHaveLength(1);
	});

	test("adapters: externals allowed, runtime is not", () => {
		const adapters = layer("packages/adapters");
		const src = "/repo/packages/adapters/src";
		const ok = `import "bun:sqlite"; import "@superagent/application"; import "zod";`;
		expect(checkFile(adapters, src, `${src}/a.ts`, ok)).toEqual([]);
		expect(checkFile(adapters, src, `${src}/a.ts`, `import "@superagent/runtime";`)).toHaveLength(
			1,
		);
	});
});
