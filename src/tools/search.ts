import fs from 'node:fs/promises';
import picomatch from 'picomatch';
import {z} from 'zod';
import {defineTool} from './types.js';
import {resolveInCwd, truncate} from './paths.js';
import {walk} from './walk.js';

const MAX_MATCHES = 200;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 1_000_000;

export const search = defineTool({
	name: 'search',
	description:
		'Search file contents with a regular expression, skipping files ignored by .gitignore. Returns matching lines as ' +
		'"path:line: text"; with context, surrounding lines appear as "path-line- text" and separate groups are split by "--". ' +
		'Use files_only to just list the files that match. Restrict files with a glob such as "*.ts" or "src/**/*.py".',
	schema: z.object({
		pattern: z.string().describe('JavaScript regular expression'),
		path: z.string().optional().describe('Directory or file to search, relative to the working directory (default ".")'),
		glob: z.string().optional().describe('Only search files whose relative path matches this glob'),
		ignore_case: z.boolean().optional(),
		context: z.number().int().min(0).max(10).optional().describe('Lines to show before and after each match (default 0)'),
		files_only: z.boolean().optional().describe('List matching files with their match counts instead of lines'),
	}),
	kind: 'read',
	describe: args => `/${args.pattern}/${args.glob ? ` in ${args.glob}` : ''}${args.path ? ` under ${args.path}` : ''}`,
	async run({pattern, path = '.', glob, ignore_case, context = 0, files_only}, {cwd, signal}) {
		const root = resolveInCwd(cwd, path);
		const regex = new RegExp(pattern, ignore_case ? 'i' : '');
		const matchesGlob = glob ? picomatch(glob, {basename: !glob.includes('/'), dot: true}) : () => true;
		const stat = await fs.stat(root);
		const files = stat.isFile()
			? [{path: root, rel: path}]
			: await (async () => {
					const found: Array<{path: string; rel: string}> = [];
					for await (const entry of walk(root, {cwd, signal})) if (!entry.dir) found.push(entry);
					return found;
				})();

		const out: string[] = [];
		let matchCount = 0;
		let fileCount = 0;
		for (const file of files) {
			if (signal.aborted || matchCount >= MAX_MATCHES || fileCount >= MAX_FILES) break;
			if (!matchesGlob(file.rel)) continue;
			if ((await fs.stat(file.path)).size > MAX_FILE_BYTES) continue;
			const text = await fs.readFile(file.path, 'utf8');
			if (text.includes('\0')) continue; // binary
			const lines = text.split('\n');
			if (lines.at(-1) === '') lines.pop(); // the trailing newline isn't a line
			const hits = lines.flatMap((line, i) => (regex.test(line) ? [i] : []));
			if (hits.length === 0) continue;
			fileCount++;
			if (files_only) {
				out.push(`${file.rel} (${hits.length} match${hits.length === 1 ? '' : 'es'})`);
				matchCount += hits.length;
				continue;
			}
			// Print each hit with its context, merging overlapping ranges like grep does.
			let printedUpTo = -1;
			for (const hit of hits) {
				if (matchCount >= MAX_MATCHES) break;
				matchCount++;
				const from = Math.max(0, hit - context, printedUpTo + 1);
				const to = Math.min(lines.length - 1, hit + context);
				if (context > 0 && printedUpTo >= 0 && from > printedUpTo + 1) out.push('--');
				for (let i = from; i <= to; i++) {
					const isHit = i === hit || (i > hit && regex.test(lines[i]!));
					const separator = isHit ? ':' : '-';
					out.push(`${file.rel}${separator}${i + 1}${separator} ${lines[i]!.trimEnd().slice(0, 300)}`);
				}
				printedUpTo = to;
			}
			if (context > 0) out.push('--');
		}
		if (out.at(-1) === '--') out.pop();
		if (out.length === 0) return 'No matches.';
		const capped = matchCount >= MAX_MATCHES || fileCount >= MAX_FILES ? '\n... (stopped early; narrow the search)' : '';
		return truncate(out.join('\n') + capped);
	},
});
