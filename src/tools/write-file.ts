import fs from 'node:fs/promises';
import nodePath from 'node:path';
import {z} from 'zod';
import {defineTool} from './types.js';
import {resolveInCwd} from './paths.js';

export const writeFile = defineTool({
	name: 'write_file',
	description: 'Create a file or overwrite it entirely with new content. Parent directories are created as needed.',
	schema: z.object({
		path: z.string().describe('File path, relative to the working directory'),
		content: z.string().describe('Full file content'),
	}),
	requiresApproval: true,
	describe: args => `${args.path} (${args.content.trimEnd().split('\n').length} lines)`,
	preview: args => args.content,
	async run({path, content}, {cwd}) {
		const target = resolveInCwd(cwd, path);
		await fs.mkdir(nodePath.dirname(target), {recursive: true});
		await fs.writeFile(target, content, 'utf8');
		return `Wrote ${content.length} characters to ${path}`;
	},
});
