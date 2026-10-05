import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {glob} from './glob.js';
import {search} from './search.js';
import {listDir} from './list-dir.js';
import {multiEdit} from './multi-edit.js';
import {bashBackground, bashOutput, killProcess} from './background.js';

const ctx = (cwd: string) => ({cwd, signal: new AbortController().signal});

/** A small project: a .gitignore, a nested one, an excluded file and node_modules. */
function project(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tack-tools-'));
	const files: Record<string, string> = {
		'.gitignore': 'dist/\n*.log\n',
		'.git/info/exclude': 'secret.txt\n',
		'src/a.ts': 'const one = 1;\nconst two = 2;\nconst three = 3;\n// TODO later\nexport {one};\n',
		'src/b.test.ts': 'test("x", () => {});\n',
		'src/gen/.gitignore': 'generated.ts\n',
		'src/gen/generated.ts': 'const TODO = 1;\n',
		'src/gen/kept.ts': 'const kept = 1;\n',
		'dist/out.js': 'TODO in build output\n',
		'debug.log': 'TODO in a log\n',
		'secret.txt': 'TODO secret\n',
		'node_modules/pkg/index.js': 'TODO in a dependency\n',
		'README.md': '# Readme\nTODO docs\n',
	};
	for (const [file, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, file)), {recursive: true});
		fs.writeFileSync(path.join(dir, file), content);
	}
	return dir;
}

test('glob matches names at any depth and honors .gitignore files', async () => {
	const dir = project();
	const ts = (await glob.run({pattern: '*.ts'}, ctx(dir))).split('\n').sort();
	assert.deepEqual(ts, ['src/a.ts', 'src/b.test.ts', 'src/gen/kept.ts']);
	assert.equal(await glob.run({pattern: 'src/**/*.test.ts'}, ctx(dir)), 'src/b.test.ts');
	assert.equal(await glob.run({pattern: '*.js'}, ctx(dir)), 'No files match.');
	// Within a subdirectory, the .gitignore files above it still apply.
	assert.equal(await glob.run({pattern: '*.ts', path: 'src/gen'}, ctx(dir)), 'kept.ts');
});

test('glob lists the most recently modified files first', async () => {
	const dir = project();
	const old = new Date(Date.now() - 60_000);
	fs.utimesSync(path.join(dir, 'src/b.test.ts'), old, old);
	fs.utimesSync(path.join(dir, 'src/gen/kept.ts'), old, old);
	assert.equal((await glob.run({pattern: '*.ts'}, ctx(dir))).split('\n')[0], 'src/a.ts');
});

test('search skips ignored, excluded and dependency files', async () => {
	const dir = project();
	const out = await search.run({pattern: 'TODO'}, ctx(dir));
	assert.deepEqual(out.split('\n'), ['README.md:2: TODO docs', 'src/a.ts:4: // TODO later']);
});

test('search shows context lines, merging nearby matches', async () => {
	const dir = project();
	const out = await search.run({pattern: 'one =|two', path: 'src/a.ts', context: 1}, ctx(dir));
	assert.deepEqual(out.split('\n'), ['src/a.ts:1: const one = 1;', 'src/a.ts:2: const two = 2;', 'src/a.ts-3- const three = 3;']);
	const apart = await search.run({pattern: 'one', path: 'src', context: 0}, ctx(dir));
	assert.deepEqual(apart.split('\n'), ['a.ts:1: const one = 1;', 'a.ts:5: export {one};']);
	const groups = await search.run({pattern: '^const one|^export', path: 'src/a.ts', context: 1}, ctx(dir));
	assert.deepEqual(groups.split('\n'), [
		'src/a.ts:1: const one = 1;',
		'src/a.ts-2- const two = 2;',
		'--',
		'src/a.ts-4- // TODO later',
		'src/a.ts:5: export {one};',
	]);
});

test('search can list just the matching files', async () => {
	const dir = project();
	assert.equal(await search.run({pattern: 'const', files_only: true, glob: 'src/*.ts'}, ctx(dir)), 'src/a.ts (3 matches)');
});

test('list_dir marks ignored directories without entering them', async () => {
	const dir = project();
	const out = (await listDir.run({recursive: true}, ctx(dir))).split('\n');
	assert.ok(out.includes('node_modules/ (ignored, not listed)'));
	assert.ok(out.includes('dist/ (ignored, not listed)'));
	assert.ok(!out.some(line => line.includes('debug.log') || line.includes('generated.ts')));
	assert.ok(out.includes('src/gen/kept.ts'));
	// A plain listing shows everything.
	assert.ok((await listDir.run({}, ctx(dir))).split('\n').includes('debug.log'));
});

test('multi_edit applies edits in order, or none at all', async () => {
	const dir = project();
	const file = path.join(dir, 'src/a.ts');
	const result = await multiEdit.run(
		{
			path: 'src/a.ts',
			edits: [
				{old_string: 'const one = 1;', new_string: 'const uno = 1;'},
				{old_string: 'const uno', new_string: 'let uno'},
				{old_string: 'const', new_string: 'var', replace_all: true},
			],
		},
		ctx(dir),
	);
	assert.match(result, /Applied 3 edit/);
	assert.equal(fs.readFileSync(file, 'utf8'), 'let uno = 1;\nvar two = 2;\nvar three = 3;\n// TODO later\nexport {one};\n');

	const before = fs.readFileSync(file, 'utf8');
	await assert.rejects(
		multiEdit.run({path: 'src/a.ts', edits: [{old_string: 'let uno', new_string: 'x'}, {old_string: 'missing', new_string: 'y'}]}, ctx(dir)),
		/edit 2 of 2: old_string not found.*No changes were made/,
	);
	assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('background processes: start, read new output, list, stop', async () => {
	const dir = project();
	const started = await bashBackground.run({command: 'echo ready; sleep 2.5; echo later; sleep 30'}, ctx(dir));
	const id = /Started (bg\d+)/.exec(started)![1]!;
	assert.match(started, /running/);
	assert.match(started, /ready/);
	assert.doesNotMatch(started, /later/);

	const next = await bashOutput.run({id, wait_ms: 5000}, ctx(dir));
	assert.match(next, /later/);
	assert.doesNotMatch(next, /ready/, 'only output since the last read');
	assert.match(await bashOutput.run({}, ctx(dir)), new RegExp(`${id}\\s+running`));

	const stopped = await killProcess.run({id}, ctx(dir));
	assert.match(stopped, /stopped \(SIGTERM\)/);
	assert.match(await bashOutput.run({id}, ctx(dir)), /stopped/);
});

test('a background command that exits quickly reports its exit code', async () => {
	const out = await bashBackground.run({command: 'echo hi; exit 3'}, ctx(project()));
	assert.match(out, /exited with code 3/);
	assert.match(out, /hi/);
	await assert.rejects(bashOutput.run({id: 'nope'}, ctx(project())), /No background process "nope"/);
});

test('search context stops at the last line of the file', async () => {
	const dir = project();
	const out = await search.run({pattern: 'export', path: 'src/a.ts', context: 2}, ctx(dir));
	assert.deepEqual(out.split('\n'), ['src/a.ts-3- const three = 3;', 'src/a.ts-4- // TODO later', 'src/a.ts:5: export {one};']);
});
