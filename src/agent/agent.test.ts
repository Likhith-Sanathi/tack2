// Runs the agent against a fake OpenRouter server to check how permission modes affect a turn.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import type {AgentEvent, ApprovalRequest} from './agent.js';

type Reply = {text?: string; call?: {name: string; args: unknown}; chunks?: unknown[]};

let replies: Reply[] = [];
let requests: Array<{messages: Array<{role: string; content: string | null}>; reasoning?: unknown; provider?: unknown; tools?: Array<{type: string; parameters?: unknown}>}> = [];
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
			if (reply.chunks) {
				res.writeHead(200, {'Content-Type': 'text/event-stream'});
				for (const chunk of reply.chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
				return res.end('data: [DONE]\n\n');
			}
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

function setup(answer: 'once' | 'always' | 'deny' = 'once', extra: {tools?: typeof tools; sandboxUnavailable?: string | null} = {}) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tack-test-'));
	const events: AgentEvent[] = [];
	const approvals: ApprovalRequest[] = [];
	requests = [];
	const agent = new Agent({
		apiKey: 'test',
		model: 'test/model',
		cwd,
		tools: extra.tools ?? tools,
		sandboxUnavailable: extra.sandboxUnavailable,
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

test('offers OpenRouter web tools only while web is on', async () => {
	const {agent} = setup();
	replies = [{text: 'ok'}, {text: 'ok'}];
	await agent.send('hi');
	const web = requests[0]!.tools!.filter(t => t.type.startsWith('openrouter:'));
	assert.deepEqual(web.map(t => t.type), ['openrouter:web_search', 'openrouter:web_fetch']);
	assert.deepEqual(web[0]!.parameters, {engine: 'exa', max_results: 5});
	assert.match(requests[0]!.messages[0]!.content ?? '', /search the web/);
	agent.web = false;
	await agent.send('again');
	assert.ok(requests[1]!.tools!.every(t => t.type === 'function'));
	assert.doesNotMatch(requests[1]!.messages[0]!.content ?? '', /search the web/);
});

test('reports server tool calls and citations without running them', async () => {
	const {agent, events, approvals, toolEnds} = setup('deny');
	const delta = (d: unknown, finish: string | null = null) => ({choices: [{delta: d, finish_reason: finish}]});
	replies = [
		{
			chunks: [
				// Echoed server tool calls, typed and untyped, followed by the answer reusing index 0.
				delta({tool_calls: [{index: 0, id: 'srv_1', type: 'openrouter:web_search', function: {name: 'web_search', arguments: '{"query":"ink 8 release"}'}}]}),
				delta({tool_calls: [{index: 1, id: 'srv_2', function: {name: 'web_fetch', arguments: '{"url":"https://example.com/a"}'}}]}),
				delta({content: 'Ink 8 shipped.', annotations: [{type: 'url_citation', url_citation: {url: 'https://example.com/a', title: 'Ink 8'}}]}),
				delta({annotations: [{type: 'url_citation', url_citation: {url: 'https://example.com/a', title: 'Ink 8'}}]}, 'stop'),
			],
		},
	];
	await agent.send('what is new in ink?');
	assert.equal(requests.length, 1, 'no follow-up request: nothing was left for tack to run');
	assert.equal(approvals.length, 0);
	assert.equal(toolEnds().length, 0);
	assert.deepEqual(
		events.filter(e => e.type === 'web'),
		[
			{type: 'web', name: 'web_search', summary: 'ink 8 release'},
			{type: 'web', name: 'web_fetch', summary: 'https://example.com/a'},
		],
	);
	assert.deepEqual(events.find(e => e.type === 'sources'), {type: 'sources', sources: [{url: 'https://example.com/a', title: 'Ink 8'}]});
});

test('a client tool call after an echoed server call at the same index still runs', async () => {
	const {agent, cwd, toolEnds} = setup('once');
	const delta = (d: unknown, finish: string | null = null) => ({choices: [{delta: d, finish_reason: finish}]});
	replies = [
		{
			chunks: [
				delta({tool_calls: [{index: 0, id: 'srv_1', type: 'openrouter:web_search', function: {name: 'web_search', arguments: '{"query":"x"}'}}]}),
				delta({tool_calls: [{index: 0, id: 'call_9', type: 'function', function: {name: 'write_file', arguments: '{"path":"a.txt","content":"hi"}'}}]}, 'tool_calls'),
			],
		},
		{text: 'done'},
	];
	await agent.send('go');
	assert.equal(toolEnds().length, 1);
	assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'hi');
});

test('sandbox: commands run without approval, read-only in plan mode, unsandboxed in auto mode', async () => {
	const {defineTool} = await import('../tools/index.js');
	const {z} = await import('zod');
	// A stand-in for bash that reports the sandbox it was given instead of running anything.
	const seen: unknown[] = [];
	const shell = defineTool({
		name: 'shell',
		description: 'test',
		schema: z.object({command: z.string(), sandbox: z.boolean().optional()}),
		kind: 'execute',
		sandboxable: args => args.sandbox !== false,
		describe: args => args.command,
		run: async (_args, ctx) => {
			seen.push(ctx.sandbox ?? null);
			return 'ok';
		},
	});
	const {agent, approvals} = setup('once', {tools: [shell], sandboxUnavailable: null});
	const run = async (args: unknown) => {
		replies = [{call: {name: 'shell', args}}, {text: 'ok'}];
		await agent.send('go');
	};

	await run({command: 'npm test'});
	assert.deepEqual(seen.at(-1), {writeProject: true, network: false});
	assert.equal(approvals.length, 0);
	assert.match(requests.at(-1)!.messages[0]!.content ?? '', /run in a sandbox/);

	await run({command: 'npm install', sandbox: false});
	assert.equal(seen.at(-1), null);
	assert.equal(approvals.length, 1, 'leaving the sandbox needs approval');

	agent.setMode('plan');
	await run({command: 'npm test'});
	assert.deepEqual(seen.at(-1), {writeProject: false, network: false});
	assert.equal(approvals.length, 1);
	assert.match(requests.at(-1)!.messages[0]!.content ?? '', /read-only sandbox/);

	agent.setMode('auto');
	await run({command: 'npm test'});
	assert.equal(seen.at(-1), null, 'auto mode skips the sandbox');

	agent.setMode('ask');
	agent.sandbox = false;
	await run({command: 'npm test'});
	assert.equal(seen.at(-1), null);
	assert.equal(approvals.length, 2, 'with the sandbox off, commands ask again');
});

test('sandbox: unavailable on this platform means approvals as before', async () => {
	const {agent, approvals} = setup('once', {sandboxUnavailable: "Sandboxing isn't supported"});
	replies = [{call: {name: 'bash', args: {command: 'touch x'}}}, {text: 'ok'}];
	await agent.send('go');
	assert.equal(approvals.length, 1);
	assert.doesNotMatch(requests.at(-1)!.messages[0]!.content ?? '', /sandbox/);
});
