import {test} from 'node:test';
import assert from 'node:assert/strict';
import {COMMANDS, matchCommands} from './commands.js';

const names = (value: string) => matchCommands(value).map(c => c.name);

test('a lone "/" lists every command', () => {
	assert.deepEqual(names('/'), COMMANDS.map(c => c.name));
});

test('prefix matches come before other matches', () => {
	assert.deepEqual(names('/c'), ['/compact', '/clear']);
	assert.deepEqual(names('/e'), ['/exit', '/model', '/clear', '/help']);
	assert.deepEqual(names('/mod'), ['/model']);
});

test('no menu for plain text, arguments, new lines or unknown commands', () => {
	assert.deepEqual(names(''), []);
	assert.deepEqual(names('hello'), []);
	assert.deepEqual(names('/model x'), []);
	assert.deepEqual(names('/help\nmore'), []);
	assert.deepEqual(names('/zzz'), []);
});
