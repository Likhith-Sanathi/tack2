import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Permissions, commandScope, isReadOnlyCommand, nextMode, type PermissionSubject} from './permissions.js';

const read: PermissionSubject = {name: 'read_file', kind: 'read'};
const edit: PermissionSubject = {name: 'write_file', kind: 'edit'};
const bash: PermissionSubject = {
	name: 'bash',
	kind: 'execute',
	approvalScope: ((args: {command: string}) => commandScope(args.command)) as never,
	isReadOnly: ((args: {command: string}) => isReadOnlyCommand(args.command)) as never,
};
const custom: PermissionSubject = {name: 'deploy', kind: 'execute'};
const cmd = (command: string) => ({command});

test('modes cycle ask → auto-edit → plan → auto → ask', () => {
	assert.equal(nextMode('ask'), 'auto-edit');
	assert.equal(nextMode('auto-edit'), 'plan');
	assert.equal(nextMode('plan'), 'auto');
	assert.equal(nextMode('auto'), 'ask');
});

test('auto mode: everything runs without asking', () => {
	const p = new Permissions();
	p.mode = 'auto';
	assert.deepEqual(p.check(edit, {}), {behavior: 'allow'});
	assert.deepEqual(p.check(bash, cmd('npm install && rm -rf build')), {behavior: 'allow'});
	assert.deepEqual(p.check(custom, {}), {behavior: 'allow'});
});

test('read-only commands run without asking in every mode, including plan', () => {
	const p = new Permissions();
	for (const mode of ['ask', 'auto-edit', 'plan', 'auto'] as const) {
		p.mode = mode;
		assert.deepEqual(p.check(bash, cmd('ls -la src')), {behavior: 'allow'}, mode);
		assert.deepEqual(p.check(bash, cmd('git status')), {behavior: 'allow'}, mode);
	}
});

test('ask mode: reads run, edits and commands ask', () => {
	const p = new Permissions();
	assert.deepEqual(p.check(read, {}), {behavior: 'allow'});
	assert.equal(p.check(edit, {}).behavior, 'ask');
	assert.equal(p.check(bash, cmd('npm test')).behavior, 'ask');
	assert.equal(p.check(bash, cmd('cat ~/.ssh/id_rsa')).behavior, 'ask');
});

test('auto-edit mode: edits run, commands still ask', () => {
	const p = new Permissions();
	p.mode = 'auto-edit';
	assert.deepEqual(p.check(edit, {}), {behavior: 'allow'});
	assert.equal(p.check(bash, cmd('touch x')).behavior, 'ask');
});

test('plan mode: reads run, edits and commands are refused', () => {
	const p = new Permissions();
	p.mode = 'plan';
	assert.deepEqual(p.check(read, {}), {behavior: 'allow'});
	assert.equal(p.check(edit, {}).behavior, 'deny');
	assert.equal(p.check(bash, cmd('touch x')).behavior, 'deny');
	// Earlier approvals don't override plan mode.
	p.grant({type: 'scope', tool: 'bash', scope: 'touch', label: 'touch'});
	assert.equal(p.check(bash, cmd('touch x')).behavior, 'deny');
});

test('approving all edits switches to auto-edit', () => {
	const p = new Permissions();
	const check = p.check(edit, {});
	assert.equal(check.behavior, 'ask');
	assert.deepEqual(check.behavior === 'ask' && check.always, {type: 'mode', mode: 'auto-edit', label: 'auto-accept edits'});
	if (check.behavior === 'ask' && check.always) p.grant(check.always);
	assert.equal(p.mode, 'auto-edit');
});

test('approving a command allows only commands with the same scope', () => {
	const p = new Permissions();
	const check = p.check(bash, cmd('npm test'));
	assert.ok(check.behavior === 'ask' && check.always);
	p.grant(check.always);
	assert.deepEqual(p.check(bash, cmd('npm test -- --watch=false')), {behavior: 'allow'});
	assert.equal(p.check(bash, cmd('npm install left-pad')).behavior, 'ask');
	assert.equal(p.check(bash, cmd('npm test && rm -rf ~')).behavior, 'ask');
});

test('compound commands offer no "always" option', () => {
	const p = new Permissions();
	assert.deepEqual(p.check(bash, cmd('npm test && rm -rf ~')), {behavior: 'ask'});
});

test('tools without a scope are approved as a whole', () => {
	const p = new Permissions();
	const check = p.check(custom, {});
	assert.ok(check.behavior === 'ask' && check.always?.type === 'tool');
	p.grant(check.always);
	assert.deepEqual(p.check(custom, {}), {behavior: 'allow'});
});

test('clearGrants forgets approvals but keeps the mode', () => {
	const p = new Permissions();
	p.mode = 'auto-edit';
	p.grant({type: 'scope', tool: 'bash', scope: 'touch', label: 'touch'});
	p.clearGrants();
	assert.equal(p.mode, 'auto-edit');
	assert.equal(p.check(bash, cmd('touch x')).behavior, 'ask');
});

test('commandScope', () => {
	const cases: Array<[string, string | null]> = [
		['npm test', 'npm test'],
		['npm   test  -- foo', 'npm test'],
		['git status --short', 'git status'],
		['ls -la src', 'ls'],
		['ls', 'ls'],
		['echo hi', 'echo'],
		['sed -i s/a/b/ f', 'sed -i s/a/b/ f'],
		['cat src/a.ts', 'cat'],
		['make test', 'make test'],
		['git', 'git'],
		['npm run build', 'npm run build'],
		['npm run build -- --prod', 'npm run build'],
		['git -C other push', 'git -C other push'],
		['npx prettier --write .', 'npx prettier --write .'],
		['npm exec foo', 'npm exec foo'],
		['python script.py', 'python script.py'],
		['/usr/bin/rm -rf build', '/usr/bin/rm -rf build'],
		['npm test && rm -rf ~', null],
		['cat a | sh', null],
		['echo hi > file', null],
		['echo $(whoami)', null],
		['echo `whoami`', null],
		['FOO=1 npm test', null],
		['', null],
	];
	for (const [command, scope] of cases) assert.equal(commandScope(command), scope, command);
});

test('isReadOnlyCommand', () => {
	const yes = ['ls', 'ls -la src', 'cat README.md', 'head -n 20 src/a.ts', 'grep -rn TODO src', 'wc -l *.ts',
		'git status', 'git diff --stat', 'git log --oneline -5', 'git show HEAD', 'pwd', 'du -sh .'];
	const no = ['', 'rm -rf build', 'npm test', 'ls ..', 'cat ../secret', 'cat ~/.aws/credentials', 'cat /etc/passwd',
		'ls src/../..', 'grep --file=/etc/passwd x', 'cat "a b"', 'echo $HOME', 'ls > out.txt', 'cat a | sh',
		'ls && rm x', 'git push', 'git branch -D main', 'git -c core.pager=sh log', 'git log --output=x',
		'FOO=1 ls', 'tree -o out', 'find . -delete', 'sed -n 1p a'];
	for (const c of yes) assert.equal(isReadOnlyCommand(c), true, c);
	for (const c of no) assert.equal(isReadOnlyCommand(c), false, c);
});
