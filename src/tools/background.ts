// Long-running commands (dev servers, watchers, slow test runs) that keep going while the agent
// works: bash_background starts one, bash_output reads what it has printed since the last read,
// and kill_process stops it. All of them are stopped when tack exits.

import {z} from 'zod';
import {defineTool} from './types.js';
import {killProcessTree, sandboxFields, spawnShell, unsandboxedPreview, type ShellProcess} from './bash.js';
import {sandboxHint, type SandboxPolicy} from './sandbox.js';
import {commandScope} from '../agent/permissions.js';

/** Output kept per process; older output is dropped first. */
const MAX_BUFFER = 200_000;
/** Most output returned by one read. */
const MAX_READ = 20_000;
/** How long bash_background waits to catch startup output or an early exit. */
const STARTUP_WAIT_MS = 1500;

type BackgroundProcess = {
	id: string;
	command: string;
	child: ShellProcess;
	/** The most recent output, at most MAX_BUFFER characters. */
	buffer: string;
	/** Characters received in total, and how many of those were dropped from the buffer. */
	total: number;
	dropped: number;
	/** Position (in `total`) up to which output has been returned. */
	readUpTo: number;
	/** Exit code once finished; a signal name if it was killed. */
	exit?: number | string;
	/** Resolves whenever new output arrives or the process exits. */
	changed: Promise<void>;
	notify: () => void;
};

const processes = new Map<string, BackgroundProcess>();
let nextId = 1;

function nextChange(proc: Pick<BackgroundProcess, 'changed' | 'notify'>) {
	proc.changed = new Promise(resolve => (proc.notify = resolve));
}

function start(command: string, cwd: string, sandbox: SandboxPolicy | null): BackgroundProcess {
	const child = spawnShell(command, cwd, sandbox);
	const proc = {id: `bg${nextId++}`, command, child, buffer: '', total: 0, dropped: 0, readUpTo: 0} as BackgroundProcess;
	nextChange(proc);
	const onData = (data: Buffer) => {
		const text = data.toString();
		proc.buffer += text;
		proc.total += text.length;
		if (proc.buffer.length > MAX_BUFFER) {
			proc.dropped += proc.buffer.length - MAX_BUFFER;
			proc.buffer = proc.buffer.slice(-MAX_BUFFER);
		}
		proc.notify();
		nextChange(proc);
	};
	child.stdout.on('data', onData);
	child.stderr.on('data', onData);
	child.on('close', (code, signal) => {
		proc.exit = code ?? signal ?? 'unknown';
		proc.notify();
	});
	child.on('error', error => {
		onData(Buffer.from(`\n[failed to start: ${error.message}]\n`));
		proc.exit ??= 'error';
		proc.notify();
	});
	processes.set(proc.id, proc);
	return proc;
}

/** Output printed since the last read, marked as cut where it no longer fits. */
function readNew(proc: BackgroundProcess): string {
	const from = Math.max(proc.readUpTo, proc.dropped);
	let text = proc.buffer.slice(from - proc.dropped);
	const lost = from - proc.readUpTo;
	proc.readUpTo = proc.total;
	if (text.length > MAX_READ) text = `… [${text.length - MAX_READ} characters skipped]\n${text.slice(-MAX_READ)}`;
	if (lost > 0) text = `… [${lost} characters were dropped before this read]\n${text}`;
	return text.trimEnd();
}

function status(proc: BackgroundProcess): string {
	if (proc.exit === undefined) return 'running';
	return typeof proc.exit === 'number' ? `exited with code ${proc.exit}` : `stopped (${proc.exit})`;
}

function lookup(id: string): BackgroundProcess {
	const proc = processes.get(id);
	if (!proc) {
		const known = [...processes.keys()].join(', ');
		throw new Error(`No background process "${id}".${known ? ` Known: ${known}.` : ''}`);
	}
	return proc;
}

/** Waits until `ms` pass, the process changes, or the signal fires. */
function wait(proc: BackgroundProcess, ms: number, signal: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener('abort', done, {once: true});
		void proc.changed.then(done);
	});
}

