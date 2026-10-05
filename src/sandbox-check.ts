// `npm run sandbox-check`: runs real commands through tack's sandbox on this Mac and checks that
// each is allowed or blocked as intended. Uses a scratch project in a temp folder.

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnShell, killProcessTree} from './tools/bash.js';
import {sandboxUnavailableReason, type SandboxPolicy} from './tools/sandbox.js';

type Check = {name: string; command: string; expect: 'allowed' | 'blocked' | 'info'; policy?: SandboxPolicy; skip?: string};

const WRITE: SandboxPolicy = {writeProject: true, network: false};
const READ_ONLY: SandboxPolicy = {writeProject: false, network: false};

function run(command: string, cwd: string, policy: SandboxPolicy): Promise<{code: number | null; output: string}> {
	return new Promise(resolve => {
		const child = spawnShell(command, cwd, policy);
		let output = '';
		child.stdout.on('data', (d: Buffer) => (output += d.toString()));
		child.stderr.on('data', (d: Buffer) => (output += d.toString()));
		const timer = setTimeout(() => killProcessTree(child), 20_000);
		child.on('close', code => {
			clearTimeout(timer);
			resolve({code, output: output.trim()});
		});
	});
}

async function main() {
	const unavailable = sandboxUnavailableReason();
	if (unavailable) {
		console.log(`Sandbox unavailable: ${unavailable}`);
		process.exit(1);
	}

	const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tack-sandbox-check-')));
	const home = os.homedir();
	const escapee = path.join(home, `tack-sandbox-escape-${process.pid}`);
	execFileSync('git', ['init', '-q'], {cwd: project});
	execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], {cwd: project});
	const has = (cmd: string) => {
		try {
			execFileSync('/bin/sh', ['-c', `command -v ${cmd}`], {stdio: 'ignore'});
			return true;
		} catch {
			return false;
		}
	};

	// A server inside the sandbox, for the localhost checks.
	const port = 18000 + (process.pid % 1000);
	const server = has('python3') ? spawnShell(`python3 -m http.server ${port} --bind 127.0.0.1`, project, WRITE) : null;
	await new Promise(resolve => setTimeout(resolve, 1500));

	const checks: Check[] = [
		{name: 'write inside the project', command: 'echo hi > inside.txt && cat inside.txt', expect: 'allowed'},
		{name: 'create a folder in the project', command: 'mkdir -p a/b && touch a/b/c', expect: 'allowed'},
		{name: 'write to a temp folder', command: 'f=$(mktemp) && echo ok > "$f" && rm "$f"', expect: 'allowed'},
		{name: 'run node', command: 'node -e "console.log(1 + 1)"', expect: 'allowed', skip: has('node') ? undefined : 'node not installed'},
		{name: 'run python3', command: 'python3 -c "print(1 + 1)"', expect: 'allowed', skip: has('python3') ? undefined : 'python3 not installed'},
		{name: 'node starting a child process', command: `node -e "console.log(require('child_process').execSync('echo nested').toString().trim())"`, expect: 'allowed', skip: has('node') ? undefined : 'node not installed'},
		{name: 'node fork with IPC', command: `node -e "const c=require('child_process').fork('-e',[],{execArgv:['-e','process.send(1)']});c.on('message',()=>{console.log('ipc ok');c.kill()})"`, expect: 'allowed', skip: has('node') ? undefined : 'node not installed'},
		{name: 'python multiprocessing', command: `python3 -c "from multiprocessing import Pool; print(Pool(2).map(abs, [-1, -2]))"`, expect: 'allowed', skip: has('python3') ? undefined : 'python3 not installed'},
		{name: 'secrets removed from the environment', command: 'test -z "$GITHUB_TOKEN$NPM_TOKEN$OPENROUTER_API_KEY"', expect: 'allowed'},
		{name: 'git status / add / commit', command: 'git add -A && git -c user.email=t@t -c user.name=t commit -qm test && git log --oneline | head -1', expect: 'allowed'},
		{name: 'connect to a local server (127.0.0.1)', command: `curl -sS --max-time 5 http://127.0.0.1:${port}/ -o /dev/null`, expect: 'allowed', skip: server ? undefined : 'python3 not installed'},
		{name: 'connect to a local server (localhost)', command: `curl -sS --max-time 5 http://localhost:${port}/ -o /dev/null`, expect: 'info', skip: server ? undefined : 'python3 not installed'},
		{name: 'write to your home folder', command: `touch "${escapee}"`, expect: 'blocked'},
		{name: 'write to /usr/local', command: 'touch /usr/local/tack-sandbox-test', expect: 'blocked'},
		{name: 'read ~/.ssh', command: 'ls ~/.ssh', expect: 'blocked', skip: fs.existsSync(path.join(home, '.ssh')) ? undefined : 'no ~/.ssh folder'},
		{name: 'read ~/.aws', command: 'ls ~/.aws', expect: 'blocked', skip: fs.existsSync(path.join(home, '.aws')) ? undefined : 'no ~/.aws folder'},
		{name: 'add a git hook', command: 'echo "echo pwned" > .git/hooks/pre-commit', expect: 'blocked'},
		{name: 'change .git/config', command: 'echo "[x]" >> .git/config', expect: 'blocked'},
		{name: 'rename .git', command: 'mv .git .git-moved', expect: 'blocked'},
		{name: 'reach the internet', command: 'curl -sS --max-time 5 https://example.com -o /dev/null', expect: 'blocked'},
		{name: 'write in plan mode (read-only)', command: 'touch plan-mode.txt', expect: 'blocked', policy: READ_ONLY},
		{name: 'read in plan mode', command: 'cat inside.txt', expect: 'allowed', policy: READ_ONLY},
		{name: 'npm cache points to the sandbox', command: 'npm config get cache', expect: 'info', skip: has('npm') ? undefined : 'npm not installed'},
	];

	let failures = 0;
	for (const check of checks) {
		if (check.skip) {
			console.log(`  -     ${check.name} (skipped: ${check.skip})`);
			continue;
		}
		const {code, output} = await run(check.command, project, check.policy ?? WRITE);
		const allowed = code === 0;
		const ok = check.expect === 'info' || (check.expect === 'allowed') === allowed;
		if (!ok) failures++;
		const label = check.expect === 'info' ? 'INFO' : ok ? 'PASS' : 'FAIL';
		console.log(`  ${label}  ${check.name}: ${allowed ? 'allowed' : `blocked (exit ${code})`}`);
		if (!ok || check.expect === 'info') console.log(`        ${output.split('\n').slice(0, 3).join('\n        ') || '(no output)'}`);
	}

	if (server) killProcessTree(server);
	fs.rmSync(escapee, {force: true});
	fs.rmSync(project, {recursive: true, force: true});
	console.log(failures === 0 ? '\nAll sandbox checks passed.' : `\n${failures} check(s) failed.`);
	process.exit(failures === 0 ? 0 : 1);
}

void main();
