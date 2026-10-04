#!/usr/bin/env node
import React from 'react';
import {render} from 'ink';
import {App} from './ui/app.js';
import {loadConfig} from './config.js';

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
	console.error('OPENROUTER_API_KEY is not set. Get a key at https://openrouter.ai/keys and export it.');
	process.exit(1);
}

// Ink asks the terminal whether it supports the kitty keyboard protocol before its input hooks
// switch the terminal to raw mode. Until then the terminal echoes its reply ("^[[?0u") onto the
// screen, so enter raw mode first. Ink reads the reply later and restores the mode on exit.
if (process.stdin.isTTY) process.stdin.setRawMode(true);

render(<App apiKey={apiKey} cwd={process.cwd()} initialModel={loadConfig().model} />, {
	exitOnCtrlC: false,
	// Lets terminals that support it report Shift+Enter, used for new lines in the prompt.
	kittyKeyboard: {mode: 'auto'},
});
