import {spawn, type ChildProcessByStdio} from 'node:child_process';
import type {Readable} from 'node:stream';
import {z} from 'zod';
import {defineTool} from './types.js';
import {truncate} from './paths.js';
import {commandScope, isReadOnlyCommand} from '../agent/permissions.js';
import {SECRET_ENV, sandboxHint, shellInvocation, type SandboxPolicy} from './sandbox.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const isWindows = process.platform === 'win32';

export type ShellProcess = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Starts a shell command with no stdin, pagers or credential prompts, so nothing can wait for input
 * that never comes. On Unix it gets its own process group, so killProcessTree stops its children too.
 */
export function spawnShell(command: string, cwd: string, sandbox: SandboxPolicy | null = null): ShellProcess {
	const env: NodeJS.ProcessEnv = {...process.env, PAGER: 'cat', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0'};
	// Commands never need tack's own API key.
	delete env.OPENROUTER_API_KEY;
	const stdio: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe'];
	if (isWindows) return spawn(command, {cwd, env, stdio, shell: true});
	// Sandboxed commands have no network, so they never need credentials from the environment.
	if (sandbox) for (const name of Object.keys(env)) if (SECRET_ENV.test(name)) delete env[name];
	const run = shellInvocation({command, cwd, shell: process.env.SHELL || '/bin/sh', policy: sandbox});
	return spawn(run.file, run.args, {cwd, env: {...env, ...run.env}, stdio, detached: true});
}

/** Schema fields for running a command outside the sandbox. Shared with bash_background. */
export const sandboxFields = {
	sandbox: z
		.boolean()
		.optional()
		.describe(
			'Commands run in a sandbox by default (project and temp writes only, no network except localhost). ' +
				'Set false only when a command needs more, e.g. installing packages; the user must approve it.',
		),
	reason: z.string().optional().describe('Required with sandbox: false: why the command needs to run outside the sandbox'),
};

/** Shown in the approval prompt when a command asks to leave the sandbox. */
export function unsandboxedPreview(args: {sandbox?: boolean; reason?: string}) {
	return args.sandbox === false
		? {type: 'text' as const, text: `Runs outside the sandbox: ${args.reason?.trim() || '(no reason given)'}`}
		: undefined;
}

/** Kills a process started by spawnShell, with its whole process group on Unix. */
export function killProcessTree(child: ShellProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
	try {
		if (!isWindows && child.pid) process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch {
		// already exited
	}
}

export const bash = defineTool({
	name: 'bash',
	description:
		'Run a shell command in the working directory and return its combined stdout/stderr and exit code. Stdin is closed and there is no terminal, so commands cannot prompt for input; pass flags like --yes instead. For servers, watchers or anything long-running, use bash_background instead.',
	schema: z.object({
		command: z.string().describe('The shell command to run'),
		timeout_ms: z.number().int().min(1000).max(600_000).optional().describe('Timeout (default 120000)'),
		...sandboxFields,
	}),
	kind: 'execute',
	sandboxable: args => args.sandbox !== false,
	preview: args => unsandboxedPreview(args),
	approvalScope: args => commandScope(args.command),
	isReadOnly: args => isReadOnlyCommand(args.command),
	describe: args => args.command,
	run({command, timeout_ms = DEFAULT_TIMEOUT_MS}, {cwd, signal, onOutput, sandbox}) {
		return new Promise((resolve, reject) => {
			const child = spawnShell(command, cwd, sandbox ?? null);
			let output = '';
			let killedBy: 'interrupt' | 'timeout' | null = null;

			const kill = (reason: 'interrupt' | 'timeout') => {
				killedBy = reason;
				killProcessTree(child);
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
				const hint = sandbox && code !== 0 ? sandboxHint(output, sandbox) : '';
				resolve(truncate(`${output.trimEnd() || '(no output)'}\n[${status}]`) + hint);
			});
		});
	},
});
