import fs from 'node:fs/promises';
import {z} from 'zod';
import {defineTool} from './types.js';
import {resolveInCwd, truncate} from './paths.js';

export const readFile = defineTool({
	name: 'read_file',
	description:
		'Read a text file. Returns lines prefixed with line numbers. Use offset/limit to page through large files.',
	schema: z.object({
		path: z.string().describe('File path, relative to the working directory'),
		offset: z.number().int().min(1).optional().describe('1-based line to start at'),
		limit: z.number().int().min(1).optional().describe('Maximum number of lines (default 2000)'),
	}),
	kind: 'read',
	describe: args => args.path,
	async run({path, offset = 1, limit = 2000}, {cwd}) {
		const text = await fs.readFile(resolveInCwd(cwd, path), 'utf8');
		const lines = text.split('\n');
		const slice = lines.slice(offset - 1, offset - 1 + limit);
		const body = slice.map((line, i) => `${String(offset + i).padStart(5)}  ${line}`).join('\n');
		const more = offset - 1 + limit < lines.length ? `\n... (${lines.length} lines total)` : '';
		return truncate(body + more) || '(empty file)';
	},
});
