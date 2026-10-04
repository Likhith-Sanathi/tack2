import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Config = {model?: string};

const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'tack');
export const configPath = path.join(dir, 'config.json');

export function loadConfig(): Config {
	try {
		return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Config;
	} catch {
		return {};
	}
}

export function saveConfig(config: Config): void {
	fs.mkdirSync(dir, {recursive: true});
	fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

const historyPath = path.join(dir, 'history.json');
const MAX_HISTORY = 200;

/** Previously submitted prompts, oldest first. */
export function loadHistory(): string[] {
	try {
		const data: unknown = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
		return Array.isArray(data) ? data.filter((entry): entry is string => typeof entry === 'string') : [];
	} catch {
		return [];
	}
}

export function saveHistory(history: string[]): void {
	try {
		fs.mkdirSync(dir, {recursive: true});
		fs.writeFileSync(historyPath, JSON.stringify(history.slice(-MAX_HISTORY)) + '\n');
	} catch {
		// History is a convenience; never fail a prompt over it.
	}
}
