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

render(<App apiKey={apiKey} cwd={process.cwd()} initialModel={loadConfig().model} />, {exitOnCtrlC: false});
