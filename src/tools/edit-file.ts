import fs from 'node:fs/promises';
import {z} from 'zod';
import {defineTool} from './types.js';
import {resolveInCwd} from './paths.js';

export const editFile = defineTool({
	name: 'edit_file',
	description:
		'Replace an exact string in a file. old_string must match exactly (including whitespace) and be unique unless replace_all is true. Read the file first.',
	schema: z.object({
		path: z.string().describe('File path, relative to the working directory'),
		old_string: z.string().min(1).describe('Exact text to replace'),
		new_string: z.string().describe('Replacement text'),
		replace_all: z.boolean().optional().describe('Replace every occurrence (default false)'),
	}),
	requiresApproval: true,
	describe: args => args.path,
	preview: args =>
		[
			...args.old_string.split('\n').map(l => `- ${l}`),
			...args.new_string.split('\n').map(l => `+ ${l}`),
		].join('\n'),
	async run({path, old_string, new_string, replace_all}, {cwd}) {
		const target = resolveInCwd(cwd, path);
		const text = await fs.readFile(target, 'utf8');
		const count = text.split(old_string).length - 1;
		if (count === 0) throw new Error('old_string not found in file');
		if (count > 1 && !replace_all) {
			throw new Error(`old_string occurs ${count} times; add more context or set replace_all`);
		}
		// Use a replacer function so `$` sequences in new_string are inserted literally.
		const updated = replace_all
			? text.split(old_string).join(new_string)
			: text.replace(old_string, () => new_string);
		await fs.writeFile(target, updated, 'utf8');
		return `Replaced ${replace_all ? count : 1} occurrence(s) in ${path}`;
	},
});
