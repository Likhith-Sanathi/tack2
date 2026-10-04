import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Box, Static, Text, useApp, useInput, useWindowSize} from 'ink';
import {listModels, type ModelInfo, type Usage} from '../agent/openrouter.js';
import {loadConfig, loadHistory, saveConfig, saveHistory} from '../config.js';
import {ChatItemView} from './chat-item.js';
import {ApprovalPrompt} from './approval-prompt.js';
import {ModelPicker} from './model-picker.js';
import {StatusBar, type Activity} from './status-bar.js';
import {PromptInput, type PromptInputHandle} from './prompt-input.js';
import {useAgent, type ChatItem} from './use-agent.js';

const HELP = [
	'Commands: /model (switch model), /compact (summarize to free context), /clear (new conversation), /help, /exit',
	'Keys: Enter sends · Shift+Enter, Option+Enter, Ctrl+J or \\ then Enter adds a new line · ↑/↓ history',
	'      Shift+Tab cycles permission modes: ask → auto-accept edits → plan (read-only) → auto (no approvals)',
	'      Esc interrupts the agent · Ctrl+C interrupts, clears the input, or quits when idle',
].join('\n');

type StaticEntry = {id: number; kind: 'header'} | ChatItem;

export function App({apiKey, cwd, initialModel}: {apiKey: string; cwd: string; initialModel?: string}) {
	const {exit} = useApp();
	const {columns, rows} = useWindowSize();
	const [model, setModel] = useState(initialModel);
	const [picking, setPicking] = useState(!initialModel);
	const [models, setModels] = useState<ModelInfo[] | null>(null);
	const [modelsError, setModelsError] = useState<string | null>(null);
	const [history, setHistory] = useState(loadHistory);
	const [draftLines, setDraftLines] = useState(1);
	const draft = useRef('');
	const input = useRef<PromptInputHandle>(null);
	const [staticKey, setStaticKey] = useState(0);

	useEffect(() => {
		listModels(apiKey).then(setModels, (error: Error) => setModelsError(error.message));
	}, [apiKey]);

	const modelInfo = models?.find(m => m.id === model);
	const priceUsage = (u: Usage) =>
		modelInfo ? u.prompt_tokens * modelInfo.promptPrice + u.completion_tokens * modelInfo.completionPrice : 0;
	const agent = useAgent({apiKey, cwd, model: model ?? '', priceUsage});
	const {setModel: setAgentModel} = agent;

	// Keep the agent's model and context window in sync (the model list may load after startup).
	useEffect(() => {
		if (model) setAgentModel(model, modelInfo?.contextLength);
	}, [model, modelInfo?.contextLength, setAgentModel]);

	const chooseModel = useCallback(
		(id: string) => {
			setModel(id);
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

	useInput((char, key) => {
		if (key.tab && key.shift) {
			agent.cycleMode();
		} else if (key.escape) {
			if (agent.running) agent.interrupt();
			else if (picking && model) setPicking(false);
		} else if (key.ctrl && char === 'c') {
			if (agent.running) agent.interrupt();
			else if (draft.current) input.current?.clear();
			else exit();
		}
	});

	const submit = (value: string) => {
		const text = value.trim();
		if (!text) return;
		draft.current = '';
		setDraftLines(1);
		setHistory(prev => {
			const next = prev.at(-1) === text ? prev : [...prev, text];
			saveHistory(next);
			return next;
		});
		if (!text.startsWith('/')) {
			void agent.send(text);
			return;
		}
		switch (text.split(/\s+/)[0]) {
			case '/model':
				setPicking(true);
				break;
			case '/compact':
				void agent.compact();
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

	const inputActive = !agent.approval && !picking;
	const maxInputLines = Math.max(1, Math.min(12, Math.floor(rows / 3)));
	// Rows the input text takes, including its "more lines" indicators.
	const inputRows = Math.min(draftLines, maxInputLines) + (draftLines > maxInputLines ? 2 : 0);

	// Finished items are printed once via <Static>; only the in-progress tail re-renders.
	const firstLive = agent.items.findIndex(
		item =>
			(item.kind === 'assistant' && !item.done) ||
			(item.kind === 'thinking' && item.seconds === undefined) ||
			(item.kind === 'tool' && item.status === 'running'),
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
							<Text dimColor>/help for commands · Shift+Tab to change permission mode · Esc to interrupt</Text>
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
				<ChatItemView
					key={item.id}
					item={item}
					width={columns}
					// Leave room for the input box, status bar and margins so the live frame never fills the terminal.
					maxRows={Math.max(1, rows - 8 - inputRows)}
					awaitingApproval={agent.approval !== null}
				/>
			))}
			{agent.approval ? (
				<ApprovalPrompt approval={agent.approval} rows={rows} columns={columns} />
			) : (
				picking && <ModelPicker rows={rows} models={models} error={modelsError} current={model} onSelect={chooseModel} />
			)}
			{/* Stays mounted while hidden so a draft survives approval prompts and the model picker. */}
			<Box
				display={inputActive ? 'flex' : 'none'}
				borderStyle="round"
				borderColor={agent.running ? 'gray' : 'cyan'}
				paddingX={1}
				marginTop={1}
			>
				<PromptInput
					ref={input}
					isActive={inputActive}
					canSubmit={!agent.running}
					maxLines={maxInputLines}
					history={history}
					placeholder={agent.running ? 'Agent is working… type ahead, Esc to interrupt' : 'Ask tack to do something'}
					onSubmit={submit}
					onChange={value => {
						draft.current = value;
						setDraftLines(value.split('\n').length);
					}}
				/>
			</Box>
			<StatusBar
				model={model}
				activity={activity}
				mode={agent.mode}
				usage={agent.usage}
				contextLength={modelInfo?.contextLength}
			/>
		</Box>
	);
}
