import fs from 'node:fs/promises';
import picomatch from 'picomatch';
import {z} from 'zod';
import {defineTool} from './types.js';
import {resolveInCwd, truncate} from './paths.js';
import {walk} from './walk.js';
import {ripgrepSearch, type FileHits, type SearchQuery, type SearchResult} from './ripgrep.js';

const MAX_MATCHES = 200;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 1_000_000;

/** The JavaScript search, used when the bundled ripgrep isn't available or rejects the pattern. */
async function javascriptSearch(query: SearchQuery, cwd: string): Promise<SearchResult> {
	const regex = new RegExp(query.pattern, query.ignoreCase ? 'i' : '');
	const matchesGlob = query.glob ? picomatch(query.glob, {basename: !query.glob.includes('/'), dot: true}) : () => true;
	const candidates: Array<{path: string; rel: string}> = [];
	if ((await fs.stat(query.root)).isFile()) {
		candidates.push({path: query.root, rel: query.fileLabel});
	} else {
		for await (const entry of walk(query.root, {cwd, signal: query.signal})) {
			if (!entry.dir && matchesGlob(entry.rel)) candidates.push(entry);
		}
	}

	const files: FileHits[] = [];
	let matches = 0;
	for (const file of candidates) {
		if (query.signal.aborted) break;
		if (files.length >= query.maxFiles || matches >= query.maxMatches) return {files, capped: true};
		if ((await fs.stat(file.path)).size > MAX_FILE_BYTES) continue;
		const text = await fs.readFile(file.path, 'utf8');
		if (text.includes('\0')) continue; // binary
		const lines = text.split('\n');
		if (lines.at(-1) === '') lines.pop(); // the trailing newline isn't a line
		const hits = lines.flatMap((line, i) => (regex.test(line) ? [i + 1] : [])).slice(0, query.maxMatches - matches);
		if (hits.length === 0) continue;
		matches += hits.length;
		files.push({rel: file.rel, hits, lines: new Map(lines.map((line, i) => [i + 1, line.replace(/\r$/, '')]))});
	}
	return {files, capped: matches >= query.maxMatches};
}

/** Formats hits grep-style: "path:line: text" for matches and "path-line- text" for context. */
function format(files: FileHits[], context: number, filesOnly: boolean): string[] {
	if (filesOnly) return files.map(f => `${f.rel} (${f.hits.length} match${f.hits.length === 1 ? '' : 'es'})`);
	const out: string[] = [];
	for (const file of files) {
		const hits = new Set(file.hits);
		let printedUpTo = 0;
		for (const hit of file.hits) {
			const from = Math.max(1, hit - context, printedUpTo + 1);
			// Nearby matches merge into one group; separate groups are split by "--".
			if (context > 0 && printedUpTo > 0 && from > printedUpTo + 1) out.push('--');
			for (let line = from; line <= hit + context; line++) {
				const text = file.lines.get(line);
				if (text === undefined) break; // past the end of the file
				const separator = hits.has(line) ? ':' : '-';
				out.push(`${file.rel}${separator}${line}${separator} ${text.trimEnd().slice(0, 300)}`);
				printedUpTo = line;
			}
		}
		if (context > 0) out.push('--');
	}
	if (out.at(-1) === '--') out.pop();
	return out;
}

export const search = defineTool({
	name: 'search',
	description:
		'Search file contents with a regular expression (ripgrep), skipping files ignored by .gitignore. Returns matching ' +
		'lines as "path:line: text"; with context, surrounding lines appear as "path-line- text" and separate groups are ' +
		'split by "--". Use files_only to just list the files that match. Restrict files with a glob such as "*.ts" or ' +
		'"src/**/*.py". Standard regex syntax, including lookarounds and backreferences.',
	schema: z.object({
		pattern: z.string().describe('Regular expression'),
		path: z.string().optional().describe('Directory or file to search, relative to the working directory (default ".")'),
		glob: z.string().optional().describe('Only search files whose relative path matches this glob'),
		ignore_case: z.boolean().optional(),
		context: z.number().int().min(0).max(10).optional().describe('Lines to show before and after each match (default 0)'),
		files_only: z.boolean().optional().describe('List matching files with their match counts instead of lines'),
	}),
	kind: 'read',
	describe: args => `/${args.pattern}/${args.glob ? ` in ${args.glob}` : ''}${args.path ? ` under ${args.path}` : ''}`,
	async run({pattern, path = '.', glob, ignore_case = false, context = 0, files_only = false}, {cwd, signal}) {
		const query: SearchQuery = {
			root: resolveInCwd(cwd, path),
			fileLabel: path,
			pattern,
			ignoreCase: ignore_case,
			glob,
			context: files_only ? 0 : context,
			maxFiles: MAX_FILES,
			maxMatches: MAX_MATCHES,
			signal,
		};
		const result = (await ripgrepSearch(query)) ?? (await javascriptSearch(query, cwd));
		const out = format(result.files, query.context, files_only);
		if (out.length === 0) return 'No matches.';
		return truncate(out.join('\n') + (result.capped ? '\n... (stopped early; narrow the search)' : ''));
	},
});
