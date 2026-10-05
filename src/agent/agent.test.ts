// Runs the agent against a fake OpenRouter server to check how permission modes affect a turn.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import type {AgentEvent, ApprovalRequest} from './agent.js';

type Reply = {text?: string; call?: {name: string; args: unknown}};

let replies: Reply[] = [];
let requests: Array<{messages: Array<{role: string; content: string | null}>; reasoning?: unknown; provider?: unknown}> = [];
let server: http.Server;
let Agent: typeof import('./agent.js').Agent;
let tools: typeof import('../tools/index.js').tools;

before(async () => {
	server = http.createServer((req, res) => {
		let body = '';
		req.on('data', chunk => (body += chunk));
		req.on('end', () => {
			requests.push(JSON.parse(body));
			const reply = replies.shift() ?? {text: 'done'};
			const delta = reply.call
				? {tool_calls: [{index: 0, id: `call_${requests.length}`, function: {name: reply.call.name, arguments: JSON.stringify(reply.call.args)}}]}
				: {content: reply.text};
			res.writeHead(200, {'Content-Type': 'text/event-stream'});
			res.write(`data: ${JSON.stringify({choices: [{delta}]})}\n\n`);
			res.write(`data: ${JSON.stringify({choices: [{delta: {}, finish_reason: reply.call ? 'tool_calls' : 'stop'}]})}\n\n`);
			res.end('data: [DONE]\n\n');
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	// Imported after the base URL is set, since the client reads it on load.
	({Agent} = await import('./agent.js'));
	({tools} = await import('../tools/index.js'));
});

after(() => server.close());

function setup(answer: 'once' | 'always' | 'deny' = 'once') {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tack-test-'));
	const events: AgentEvent[] = [];
	const approvals: ApprovalRequest[] = [];
	requests = [];
	const agent = new Agent({
		apiKey: 'test',
		model: 'test/model',
		cwd,
		tools,
		onEvent: event => events.push(event),
		requestApproval: async request => {
			approvals.push(request);
			return answer;
		},
	});
	const toolEnds = () => events.filter(e => e.type === 'tool_end');
	return {agent, cwd, events, approvals, toolEnds};
}

const write = (file: string) => ({call: {name: 'write_file', args: {path: file, content: 'hi\n'}}});

test('ask mode asks before writing', async () => {
	const {agent, cwd, approvals} = setup('once');
	replies = [write('a.txt'), {text: 'ok'}];
	await agent.send('write it');
	assert.equal(approvals.length, 1);
	assert.equal(approvals[0]!.always?.type, 'mode');
	assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'hi\n');
});

test('"always" on an edit switches to auto-edit and stops asking', async () => {
	const {agent, cwd, approvals, events} = setup('always');
	replies = [write('a.txt'), write('b.txt'), {text: 'ok'}];
	await agent.send('write two files');
	assert.equal(approvals.length, 1);
	assert.equal(agent.mode, 'auto-edit');
	assert.ok(events.some(e => e.type === 'mode' && e.mode === 'auto-edit'));
	assert.ok(fs.existsSync(path.join(cwd, 'b.txt')));
});

test('auto-edit writes without asking but still asks for commands', async () => {
	const {agent, cwd, approvals} = setup('once');
	agent.setMode('auto-edit');
	replies = [write('a.txt'), {call: {name: 'bash', args: {command: 'make build'}}}, {text: 'ok'}];
	await agent.send('go');
	assert.ok(fs.existsSync(path.join(cwd, 'a.txt')));
	assert.deepEqual(approvals.map(a => a.toolName), ['bash']);
	assert.deepEqual(approvals[0]!.always, {type: 'scope', tool: 'bash', scope: 'make build', label: 'make build'});
});

test('plan mode blocks edits without asking, and the turn continues', async () => {
	const {agent, cwd, approvals, toolEnds} = setup('once');
	agent.setMode('plan');
	replies = [write('a.txt'), {text: 'Here is my plan.'}];
	await agent.send('change things');
	assert.equal(approvals.length, 0);
	assert.ok(!fs.existsSync(path.join(cwd, 'a.txt')));
	assert.equal(toolEnds()[0]?.type === 'tool_end' && toolEnds()[0]!.status, 'blocked');
	// The model got the refusal and answered again; the plan-mode note was in the system prompt.
	assert.equal(requests.length, 2);
	assert.match(requests[1]!.messages[0]!.content ?? '', /PLAN MODE IS ON/);
});

test('denying a call ends the turn', async () => {
	const {agent, toolEnds} = setup('deny');
	replies = [write('a.txt'), {text: 'should not be requested'}];
	await agent.send('write it');
	assert.equal(requests.length, 1);
	assert.equal(toolEnds()[0]?.type === 'tool_end' && toolEnds()[0]!.status, 'denied');
});

test('an approved command scope is not asked again', async () => {
	const {agent, approvals} = setup('always');
	replies = [
		{call: {name: 'bash', args: {command: 'touch one'}}},
		{call: {name: 'bash', args: {command: 'touch two'}}},
		{call: {name: 'bash', args: {command: 'touch three | cat'}}},
		{text: 'ok'},
	];
	await agent.send('run');
	assert.deepEqual(approvals.map(a => a.summary), ['touch one', 'touch three | cat']);
	assert.equal(approvals[1]!.always, undefined);
});

test('auto mode runs commands and edits without asking', async () => {
	const {agent, cwd, approvals, toolEnds} = setup('deny');
	agent.setMode('auto');
	replies = [write('a.txt'), {call: {name: 'bash', args: {command: 'echo hi && echo there'}}}, {text: 'ok'}];
	await agent.send('go');
	assert.equal(approvals.length, 0);
	assert.ok(fs.existsSync(path.join(cwd, 'a.txt')));
	assert.deepEqual(toolEnds().map(e => e.type === 'tool_end' && e.status), ['ok', 'ok']);
});

test('read-only commands run without asking in ask mode', async () => {
	const {agent, approvals, toolEnds} = setup('deny');
	replies = [{call: {name: 'bash', args: {command: 'ls'}}}, {text: 'ok'}];
	await agent.send('list');
	assert.equal(approvals.length, 0);
	assert.equal(toolEnds()[0]?.type === 'tool_end' && toolEnds()[0]!.status, 'ok');
});

test('sends the thinking level and pinned provider, and omits them by default', async () => {
	const {agent} = setup();
	replies = [{text: 'ok'}, {text: 'ok'}];
	await agent.send('hi');
	assert.equal(requests[0]!.reasoning, undefined);
	assert.equal(requests[0]!.provider, undefined);
	agent.thinking = 'high';
	agent.provider = 'deepinfra/fp8';
	await agent.send('again');
	assert.deepEqual(requests[1]!.reasoning, {effort: 'high'});
	assert.deepEqual(requests[1]!.provider, {order: ['deepinfra/fp8'], allow_fallbacks: false});
});
