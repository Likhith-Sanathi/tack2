// Decides whether a tool call may run, must be approved by the user, or is refused.
// Pure logic with no UI, so it can be tested on its own.

/** What a tool does, which decides how permission modes treat it. */
export type ToolKind = 'read' | 'edit' | 'execute';

export type PermissionMode = 'ask' | 'auto-edit' | 'plan' | 'auto';

/**
 * Order used when cycling with Shift+Tab. `auto` comes last so reaching plan mode never passes
 * through it, and one more press from `auto` returns to the safest mode.
 */
export const PERMISSION_MODES: PermissionMode[] = ['ask', 'auto-edit', 'plan', 'auto'];

export const MODE_LABELS: Record<PermissionMode, string> = {
	ask: 'ask before edits and commands',
	'auto-edit': 'auto-accept edits',
	plan: 'plan mode (read-only)',
	auto: 'auto (no approvals)',
};

export function nextMode(mode: PermissionMode): PermissionMode {
	return PERMISSION_MODES[(PERMISSION_MODES.indexOf(mode) + 1) % PERMISSION_MODES.length]!;
}

/** The parts of a tool the permission check needs. */
export type PermissionSubject = {
	name: string;
	kind: ToolKind;
	/**
	 * For "don't ask again": the scope a call belongs to (e.g. a command prefix). `null` means this
	 * call can only be approved once. Without it, "don't ask again" covers the whole tool.
	 */
	approvalScope?: (args: never) => string | null;
	/** True if this particular call only reads (e.g. `ls`), so it is treated like a `read` tool. */
	isReadOnly?: (args: never) => boolean;
};

export type PermissionCheck =
	| {behavior: 'allow'}
	| {behavior: 'deny'; reason: string}
	/** `always` describes what "don't ask again" would allow, or is absent if only "once" is offered. */
	| {behavior: 'ask'; always?: AlwaysOption};

export type AlwaysOption =
	| {type: 'mode'; mode: PermissionMode; label: string}
	| {type: 'tool'; tool: string; label: string}
	| {type: 'scope'; tool: string; scope: string; label: string};

export const PLAN_MODE_DENIAL =
	'Plan mode is on, so this action is not allowed. Only read and search the project (read-only ' +
	'commands such as ls, cat or git status/diff/log are fine), then describe the changes you propose. The user can leave plan mode with Shift+Tab when they want you to proceed.';

export class Permissions {
	mode: PermissionMode = 'ask';
	private readonly allowedTools = new Set<string>();
	/** Tool name -> scopes approved for the session. */
	private readonly allowedScopes = new Map<string, Set<string>>();

	check(tool: PermissionSubject, args: unknown): PermissionCheck {
		if (tool.kind === 'read' || tool.isReadOnly?.(args as never)) return {behavior: 'allow'};
		if (this.mode === 'auto') return {behavior: 'allow'};
		if (this.mode === 'plan') return {behavior: 'deny', reason: PLAN_MODE_DENIAL};
		if (tool.kind === 'edit' && this.mode === 'auto-edit') return {behavior: 'allow'};
		if (this.allowedTools.has(tool.name)) return {behavior: 'allow'};

		if (tool.approvalScope) {
			const scope = tool.approvalScope(args as never);
			if (scope === null) return {behavior: 'ask'};
			if (this.allowedScopes.get(tool.name)?.has(scope)) return {behavior: 'allow'};
			return {behavior: 'ask', always: {type: 'scope', tool: tool.name, scope, label: scope}};
		}
		if (tool.kind === 'edit') {
			return {behavior: 'ask', always: {type: 'mode', mode: 'auto-edit', label: MODE_LABELS['auto-edit']}};
		}
		return {behavior: 'ask', always: {type: 'tool', tool: tool.name, label: tool.name}};
	}

	/** Records a "don't ask again" answer. */
	grant(option: AlwaysOption): void {
		switch (option.type) {
			case 'mode':
				this.mode = option.mode;
				break;
			case 'tool':
				this.allowedTools.add(option.tool);
				break;
			case 'scope': {
				const scopes = this.allowedScopes.get(option.tool) ?? new Set();
				scopes.add(option.scope);
				this.allowedScopes.set(option.tool, scopes);
				break;
			}
		}
	}

	/** Forgets session approvals; the mode is kept. */
	clearGrants(): void {
		this.allowedTools.clear();
		this.allowedScopes.clear();
	}
}

