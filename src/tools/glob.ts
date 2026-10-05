import fs from 'node:fs/promises';
import picomatch from 'picomatch';
import {z} from 'zod';
import {defineTool} from './types.js';
import {resolveInCwd} from './paths.js';
import {walk} from './walk.js';

const MAX_RESULTS = 200;

export const glob = defineTool({
	name: 'glob',
	description:
		'Find files by name pattern, e.g. "**/*.test.ts", "src/**/index.*" or "*.md" (a pattern without "/" matches ' +
		'file names at any depth). Skips files ignored by .gitignore. Returns paths, most recently modified first.',
	schema: z.object({
		pattern: z.string().describe('Glob pattern, relative to path'),
		path: z.string().optional().describe('Directory to search, relative to the working directory (default ".")'),
	}),
	kind: 'read',
	describe: args => `${args.pattern}${args.path ? ` under ${args.path}` : ''}`,
	async run({pattern, path = '.'}, {cwd, signal}) {
		const root = resolveInCwd(cwd, path);
		const matches = picomatch(pattern, {basename: !pattern.includes('/'), dot: true});
		const found: Array<{rel: string; mtime: number}> = [];
		for await (const entry of walk(root, {cwd, signal})) {
			if (entry.dir || !matches(entry.rel)) continue;
			const stat = await fs.stat(entry.path).catch(() => undefined);
			found.push({rel: entry.rel, mtime: stat?.mtimeMs ?? 0});
		}
		if (found.length === 0) return 'No files match.';
		found.sort((a, b) => b.mtime - a.mtime || a.rel.localeCompare(b.rel));
		const shown = found.slice(0, MAX_RESULTS).map(f => f.rel);
		const more = found.length > MAX_RESULTS ? `\n... (${found.length - MAX_RESULTS} more; narrow the pattern)` : '';
		return shown.join('\n') + more;
	},
});
