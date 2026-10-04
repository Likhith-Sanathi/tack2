import fs from 'node:fs/promises';
import nodePath from 'node:path';
import {z} from 'zod';
import {defineTool} from './types.js';
import {IGNORED_DIRS, resolveInCwd} from './paths.js';

const MAX_ENTRIES = 500;

export const listDir = defineTool({
	name: 'list_dir',
	description:
		'List files and directories (directories end with "/"). With recursive=true, walks subdirectories, skipping .git, node_modules and build output.',
	schema: z.object({
		path: z.string().optional().describe('Directory, relative to the working directory (default ".")'),
		recursive: z.boolean().optional().describe('Recurse into subdirectories (default false)'),
	}),
	kind: 'read',
	describe: args => `${args.path ?? '.'}${args.recursive ? ' (recursive)' : ''}`,
	async run({path = '.', recursive = false}, {cwd, signal}) {
		const root = resolveInCwd(cwd, path);
		const out: string[] = [];
		const walk = async (dir: string): Promise<void> => {
			const entries = await fs.readdir(dir, {withFileTypes: true});
			entries.sort((a, b) => a.name.localeCompare(b.name));
			for (const entry of entries) {
				if (out.length >= MAX_ENTRIES || signal.aborted) return;
				const rel = nodePath.relative(root, nodePath.join(dir, entry.name));
				if (entry.isDirectory()) {
					out.push(`${rel}/`);
					if (recursive && !IGNORED_DIRS.has(entry.name)) await walk(nodePath.join(dir, entry.name));
				} else {
					out.push(rel);
				}
			}
		};
		await walk(root);
		if (out.length === 0) return '(empty directory)';
		return out.join('\n') + (out.length >= MAX_ENTRIES ? `\n... (stopped at ${MAX_ENTRIES} entries)` : '');
	},
});
