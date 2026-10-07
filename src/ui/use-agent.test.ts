import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {AgentEvent} from '../agent/agent.js';
import {applyEvent, type ChatItem} from './use-agent.js';

const run = (events: AgentEvent[]) => events.reduce(applyEvent, [] as ChatItem[]);

test('a response that interleaves text and reasoning leaves nothing open', () => {
	const items = run([
		{type: 'text', delta: '\n\n'},
		{type: 'reasoning', delta: 'thinking about it'},
		{type: 'text', delta: 'All clean.'},
		{type: 'assistant_done'},
	]);
	assert.deepEqual(
		items.map(i => i.kind),
		['thinking', 'assistant'],
		'the whitespace-only text is dropped',
	);
	const open = items.filter(i => (i.kind === 'assistant' && !i.done) || (i.kind === 'thinking' && i.seconds === undefined));
	assert.equal(open.length, 0);
});

test('text split around reasoning keeps both parts, finished', () => {
	const items = run([
		{type: 'text', delta: 'Let me check.'},
		{type: 'reasoning', delta: 'hmm'},
		{type: 'text', delta: 'Done.'},
		{type: 'assistant_done'},
	]);
	const replies = items.filter(i => i.kind === 'assistant');
	assert.deepEqual(replies.map(i => i.kind === 'assistant' && [i.text, i.done]), [['Let me check.', true], ['Done.', true]]);
});
