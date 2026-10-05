// Walks a directory tree the way git sees it: .gitignore files (at every level, plus
// .git/info/exclude) are honored, and a few heavy directories are always skipped.

import fs from 'node:fs/promises';
import nodePath from 'node:path';
import ignore, {type Ignore} from 'ignore';
import {IGNORED_DIRS} from './paths.js';

type Rules = {base: string; ig: Ignore};

export type WalkEntry = {
	path: string;
	/** Path relative to the walk's root. */
	rel: string;
	dir: boolean;
	/** An ignored directory, reported (when asked) but not entered. */
	ignored?: boolean;
};

async function loadRules(dir: string, file: string): Promise<Rules | undefined> {
	try {
		return {base: dir, ig: ignore().add(await fs.readFile(nodePath.join(dir, file), 'utf8'))};
	} catch {
		return undefined;
	}
}

function isIgnored(rules: Rules[], path: string, dir: boolean): boolean {
	return rules.some(({base, ig}) => {
		const rel = nodePath.relative(base, path).split(nodePath.sep).join('/');
		return rel !== '' && !rel.startsWith('..') && ig.ignores(dir ? `${rel}/` : rel);
	});
}

/**
 * Yields entries under `root` in name order. `cwd` is where rule lookup starts, so walking a
 * subdirectory still honors the .gitignore files above it.
 */
export async function* walk(
	root: string,
	options: {cwd: string; recursive?: boolean; signal?: AbortSignal; reportIgnoredDirs?: boolean},
): AsyncGenerator<WalkEntry> {
	const rules: Rules[] = [];
	const exclude = await loadRules(nodePath.join(options.cwd, '.git', 'info'), 'exclude');
	if (exclude) rules.push({base: options.cwd, ig: exclude.ig});
	// .gitignore files from cwd down to the root's parent.
	const above = nodePath.relative(options.cwd, root).split(nodePath.sep).filter(Boolean);
	for (let i = 0; i < above.length; i++) {
		const found = await loadRules(nodePath.join(options.cwd, ...above.slice(0, i)), '.gitignore');
		if (found) rules.push(found);
	}

	async function* visit(dir: string, inherited: Rules[]): AsyncGenerator<WalkEntry> {
		const own = await loadRules(dir, '.gitignore');
		const active = own ? [...inherited, own] : inherited;
		const entries = await fs.readdir(dir, {withFileTypes: true}).catch(() => []);
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (options.signal?.aborted) return;
			const path = nodePath.join(dir, entry.name);
			const rel = nodePath.relative(root, path);
			const isDir = entry.isDirectory();
			if (isDir) {
				if (IGNORED_DIRS.has(entry.name) || isIgnored(active, path, true)) {
					if (options.reportIgnoredDirs) yield {path, rel, dir: true, ignored: true};
					continue;
				}
				yield {path, rel, dir: true};
				if (options.recursive !== false) yield* visit(path, active);
			} else if (entry.isFile() && !isIgnored(active, path, false)) {
				yield {path, rel, dir: false};
			}
		}
	}
	yield* visit(root, rules);
}
