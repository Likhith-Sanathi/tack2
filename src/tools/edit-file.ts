import fs from 'node:fs/promises';
import {z} from 'zod';
import {defineTool} from './types.js';
import {resolveInCwd} from './paths.js';
import {diffFile} from './diff.js';

export type Edit = {old_string: string; new_string: string; replace_all?: boolean};

/** Applies one edit to text; throws if old_string is missing or ambiguous. Shared with multi_edit. */
export function applyEdit(text: string, {old_string, new_string, replace_all}: Edit): {text: string; count: number} {
	const count = text.split(old_string).length - 1;
	if (count === 0) throw new Error('old_string not found in file');
	if (count > 1 && !replace_all) {
		throw new Error(`old_string occurs ${count} times; add more context or set replace_all`);
	}
	// Use a replacer function so `$` sequences in new_string are inserted literally.
	const updated = replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, () => new_string);
	return {text: updated, count: replace_all ? count : 1};
}

async function editInMemory(args: Edit & {path: string}, cwd: string) {
	const target = resolveInCwd(cwd, args.path);
	const before = await fs.readFile(target, 'utf8');
	const {text: after, count} = applyEdit(before, args);
	return {target, before, after, count};
}

export const editFile = defineTool({
	name: 'edit_file',
	description:
		'Replace an exact string in a file. old_string must match exactly (including whitespace) and be unique unless replace_all is true. Read the file first. For several changes to one file, use multi_edit.',
	schema: z.object({
		path: z.string().describe('File path, relative to the working directory'),
		old_string: z.string().min(1).describe('Exact text to replace'),
		new_string: z.string().describe('Replacement text'),
		replace_all: z.boolean().optional().describe('Replace every occurrence (default false)'),
	}),
	kind: 'edit',
	describe: args => args.path,
	async preview(args, {cwd}) {
		const {before, after} = await editInMemory(args, cwd);
		return diffFile(args.path, before, after);
	},
	async run(args, {cwd}) {
		const {target, after, count} = await editInMemory(args, cwd);
		await fs.writeFile(target, after, 'utf8');
		return `Replaced ${count} occurrence(s) in ${args.path}`;
	},
});
