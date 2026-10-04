import {spawn} from 'node:child_process';
import {z} from 'zod';
import {defineTool} from './types.js';
import {truncate} from './paths.js';

const DEFAULT_TIMEOUT_MS = 120_000;

export const bash = defineTool({
	name: 'bash',
	description:
		'Run a shell command in the working directory and return its combined stdout/stderr and exit code. Commands are non-interactive; avoid ones that wait for input.',
	schema: z.object({
		command: z.string().describe('The shell command to run'),
		timeout_ms: z.number().int().min(1000).max(600_000).optional().describe('Timeout (default 120000)'),
	}),
	requiresApproval: true,
	describe: args => args.command,
	run({command, timeout_ms = DEFAULT_TIMEOUT_MS}, {cwd, signal}) {
		return new Promise((resolve, reject) => {
			const isWindows = process.platform === 'win32';
			// Run in its own process group so an interrupt can kill the whole tree.
			const child = isWindows
				? spawn(command, {cwd, shell: true})
				: spawn(process.env.SHELL || '/bin/sh', ['-c', command], {cwd, detached: true});
			let output = '';
			let killedBy: 'interrupt' | 'timeout' | null = null;

			const kill = (reason: 'interrupt' | 'timeout') => {
				killedBy = reason;
				try {
					if (!isWindows && child.pid) process.kill(-child.pid, 'SIGKILL');
					else child.kill('SIGKILL');
				} catch {
					// already exited
				}
			};
			const onAbort = () => kill('interrupt');
			const timer = setTimeout(() => kill('timeout'), timeout_ms);
			signal.addEventListener('abort', onAbort, {once: true});

			child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
			child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
			child.stdin?.end();
			child.on('error', err => {
				clearTimeout(timer);
				signal.removeEventListener('abort', onAbort);
				reject(err);
			});
			child.on('close', code => {
				clearTimeout(timer);
				signal.removeEventListener('abort', onAbort);
				if (killedBy === 'interrupt') return reject(new Error('Command interrupted by user'));
				const status = killedBy === 'timeout' ? `Timed out after ${timeout_ms}ms` : `Exit code ${code}`;
				resolve(truncate(`${output.trimEnd() || '(no output)'}\n[${status}]`));
			});
		});
	},
});
