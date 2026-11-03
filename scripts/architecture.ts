/**
 * The Dependency Rule, as data plus pure checks:
 *
 *   domain       -> (nothing outside itself)
 *   application  -> @casiagent/domain
 *   adapters     -> @casiagent/domain, @casiagent/application, external libraries, bun:/node:
 *   apps/*       -> anything (composition root)
 *
 * Relative imports may not leave their own package's `src/` directory.
 */
import { dirname, resolve, sep } from "node:path";

export interface LayerRule {
	/** Package directory relative to the repo root. */
	readonly dir: string;
	/** Returns an error message if the bare (non-relative) specifier is not allowed. */
	readonly checkBare: (specifier: string) => string | undefined;
}

export const LAYERS: readonly LayerRule[] = [
	{
		dir: "packages/domain",
		checkBare: (s) => `domain must not import "${s}" (domain has zero dependencies)`,
	},
	{
		dir: "packages/application",
		checkBare: (s) =>
			s === "@casiagent/domain"
				? undefined
				: `application may only import @casiagent/domain, not "${s}"`,
	},
	{
		dir: "packages/adapters",
		checkBare: (s) =>
			s.startsWith("@casiagent/") && s !== "@casiagent/domain" && s !== "@casiagent/application"
				? `adapters must not import "${s}"`
				: undefined,
	},
];

/**
 * Regex scan rather than Bun.Transpiler.scanImports, which omits type-only imports
 * (`import type`, `export type ... from`). Those still couple layers.
 * A false positive (e.g. inside a comment) fails loudly, which is the safe direction.
 */
const IMPORT_PATTERNS: readonly RegExp[] = [
	/\b(?:import|export)\s[^"'`;]*?\bfrom\s*["']([^"']+)["']/g, // import ... from / export ... from
	/\bimport\s*["']([^"']+)["']/g, // side-effect import
	/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import / require
];

export function scanSpecifiers(code: string): string[] {
	return IMPORT_PATTERNS.flatMap((re) => [...code.matchAll(re)].map((m) => m[1] ?? ""));
}

/** Violations for one file. `srcDir` and `file` are absolute paths. */
export function checkFile(rule: LayerRule, srcDir: string, file: string, code: string): string[] {
	const violations: string[] = [];
	for (const specifier of scanSpecifiers(code)) {
		if (specifier.startsWith(".")) {
			const target = resolve(dirname(file), specifier);
			if (target !== srcDir && !target.startsWith(srcDir + sep)) {
				violations.push(`relative import "${specifier}" leaves ${rule.dir}/src`);
			}
			continue;
		}
		const error = rule.checkBare(specifier);
		if (error !== undefined) violations.push(error);
	}
	return violations;
}
