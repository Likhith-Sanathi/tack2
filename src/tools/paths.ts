import path from 'node:path';

/** Resolves `p` against `cwd` and refuses paths that escape it. */
export function resolveInCwd(cwd: string, p: string): string {
	const resolved = path.resolve(cwd, p);
	const rel = path.relative(cwd, resolved);
	if (rel.startsWith('..') || path.isAbsolute(rel)) {
		throw new Error(`Path is outside the working directory: ${p}`);
	}
	return resolved;
}

export const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '__pycache__', '.venv']);

export function truncate(text: string, max = 30_000): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n... [truncated ${text.length - max} characters]`;
}
