import fs from 'node:fs/promises';
import {z} from 'zod';
import {defineTool} from './types.js';
import {resolveInCwd} from './paths.js';
import {walk} from './walk.js';

const MAX_ENTRIES = 500;

export const listDir = defineTool({
	name: 'list_dir',
	description:
		'List files and directories (directories end with "/"). With recursive=true, walks subdirectories, skipping files ' +
		'ignored by .gitignore; ignored directories such as node_modules are listed but not entered. To find files by ' +
		'name, glob is usually better.',
	schema: z.object({
		path: z.string().optional().describe('Directory, relative to the working directory (default ".")'),
		recursive: z.boolean().optional().describe('Recurse into subdirectories (default false)'),
	}),
	kind: 'read',
	describe: args => `${args.path ?? '.'}${args.recursive ? ' (recursive)' : ''}`,
	async run({path = '.', recursive = false}, {cwd, signal}) {
		const root = resolveInCwd(cwd, path);
		const out: string[] = [];
		if (!recursive) {
			// A plain listing shows everything, like ls -a without . and ..
			const entries = await fs.readdir(root, {withFileTypes: true});
			entries.sort((a, b) => a.name.localeCompare(b.name));
			for (const entry of entries.slice(0, MAX_ENTRIES)) out.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
		} else {
			for await (const entry of walk(root, {cwd, signal, reportIgnoredDirs: true})) {
				if (out.length >= MAX_ENTRIES) break;
				out.push(entry.dir ? `${entry.rel}/${entry.ignored ? ' (ignored, not listed)' : ''}` : entry.rel);
			}
		}
		if (out.length === 0) return '(empty directory)';
		return out.join('\n') + (out.length >= MAX_ENTRIES ? `\n... (stopped at ${MAX_ENTRIES} entries)` : '');
	},
});
