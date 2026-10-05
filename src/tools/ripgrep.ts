// Runs the bundled ripgrep (@vscode/ripgrep) for the search tool. Its flags are chosen so it
// skips the same files as the JavaScript fallback in walk.ts.

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import nodePath from 'node:path';
import {IGNORED_DIRS} from './paths.js';

/** Matches in one file: 1-based line numbers of hits, and the text of every line returned. */
export type FileHits = {rel: string; hits: number[]; lines: Map<number, string>};

export type SearchQuery = {
	/** Directory or file to search. */
	root: string;
	/** How a file path is shown when `root` is a single file. */
	fileLabel: string;
	pattern: string;
	ignoreCase: boolean;
	glob?: string;
	context: number;
	/** Stop after this many files with matches, or this many matching lines. */
	maxFiles: number;
	maxMatches: number;
	signal: AbortSignal;
};

export type SearchResult = {files: FileHits[]; capped: boolean};

let cachedPath: string | null | undefined;

/** The bundled ripgrep binary, or null if it isn't installed for this platform. */
async function ripgrepPath(): Promise<string | null> {
	if (cachedPath !== undefined) return cachedPath;
	try {
		const {rgPath} = await import('@vscode/ripgrep');
		cachedPath = fs.existsSync(rgPath) ? rgPath : null;
	} catch {
		cachedPath = null;
	}
	return cachedPath;
}

type RgEvent =
	| {type: 'begin'; data: {path: RgText}}
	| {type: 'match' | 'context'; data: {path: RgText; line_number: number; lines: RgText}}
	| {type: 'end' | 'summary'; data: unknown};
type RgText = {text?: string; bytes?: string};

const decode = (t: RgText) => t.text ?? Buffer.from(t.bytes ?? '', 'base64').toString('utf8');

/**
 * Searches with ripgrep. Returns null when ripgrep can't be used (not installed, disabled with
 * TACK_NO_RIPGREP, or it rejects the pattern), so the caller falls back to the JavaScript search.
 */
export async function ripgrepSearch(query: SearchQuery): Promise<SearchResult | null> {
	if (process.env.TACK_NO_RIPGREP) return null;
	const rg = await ripgrepPath();
	if (!rg) return null;

	const isFile = fs.statSync(query.root).isFile();
	const args = [
		'--json',
		'--line-number',
		// Lookarounds and backreferences switch to PCRE2, close to JavaScript regex syntax.
		'--engine=auto',
		// Deterministic order (and it stops ripgrep's parallel walk from racing our limits).
		'--sort=path',
		'--max-filesize=1M',
		// Match the fallback: honor .gitignore even outside a git repo, include dotfiles, but skip
		// .git and the always-skipped directories.
		'--no-require-git',
		'--hidden',
		...[...IGNORED_DIRS].map(dir => `--glob=!${dir}/`),
		...(query.ignoreCase ? ['--ignore-case'] : []),
		...(query.context > 0 ? [`--context=${query.context}`] : []),
		...(query.glob ? [`--glob=${query.glob}`] : []),
		'--regexp',
		query.pattern,
		'--',
		isFile ? query.root : '.',
	];

	return new Promise(resolve => {
		const child = spawn(rg, args, {cwd: isFile ? nodePath.dirname(query.root) : query.root, stdio: ['ignore', 'pipe', 'pipe']});
		const files: FileHits[] = [];
		let matches = 0;
		let capped = false;
		let pending = '';
		const stop = () => child.kill();
		query.signal.addEventListener('abort', stop, {once: true});

		const handle = (event: RgEvent) => {
			if (event.type === 'begin') {
				if (files.length >= query.maxFiles) {
					capped = true;
					return stop();
				}
				const raw = decode(event.data.path);
				const rel = isFile ? query.fileLabel : nodePath.normalize(raw);
				files.push({rel, hits: [], lines: new Map()});
			} else if (event.type === 'match' || event.type === 'context') {
				const file = files.at(-1);
				if (!file) return;
				// Strip only the line ending, as the fallback does.
				const text = decode(event.data.lines).replace(/\r?\n$/, '');
				// A multi-line event can't happen without --multiline, but take the first line if it does.
				file.lines.set(event.data.line_number, text.split('\n')[0]!);
				if (event.type === 'match') {
					if (matches >= query.maxMatches) {
						capped = true;
						return stop();
					}
					file.hits.push(event.data.line_number);
					matches++;
				}
			}
		};

		child.stdout.on('data', (chunk: Buffer) => {
			pending += chunk.toString();
			let newline: number;
			while ((newline = pending.indexOf('\n')) !== -1) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				if (line) handle(JSON.parse(line) as RgEvent);
			}
		});
		child.stderr.resume(); // ripgrep's errors only matter through its exit code
		child.on('error', () => resolve(null));
		child.on('close', code => {
			query.signal.removeEventListener('abort', stop);
			// 0: matches, 1: no matches. Anything else (bad pattern, crash) means fall back, unless we
			// stopped ripgrep ourselves after collecting enough.
			if (code === 0 || code === 1 || capped || query.signal.aborted) {
				resolve({files: files.filter(f => f.hits.length > 0), capped});
			} else {
				resolve(null);
			}
		});
	});
}
