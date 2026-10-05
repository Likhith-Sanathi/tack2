import fs from 'node:fs/promises';
import {z} from 'zod';
import {defineTool} from './types.js';
import {resolveInCwd} from './paths.js';
import {diffFile} from './diff.js';
import {applyEdit, type Edit} from './edit-file.js';

/** Applies the edits in order, each to the result of the previous one; throws naming the edit that fails. */
async function applyAll(path: string, edits: Edit[], cwd: string) {
	const target = resolveInCwd(cwd, path);
	const before = await fs.readFile(target, 'utf8');
	let after = before;
	let replaced = 0;
	edits.forEach((edit, i) => {
		try {
			const result = applyEdit(after, edit);
			after = result.text;
			replaced += result.count;
		} catch (error) {
			throw new Error(`edit ${i + 1} of ${edits.length}: ${(error as Error).message}. No changes were made.`);
		}
	});
	return {target, before, after, replaced};
}

export const multiEdit = defineTool({
	name: 'multi_edit',
	description:
		'Make several exact-string replacements in one file in a single step. Edits apply in order, each to the result ' +
		'of the previous one, and either all succeed or none are written. Each old_string must match exactly and be ' +
		'unique unless replace_all is true. Read the file first.',
	schema: z.object({
		path: z.string().describe('File path, relative to the working directory'),
		edits: z
			.array(
				z.object({
					old_string: z.string().min(1).describe('Exact text to replace'),
					new_string: z.string().describe('Replacement text'),
					replace_all: z.boolean().optional().describe('Replace every occurrence (default false)'),
				}),
			)
			.min(1)
			.describe('Edits to apply, in order'),
	}),
	kind: 'edit',
	describe: args => `${args.path} (${args.edits.length} edit${args.edits.length === 1 ? '' : 's'})`,
	async preview({path, edits}, {cwd}) {
		const {before, after} = await applyAll(path, edits, cwd);
		return diffFile(path, before, after);
	},
	async run({path, edits}, {cwd}) {
		const {target, after, replaced} = await applyAll(path, edits, cwd);
		await fs.writeFile(target, after, 'utf8');
		return `Applied ${edits.length} edit(s) to ${path} (${replaced} replacement(s))`;
	},
});
