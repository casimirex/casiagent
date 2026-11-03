/** CLI: scans every layer's src/ and exits non-zero on any Dependency Rule violation. */
import { join, relative, resolve } from "node:path";
import { Glob } from "bun";
import { checkFile, LAYERS } from "./architecture";

const ROOT = resolve(import.meta.dir, "..");
const violations: string[] = [];

for (const rule of LAYERS) {
	const srcDir = join(ROOT, rule.dir, "src");
	for await (const file of new Glob("**/*.ts").scan({ cwd: srcDir, absolute: true })) {
		const code = await Bun.file(file).text();
		for (const v of checkFile(rule, srcDir, file, code)) {
			violations.push(`${relative(ROOT, file)}: ${v}`);
		}
	}
}

if (violations.length > 0) {
	console.error(`Dependency Rule violations (${violations.length}):`);
	for (const v of violations) console.error(`  - ${v}`);
	process.exit(1);
}
console.log("Dependency Rule: OK");
