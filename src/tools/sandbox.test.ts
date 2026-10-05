import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sandboxHint, sandboxUnavailableReason, seatbeltProfile, shellInvocation} from './sandbox.js';

const paths = {cwd: '/Users/me/My "Proj"', home: '/Users/me', tmp: '/private/var/folders/ab/T'};

/** Parses an s-expression profile, throwing on unbalanced parentheses or unterminated strings. */
function parse(profile: string): unknown[] {
	const stack: unknown[][] = [[]];
	for (let i = 0; i < profile.length; i++) {
		const c = profile[i]!;
		if (c === ';') while (i < profile.length && profile[i] !== '\n') i++;
		else if (c === '(') stack.push([]);
		else if (c === ')') {
			const done = stack.pop();
			if (!done || stack.length === 0) throw new Error(`unbalanced ) at ${i}`);
			stack.at(-1)!.push(done);
		} else if (c === '"') {
			let s = '';
			for (i++; profile[i] !== '"'; i++) {
				if (i >= profile.length) throw new Error('unterminated string');
				if (profile[i] === '\\') i++;
				s += profile[i];
			}
			stack.at(-1)!.push(s);
		}
	}
	if (stack.length !== 1) throw new Error('unbalanced (');
	return stack[0]!;
}

/** Every string literal in rules starting with the given words, e.g. ['allow', 'file-write*']. */
function strings(profile: string, ...head: string[]): string[] {
	const out: string[] = [];
	const walk = (node: unknown) => {
		if (!Array.isArray(node)) return;
		out.push(...node.flat(3).filter((s): s is string => typeof s === 'string'));
	};
	const lines = profile.split('\n').filter(l => l.startsWith(`(${head.join(' ')}`));
	for (const line of lines) parse(line).forEach(walk);
	return out;
}

test('the profile is well-formed and denies by default', () => {
	const profile = seatbeltProfile({...paths, policy: {writeProject: true, network: false}});
	assert.doesNotThrow(() => parse(profile));
	assert.match(profile, /^\(version 1\)\n\(deny default\)/);
});

test('writes: the project and temp folders, with git hooks/config and editor settings protected', () => {
	const profile = seatbeltProfile({...paths, policy: {writeProject: true, network: false}});
	assert.deepEqual(strings(profile, 'allow', 'file-write*'), [paths.cwd, paths.tmp, '/private/tmp', `${paths.tmp}/tack-sandbox-cache`]);
	const denied = strings(profile, 'deny', 'file-write*');
	assert.deepEqual(denied.slice(0, 5), [
		`${paths.cwd}/.git/hooks`,
		`${paths.cwd}/.vscode`,
		`${paths.cwd}/.idea`,
		`${paths.cwd}/.git/config`,
		`${paths.cwd}/.gitmodules`,
	]);
	// Nested repositories and submodules, matched by pattern.
	const [hooks, config] = denied.slice(5).map(re => new RegExp(re));
	const cwd = paths.cwd;
	assert.ok(hooks!.test(`${cwd}/vendor/lib/.git/hooks/pre-commit`));
	assert.ok(hooks!.test(`${cwd}/.git/modules/lib/hooks`));
	assert.ok(config!.test(`${cwd}/.git/modules/lib/config`));
	assert.ok(!hooks!.test(`${cwd}/src/hooks/useThing.ts`), 'ordinary folders named hooks are writable');
	assert.ok(!hooks!.test(`/elsewhere/.git/hooks/x`));
	const [gitDir] = strings(profile, 'deny', 'file-write-unlink').map(re => new RegExp(re));
	assert.ok(gitDir!.test(`${cwd}/.git`) && gitDir!.test(`${cwd}/sub/.git`) && !gitDir!.test(`${cwd}/.github`));
	// The protections come after the allow, since the last matching rule wins.
	assert.ok(profile.indexOf('(deny file-write*') > profile.indexOf('(allow file-write*'));
});

test('plan mode: the project is read-only', () => {
	const profile = seatbeltProfile({...paths, policy: {writeProject: false, network: false}});
	assert.ok(!strings(profile, 'allow', 'file-write*').includes(paths.cwd));
	assert.doesNotMatch(profile, /\(deny file-write\*/);
});

test('reads: everything except credential folders', () => {
	const profile = seatbeltProfile({...paths, policy: {writeProject: true, network: false}});
	assert.match(profile, /^\(allow file-read\*\)$/m);
	const denied = strings(profile, 'deny', 'file-read*');
	assert.ok(denied.includes('/Users/me/.ssh') && denied.includes('/Users/me/.aws'));
	assert.ok(profile.indexOf('(deny file-read*') > profile.indexOf('(allow file-read*)'));
});

test('local sockets: allowed in the project and temp folder only', () => {
	const profile = seatbeltProfile({...paths, policy: {writeProject: true, network: false}});
	assert.match(profile, /\(allow system-socket \(socket-domain AF_UNIX\)\)/);
	assert.deepEqual(strings(profile, 'allow', 'network-bind (local unix-socket'), [paths.cwd, paths.tmp]);
	assert.doesNotMatch(profile, /unix-socket[^\n]*private\/tmp"/);
});

test('network: localhost only unless allowed', () => {
	const offline = seatbeltProfile({...paths, policy: {writeProject: true, network: false}});
	assert.doesNotMatch(offline, /\(allow network\*\)/);
	assert.match(offline, /\(allow network-outbound \(remote ip "localhost:\*"\)\)/);
	const online = seatbeltProfile({...paths, policy: {writeProject: true, network: true}});
	assert.match(online, /\(allow network\*\)/);
});

test('quotes and backslashes in paths are escaped', () => {
	const profile = seatbeltProfile({...paths, cwd: '/Users/me/a"b\\c', policy: {writeProject: true, network: false}});
	assert.ok(strings(profile, 'allow', 'file-write*').includes('/Users/me/a"b\\c'));
});

test('shellInvocation wraps the command in sandbox-exec only when sandboxed', () => {
	assert.deepEqual(shellInvocation({command: 'ls', cwd: '/', shell: '/bin/zsh', policy: null}), {file: '/bin/zsh', args: ['-c', 'ls'], env: {}});
	const run = shellInvocation({command: 'npm test', cwd: '/', shell: '/bin/zsh', policy: {writeProject: true, network: false}, home: '/Users/me', tmp: '/tmp/tack-test-tmp'});
	assert.equal(run.file, '/usr/bin/sandbox-exec');
	assert.deepEqual([run.args[0], ...run.args.slice(2)], ['-p', '/bin/zsh', '-c', 'npm test']);
	assert.equal(run.env.npm_config_cache, '/tmp/tack-test-tmp/tack-sandbox-cache/npm');
});

test('availability and hints', () => {
	assert.match(sandboxUnavailableReason('linux') ?? '', /isn't supported on linux/);
	const hint = sandboxHint('touch: /etc/x: Operation not permitted', {writeProject: true, network: false});
	assert.match(hint, /sandbox: false/);
	assert.equal(sandboxHint('Error: assertion failed', {writeProject: true, network: false}), '');
	assert.match(sandboxHint('curl: (6) Could not resolve host: example.com', {writeProject: false, network: false}), /plan mode/);
});
