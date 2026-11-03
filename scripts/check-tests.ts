/**
 * Catches `expect(promise).rejects/.resolves` without `await`. Such an assertion is never
 * checked by bun:test and the test passes vacuously. Biome's noFloatingPromises does not
 * see these (it cannot type bun's matchers), so this check fills the gap.
 */
import { relative, resolve } from "node:path";
import { Glob } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const UNAWAITED = /^(?!\s*(?:await|return)\b).*\bexpect\((?:.|\n)*?\)\s*\.(?:rejects|resolves)\b/;

export function findUnawaited(code: string): number[] {
	const lines = code.split("\n");
	const hits: number[] = [];
	lines.forEach((line, i) => {
		if (
			/\.(rejects|resolves)\b/.test(line) &&
			UNAWAITED.test(line) &&
			!/\bawait\s+expect\(/.test(line)
		) {
			hits.push(i + 1);
		}
	});
	return hits;
}

if (import.meta.main) {
	const problems: string[] = [];
	// scripts/test is excluded: its fixtures contain these patterns on purpose.
	for (const pattern of ["packages/*/test/**/*.ts", "apps/*/test/**/*.ts"]) {
		for await (const file of new Glob(pattern).scan({ cwd: ROOT, absolute: true })) {
			for (const line of findUnawaited(await Bun.file(file).text())) {
				problems.push(
					`${relative(ROOT, file)}:${line}: expect(...).rejects/resolves must be awaited`,
				);
			}
		}
	}
	if (problems.length > 0) {
		console.error(problems.join("\n"));
		process.exit(1);
	}
	console.log("Test assertions: OK");
}
