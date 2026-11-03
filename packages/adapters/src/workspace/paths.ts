import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class PathError extends Error {
	override readonly name = "PathError";
}

function inside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Resolve the deepest existing ancestor of `path` through symlinks. */
async function realExistingAncestor(path: string): Promise<string> {
	let current = path;
	for (;;) {
		try {
			return await realpath(current);
		} catch {
			const parent = dirname(current);
			if (parent === current) throw new PathError(`no existing ancestor for ${path}`);
			current = parent;
		}
	}
}

/**
 * Resolve a model-supplied relative path inside `root`, or throw PathError.
 *
 * Rejects absolute paths, `..` escapes, any `.git` path segment (the worktree's git
 * metadata, whose edits could redirect git), and symlinks that lead outside the root,
 * checked on the real path of the target (or, for a file that does not exist yet,
 * of its nearest existing ancestor). For writes, an existing symlink is refused outright.
 */
export async function resolveInside(
	root: string,
	userPath: string,
	mode: "read" | "write",
): Promise<string> {
	if (userPath.includes("\0")) throw new PathError("path contains a NUL byte");
	if (isAbsolute(userPath))
		throw new PathError(`use a path relative to the repository root, not ${userPath}`);
	const realRoot = await realpath(root);
	const target = resolve(realRoot, userPath);
	if (!inside(realRoot, target)) throw new PathError(`path ${userPath} is outside the repository`);
	if (relative(realRoot, target).split(sep).includes(".git")) {
		throw new PathError("paths inside .git are not accessible");
	}

	if (mode === "write") {
		const stat = await lstat(target).catch(() => undefined);
		if (stat?.isSymbolicLink())
			throw new PathError(`refusing to write through symlink ${userPath}`);
	}
	const real = await realExistingAncestor(target);
	if (!inside(realRoot, real)) throw new PathError(`path ${userPath} leads outside the repository`);
	// Also on the real path: a symlink such as `x -> .git` must not reach git metadata.
	if (relative(realRoot, real).split(sep).includes(".git")) {
		throw new PathError("paths inside .git are not accessible");
	}
	return target;
}
