import fs from 'node:fs/promises';
import nodePath from 'node:path';
import picomatch from 'picomatch';
import {z} from 'zod';
import {defineTool} from './types.js';
import {IGNORED_DIRS, resolveInCwd} from './paths.js';

const MAX_MATCHES = 200;
const MAX_FILE_BYTES = 1_000_000;

export const search = defineTool({
	name: 'search',
	description:
		'Search file contents with a regular expression. Returns matching lines as "path:line: text". Optionally restrict files with a glob such as "*.ts" or "src/**/*.py".',
	schema: z.object({
		pattern: z.string().describe('JavaScript regular expression'),
		path: z.string().optional().describe('Directory to search, relative to the working directory (default ".")'),
		glob: z.string().optional().describe('Only search files whose relative path matches this glob'),
		ignore_case: z.boolean().optional(),
	}),
	kind: 'read',
	describe: args => `/${args.pattern}/${args.glob ? ` in ${args.glob}` : ''}`,
	async run({pattern, path = '.', glob, ignore_case}, {cwd, signal}) {
		const root = resolveInCwd(cwd, path);
		const regex = new RegExp(pattern, ignore_case ? 'i' : '');
		const matchesGlob = glob ? picomatch(glob, {basename: !glob.includes('/'), dot: true}) : () => true;
		const results: string[] = [];

		const walk = async (dir: string): Promise<void> => {
			for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
				if (results.length >= MAX_MATCHES || signal.aborted) return;
				const full = nodePath.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (!IGNORED_DIRS.has(entry.name)) await walk(full);
					continue;
				}
				const rel = nodePath.relative(root, full);
				if (!entry.isFile() || !matchesGlob(rel)) continue;
				const stat = await fs.stat(full);
				if (stat.size > MAX_FILE_BYTES) continue;
				const text = await fs.readFile(full, 'utf8');
				if (text.includes('\0')) continue; // binary
				text.split('\n').forEach((line, i) => {
					if (results.length < MAX_MATCHES && regex.test(line)) {
						results.push(`${rel}:${i + 1}: ${line.trim().slice(0, 300)}`);
					}
				});
			}
		};
		await walk(root);
		if (results.length === 0) return 'No matches.';
		return results.join('\n') + (results.length >= MAX_MATCHES ? `\n... (stopped at ${MAX_MATCHES} matches)` : '');
	},
});
