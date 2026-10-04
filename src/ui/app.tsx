import React, {useCallback, useEffect, useState} from 'react';
import {Box, Static, Text, useApp, useInput, useWindowSize} from 'ink';
import {TextInput} from '@inkjs/ui';
import {listModels, type ModelInfo, type Usage} from '../agent/openrouter.js';
import {loadConfig, saveConfig} from '../config.js';
import {ChatItemView} from './chat-item.js';
import {ApprovalPrompt} from './approval-prompt.js';
import {ModelPicker} from './model-picker.js';
import {StatusBar, type Activity} from './status-bar.js';
import {useAgent, type ChatItem} from './use-agent.js';

const HELP = [
	'Commands: /model (switch model), /clear (new conversation), /help, /exit',
	'Keys: Esc interrupts the agent · Ctrl+C interrupts, or quits when idle',
].join('\n');

type StaticEntry = {id: number; kind: 'header'} | ChatItem;

export function App({apiKey, cwd, initialModel}: {apiKey: string; cwd: string; initialModel?: string}) {
	const {exit} = useApp();
	const {columns} = useWindowSize();
	const [model, setModel] = useState(initialModel);
	const [picking, setPicking] = useState(!initialModel);
	const [models, setModels] = useState<ModelInfo[] | null>(null);
	const [modelsError, setModelsError] = useState<string | null>(null);
	const [inputKey, setInputKey] = useState(0);
	const [staticKey, setStaticKey] = useState(0);

	useEffect(() => {
		listModels(apiKey).then(setModels, (error: Error) => setModelsError(error.message));
	}, [apiKey]);

	const modelInfo = models?.find(m => m.id === model);
	const priceUsage = (u: Usage) =>
		modelInfo ? u.prompt_tokens * modelInfo.promptPrice + u.completion_tokens * modelInfo.completionPrice : 0;
	const agent = useAgent({apiKey, cwd, model: model ?? '', priceUsage});

	const chooseModel = useCallback(
		(id: string) => {
			setModel(id);
			agent.setModel(id);
			setPicking(false);
			try {
				saveConfig({...loadConfig(), model: id});
			} catch (error) {
				agent.addNotice(`Could not save config: ${(error as Error).message}`, 'error');
			}
			agent.addNotice(`Model: ${id}`);
		},
		[agent],
	);

	useInput((input, key) => {
		if (key.escape) {
			if (agent.running) agent.interrupt();
			else if (picking && model) setPicking(false);
		} else if (key.ctrl && input === 'c') {
			if (agent.running) agent.interrupt();
			else exit();
		}
	});

	const submit = (value: string) => {
		const text = value.trim();
		if (!text) return;
		setInputKey(k => k + 1); // remount the input to clear it
		if (!text.startsWith('/')) {
			void agent.send(text);
			return;
		}
		switch (text.split(/\s+/)[0]) {
			case '/model':
				setPicking(true);
				break;
			case '/clear':
				agent.reset();
				process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
				setStaticKey(k => k + 1);
				break;
			case '/help':
				agent.addNotice(HELP);
				break;
			case '/exit':
			case '/quit':
				exit();
				break;
			default:
				agent.addNotice(`Unknown command ${text}. ${HELP}`, 'error');
		}
	};

	// Finished items are printed once via <Static>; only the in-progress tail re-renders.
	const firstLive = agent.items.findIndex(
		item => (item.kind === 'assistant' && !item.done) || (item.kind === 'tool' && item.status === 'running'),
	);
	const splitAt = firstLive === -1 ? agent.items.length : firstLive;
	const staticEntries: StaticEntry[] = [{id: -1, kind: 'header'}, ...agent.items.slice(0, splitAt)];
	const liveItems = agent.items.slice(splitAt);

	const activity: Activity = agent.approval
		? 'approval'
		: !agent.running
			? 'idle'
			: liveItems.some(item => item.kind === 'tool')
				? 'tool'
				: 'thinking';

	return (
		<Box flexDirection="column">
			<Static key={staticKey} items={staticEntries}>
				{entry =>
					entry.kind === 'header' ? (
						<Box key="header" flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
							<Text bold color="magenta">
								tack
							</Text>
							<Text dimColor>{cwd}</Text>
							<Text dimColor>/help for commands · Esc to interrupt · Ctrl+C to quit</Text>
						</Box>
					) : (
						// Static output is laid out without a parent width, so give it one explicitly for wrapping.
						<Box key={entry.id} width={columns}>
							<ChatItemView item={entry} />
						</Box>
					)
				}
			</Static>
			{liveItems.map(item => (
				<ChatItemView key={item.id} item={item} />
			))}
			{agent.approval ? (
				<ApprovalPrompt approval={agent.approval} />
			) : picking ? (
				<ModelPicker models={models} error={modelsError} current={model} onSelect={chooseModel} />
			) : (
				<Box borderStyle="round" borderColor={agent.running ? 'gray' : 'cyan'} paddingX={1} marginTop={1}>
					<Text color="cyan">{'› '}</Text>
					<TextInput
						key={inputKey}
						isDisabled={agent.running}
						placeholder={agent.running ? 'Agent is working… (Esc to interrupt)' : 'Ask tack to do something'}
						onSubmit={submit}
					/>
				</Box>
			)}
			<StatusBar
				model={model}
				activity={activity}
				usage={agent.usage}
				contextLength={modelInfo?.contextLength}
			/>
		</Box>
	);
}
