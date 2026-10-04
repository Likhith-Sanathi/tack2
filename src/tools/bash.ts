import {spawn} from 'node:child_process';
import {z} from 'zod';
import {defineTool} from './types.js';
import {truncate} from './paths.js';
import {commandScope, isReadOnlyCommand} from '../agent/permissions.js';

const DEFAULT_TIMEOUT_MS = 120_000;

export const bash = defineTool({
	name: 'bash',
	description:
		'Run a shell command in the working directory and return its combined stdout/stderr and exit code. Stdin is closed and there is no terminal, so commands cannot prompt for input; pass flags like --yes instead. Do not start long-running servers or watchers.',
	schema: z.object({
		command: z.string().describe('The shell command to run'),
		timeout_ms: z.number().int().min(1000).max(600_000).optional().describe('Timeout (default 120000)'),
	}),
	kind: 'execute',
	approvalScope: args => commandScope(args.command),
	isReadOnly: args => isReadOnlyCommand(args.command),
	describe: args => args.command,
	run({command, timeout_ms = DEFAULT_TIMEOUT_MS}, {cwd, signal, onOutput}) {
		return new Promise((resolve, reject) => {
			const isWindows = process.platform === 'win32';
			// No stdin and no pagers or credential prompts, so nothing can wait for input that never comes.
			const env = {...process.env, PAGER: 'cat', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0'};
			const stdio: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe'];
			// Run in its own process group so an interrupt can kill the whole tree.
			const child = isWindows
				? spawn(command, {cwd, env, stdio, shell: true})
				: spawn(process.env.SHELL || '/bin/sh', ['-c', command], {cwd, env, stdio, detached: true});
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

			const onData = (data: Buffer) => {
				const text = data.toString();
				output += text;
				onOutput?.(text);
			};
			child.stdout.on('data', onData);
			child.stderr.on('data', onData);
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