/** Waits until the process exits, `ms` pass, or the signal fires. */
async function waitForExit(proc: BackgroundProcess, ms: number, signal: AbortSignal): Promise<void> {
	const deadline = Date.now() + ms;
	while (proc.exit === undefined && Date.now() < deadline && !signal.aborted) {
		await wait(proc, deadline - Date.now(), signal);
	}
}

/** Stops every background process; called when tack exits. */
export function stopAllBackground(): void {
	for (const proc of processes.values()) if (proc.exit === undefined) killProcessTree(proc.child);
}

// A safety net; cli.tsx also stops them when the app closes (their pipes would keep Node running).
process.on('exit', stopAllBackground);

export const bashBackground = defineTool({
	name: 'bash_background',
	description:
		'Start a long-running shell command (dev server, watcher, slow build or test run) in the background and return ' +
		'right away with an id and its first output. Read more output with bash_output and stop it with kill_process. ' +
		'Stdin is closed. Background processes are stopped when tack exits.',
	schema: z.object({command: z.string().describe('The shell command to run'), ...sandboxFields}),
	kind: 'execute',
	sandboxable: args => args.sandbox !== false,
	preview: args => unsandboxedPreview(args),
	approvalScope: args => commandScope(args.command),
	describe: args => args.command,
	async run({command}, {cwd, signal, sandbox}) {
		const proc = start(command, cwd, sandbox ?? null);
		// Catch startup output, or an immediate failure, before reporting back.
		await waitForExit(proc, STARTUP_WAIT_MS, signal);
		if (signal.aborted) {
			killProcessTree(proc.child);
			throw new Error('Interrupted; the process was stopped.');
		}
		const output = readNew(proc);
		const pid = proc.child.pid ? `, pid ${proc.child.pid}` : '';
		return [
			`Started ${proc.id}${pid}: ${status(proc)}.`,
			output || '(no output yet)',
			proc.exit === undefined ? `Use bash_output with id "${proc.id}" to read more and kill_process to stop it.` : '',
			sandbox && proc.exit !== undefined && proc.exit !== 0 ? sandboxHint(output, sandbox).trim() : '',
		]
			.filter(Boolean)
			.join('\n');
	},
});

export const bashOutput = defineTool({
	name: 'bash_output',
	description:
		'Read the output a background process has printed since the last read, and whether it is still running. ' +
		'Set wait_ms to wait for new output first (e.g. until a server is ready). Without an id, lists all background processes.',
	schema: z.object({
		id: z.string().optional().describe('Id from bash_background, e.g. "bg1"'),
		wait_ms: z.number().int().min(0).max(30_000).optional().describe('Wait up to this long for new output (default 0)'),
	}),
	kind: 'read',
	describe: args => (args.id ? `${args.id}${args.wait_ms ? ` (wait ${args.wait_ms}ms)` : ''}` : 'list'),
	async run({id, wait_ms = 0}, {signal}) {
		if (!id) {
			if (processes.size === 0) return 'No background processes.';
			return [...processes.values()].map(p => `${p.id}  ${status(p)}  ${p.command}`).join('\n');
		}
		const proc = lookup(id);
		if (wait_ms > 0 && proc.total === proc.readUpTo && proc.exit === undefined) await wait(proc, wait_ms, signal);
		const output = readNew(proc);
		return `${proc.id}: ${status(proc)}\n${output || '(no new output)'}`;
	},
});

export const killProcess = defineTool({
	name: 'kill_process',
	description: 'Stop a background process started with bash_background, including any processes it started.',
	schema: z.object({id: z.string().describe('Id from bash_background, e.g. "bg1"')}),
	kind: 'execute',
	// Only stops processes this session started, so it needs no approval (and works in plan mode).
	isReadOnly: () => true,
	describe: args => args.id,
	async run({id}, {signal}) {
		const proc = lookup(id);
		if (proc.exit !== undefined) return `${proc.id} had already ${status(proc)}.\n${readNew(proc)}`.trimEnd();
		// Ask nicely first, so servers can shut down cleanly.
		killProcessTree(proc.child, 'SIGTERM');
		await waitForExit(proc, 2000, signal);
		if (proc.exit === undefined) {
			killProcessTree(proc.child, 'SIGKILL');
			await waitForExit(proc, 1000, signal);
		}
		const output = readNew(proc);
		return `${proc.id}: ${status(proc)}${output ? `\n${output}` : ''}`;
	},
});