// ---- Shell command scopes -------------------------------------------------------------------

/**
 * Anything that can chain, substitute or redirect makes a command's effect impossible to judge
 * from its prefix, so such commands can only be approved once.
 */
const UNSAFE_SHELL = /[;&|`<>\n\r]|\$\(|\$\{/;

/** Programs whose first word says little about what runs; only the exact command is approvable. */
const EXACT_ONLY = new Set([
	'sh', 'bash', 'zsh', 'fish', 'dash', 'env', 'sudo', 'doas', 'su', 'eval', 'exec', 'xargs', 'nohup', 'time', 'watch',
	'python', 'python3', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'lua', 'npx', 'bunx', 'pnpx', 'uvx',
	'find', 'rm', 'mv', 'cp', 'dd', 'chmod', 'chown', 'curl', 'wget', 'ssh', 'scp', 'rsync', 'kill', 'pkill',
	'sed', 'awk', 'gawk', 'tee', 'truncate', 'shred', 'ln', 'install', 'tar', 'unzip', 'open', 'xdg-open',
]);

const SUBCOMMAND = /^[a-z][a-z0-9:_-]*$/;

/** Programs driven by a subcommand: the subcommand is part of the scope, never just the program. */
const HAS_SUBCOMMANDS = new Set([
	'git', 'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'docker', 'podman', 'kubectl', 'helm', 'pip', 'pip3', 'uv',
	'poetry', 'brew', 'apt', 'apt-get', 'dnf', 'gh', 'terraform', 'gradle', 'mvn', 'dotnet', 'swift', 'composer',
	'make', 'just', 'cargo-make', 'rake',
]);

/** Subcommands that run arbitrary code or a named script: scoped to that script, or exact only. */
const SCRIPT_RUNNERS = new Set(['run', 'run-script']);
const EXACT_SUBCOMMANDS = new Set(['exec', 'x', 'dlx', 'create', 'init']);

/**
 * The prefix "don't ask again" would allow for a command, e.g. `npm test` for `npm test -- foo`,
 * or `null` when the command can only be approved once. Approving a scope allows every command
 * with the same scope.
 */
export function commandScope(command: string): string | null {
	const normalized = command.trim().replace(/\s+/g, ' ');
	if (!normalized || UNSAFE_SHELL.test(normalized)) return null;
	const [program, second, third] = normalized.split(' ') as [string, string?, string?];
	// Environment assignments (FOO=1 cmd) could change what the program does.
	if (program.includes('=')) return null;
	if (EXACT_ONLY.has(program.replace(/^.*\//, ''))) return normalized;
	// Plain programs (ls, cat, echo, grep…): the program is the scope.
	if (!HAS_SUBCOMMANDS.has(program)) return program;
	// `git` alone, or `git -C dir push` with the subcommand hidden behind flags: exact only.
	if (second === undefined || !SUBCOMMAND.test(second) || EXACT_SUBCOMMANDS.has(second)) return normalized;
	if (SCRIPT_RUNNERS.has(second)) {
		return third !== undefined && SUBCOMMAND.test(third) ? `${program} ${second} ${third}` : normalized;
	}
	return `${program} ${second}`;
}

/** Programs that only read and print, whatever their arguments (given no redirects or substitutions). */
const READ_ONLY_PROGRAMS = new Set([
	'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'which', 'stat', 'du', 'df',
	'echo', 'whoami', 'uname', 'basename', 'dirname', 'realpath', 'diff', 'cmp',
]);
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'rev-parse']);

/**
 * True for commands that can only read inside the working directory, such as `ls src` or
 * `git diff`. Those run without approval. Anything that names a path outside the project
 * (absolute, `~`, `..`), uses quotes or variables, or could write output is not read-only.
 */
export function isReadOnlyCommand(command: string): boolean {
	const normalized = command.trim().replace(/\s+/g, ' ');
	if (!normalized || UNSAFE_SHELL.test(normalized) || /['"\\$]/.test(normalized)) return false;
	const [program, ...args] = normalized.split(' ') as [string, ...string[]];
	for (const arg of args) {
		const value = arg.replace(/^-+[^=]*=/, ''); // check the value of --flag=value too
		if (/^[/~]/.test(value) || value.split('/').includes('..') || /^--output/.test(arg)) return false;
	}
	if (READ_ONLY_PROGRAMS.has(program)) return true;
	return program === 'git' && args[0] !== undefined && READ_ONLY_GIT.has(args[0]);
}
