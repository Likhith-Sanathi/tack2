import {test} from 'node:test';
import assert from 'node:assert/strict';
import {COMMANDS, matchCommands, resolveCommand} from './commands.js';

const names = (value: string) => matchCommands(value).map(c => c.name);

test('a lone "/" lists every command', () => {
	assert.deepEqual(names('/'), COMMANDS.map(c => c.name));
});

test('prefix matches come before other matches', () => {
	assert.deepEqual(names('/c'), ['/compact', '/clear']);
	assert.deepEqual(names('/e'), ['/exit', '/model', '/web', '/clear', '/help']);
	assert.deepEqual(names('/mod'), ['/model']);
});

test('no menu for plain text, arguments, new lines or unknown commands', () => {
	assert.deepEqual(names(''), []);
	assert.deepEqual(names('hello'), []);
	assert.deepEqual(names('/model x'), []);
	assert.deepEqual(names('/help\nmore'), []);
	assert.deepEqual(names('/zzz'), []);
});

test('aliases match and show the alias being typed', () => {
	assert.deepEqual(names('/q'), ['/q']);
	assert.deepEqual(names('/qu'), ['/quit']);
	assert.deepEqual(names('/quit'), ['/quit']);
	assert.equal(matchCommands('/q')[0]!.description, 'Quit tack');
});

test('resolveCommand maps aliases to the main command', () => {
	assert.equal(resolveCommand('/exit'), '/exit');
	assert.equal(resolveCommand('/quit'), '/exit');
	assert.equal(resolveCommand('/q'), '/exit');
	assert.equal(resolveCommand('/Q'), '/exit');
	assert.equal(resolveCommand('/model'), '/model');
	assert.equal(resolveCommand('/nope'), null);
});
