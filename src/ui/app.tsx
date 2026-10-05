import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Box, Static, useApp, useInput, useWindowSize} from 'ink';
import {listModels, listProviders, type ModelInfo, type Usage} from '../agent/openrouter.js';
import {thinkingLabel} from '../agent/thinking.js';
import {loadConfig, loadHistory, saveConfig, saveHistory, type ModelSettings} from '../config.js';
import {ChatItemView} from './chat-item.js';
import {ApprovalPrompt} from './approval-prompt.js';
import {ModelPicker, type ModelChoice} from './model-picker.js';
import {StatusBar, type Activity} from './status-bar.js';
import {PromptInput, type PromptInputHandle} from './prompt-input.js';
import {useAgent} from './use-agent.js';
import {matchCommands, resolveCommand} from './commands.js';

const HELP = [
	'Commands: /model (switch model), /web (web search on/off), /compact (summarize to free context), /clear (new conversation), /help, /exit (or /quit, /q)',
	'Keys: Enter sends · Shift+Enter, Option+Enter, Ctrl+J or \\ then Enter adds a new line · ↑/↓ history',
	'      Shift+Tab cycles permission modes: ask → auto-accept edits → plan (read-only) → auto (no approvals)',
	'      Esc interrupts the agent · Ctrl+C interrupts, clears the input, or quits when idle',
].join('\n');

/** e.g. `anthropic/claude-x (high, via Anthropic)`. */
function modelLabel(model: string, settings: ModelSettings): string {
	const details = [
		settings.thinking ? thinkingLabel(settings.thinking) : '',
		settings.providerName ? `via ${settings.providerName}` : '',
	].filter(Boolean);
	return details.length > 0 ? `${model} (${details.join(', ')})` : model;
}

export function App({apiKey, cwd, initialModel}: {apiKey: string; cwd: string; initialModel?: string}) {
	const {exit} = useApp();
	const {columns, rows} = useWindowSize();
	const [model, setModel] = useState(initialModel);
	const [picking, setPicking] = useState(!initialModel);
	const [models, setModels] = useState<ModelInfo[] | null>(null);
	const [modelsError, setModelsError] = useState<string | null>(null);
	const [web, setWeb] = useState(() => loadConfig().web ?? true);
	/** Thinking and provider choices remembered per model. */
	const [savedSettings, setSavedSettings] = useState<Record<string, ModelSettings>>(() => loadConfig().models ?? {});
	const [history, setHistory] = useState(loadHistory);
	const [draftLines, setDraftLines] = useState(1);
	// Rows the slash-command menu takes under the input (commands, margin and hint line).
	const [menuRows, setMenuRows] = useState(0);
	const draft = useRef('');
	const input = useRef<PromptInputHandle>(null);
	const [staticKey, setStaticKey] = useState(0);

	useEffect(() => {
		listModels(apiKey).then(setModels, (error: Error) => setModelsError(error.message));
	}, [apiKey]);

	const modelInfo = models?.find(m => m.id === model);
	const settings: ModelSettings = (model && savedSettings[model]) || {};
	// A pinned provider may offer a smaller context window than the model's maximum.
	const contextLength = settings.providerContext ?? modelInfo?.contextLength;
	const priceUsage = (u: Usage) =>
		modelInfo ? u.prompt_tokens * modelInfo.promptPrice + u.completion_tokens * modelInfo.completionPrice : 0;
	const agent = useAgent({apiKey, cwd, model: model ?? '', priceUsage});
	const {setModel: setAgentModel} = agent;

	// Keep the agent's model, context window, thinking and provider in sync (the model list may load
	// after startup).
	useEffect(() => {
		if (model) setAgentModel(model, contextLength, settings.thinking, settings.provider);
	}, [model, contextLength, settings.thinking, settings.provider, setAgentModel]);

	const {setWeb: setAgentWeb} = agent;
	useEffect(() => {
		setAgentWeb(web);
	}, [web, setAgentWeb]);

	const chooseModel = useCallback(
		({model: id, settings: chosen}: ModelChoice) => {
			setModel(id);
			setSavedSettings(prev => ({...prev, [id]: chosen}));
			setPicking(false);
			try {
				const config = loadConfig();
				saveConfig({...config, model: id, models: {...config.models, [id]: chosen}});
			} catch (error) {
				agent.addNotice(`Could not save config: ${(error as Error).message}`, 'error');
			}
			const thinking = chosen.thinking ? thinkingLabel(chosen.thinking) : 'model default';
			agent.addNotice(`Model: ${id} · thinking: ${thinking} · provider: ${chosen.providerName ?? 'auto'}`);
		},
		[agent],
	);

	useInput((char, key) => {
		if (key.tab && key.shift) {
			agent.cycleMode();
		} else if (key.escape) {
			// The model picker handles Esc itself (back a step, or cancel).
			if (agent.running) agent.interrupt();
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
		setMenuRows(0);
		setHistory(prev => {
			const next = prev.at(-1) === text ? prev : [...prev, text];
			saveHistory(next);
			return next;
		});
		if (!text.startsWith('/')) {
			void agent.send(text);
			return;
		}
		switch (resolveCommand(text.split(/\s+/)[0]!)) {
			case '/model':
				setPicking(true);
				break;
			case '/compact':
				void agent.compact();
				break;
			case '/web': {
				const enabled = !web;
				setWeb(enabled);
				try {
					saveConfig({...loadConfig(), web: enabled});
				} catch (error) {
					agent.addNotice(`Could not save config: ${(error as Error).message}`, 'error');
				}
				agent.addNotice(
					enabled
						? 'Web search on: the model can search (Exa, about $0.007 per search) and read pages through OpenRouter.'
						: 'Web search off.',
				);
				break;
			}
			case '/clear':
				agent.reset();
				process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
				setStaticKey(k => k + 1);
				break;
			case '/help':
				agent.addNotice(HELP);
				break;
			case '/exit':
				exit();
				break;
			default:
				agent.addNotice(`Unknown command ${text}. ${HELP}`, 'error');
		}
	};

	const inputActive = !agent.approval && !picking;
	const maxInputLines = Math.max(1, Math.min(12, Math.floor(rows / 3)));
	// Rows the input text takes, including its "more lines" indicators.
	const inputRows = Math.min(draftLines, maxInputLines) + (draftLines > maxInputLines ? 2 : 0) + menuRows;

	// Finished items are printed once via <Static>; only the in-progress tail re-renders.
	const firstLive = agent.items.findIndex(
		item =>
			(item.kind === 'assistant' && !item.done) ||
			(item.kind === 'thinking' && item.seconds === undefined) ||
			(item.kind === 'tool' && item.status === 'running'),
	);
	const splitAt = firstLive === -1 ? agent.items.length : firstLive;
	const staticEntries = agent.items.slice(0, splitAt);
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
				{entry => (
					// Static output is laid out without a parent width, so give it one explicitly for wrapping.
					<Box key={entry.id} width={columns}>
						<ChatItemView item={entry} width={columns} />
					</Box>
				)}
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
				picking && (
					<ModelPicker
						rows={rows}
						models={models}
						error={modelsError}
						current={model}
						saved={savedSettings}
						loadProviders={(id, signal) => listProviders(apiKey, id, signal)}
						onSelect={chooseModel}
						onCancel={model ? () => setPicking(false) : undefined}
					/>
				)
			)}
			{/* Stays mounted while hidden so a draft survives approval prompts and the model picker. */}
			<Box display={inputActive ? 'flex' : 'none'} flexDirection="column">
				<PromptInput
					ref={input}
					accentColor={agent.running ? 'white' : 'cyan'}
					isActive={inputActive}
					canSubmit={!agent.running}
					maxLines={maxInputLines}
					history={history}
					placeholder={agent.running ? 'Agent is working… type ahead, Esc to interrupt' : 'Ask tack to do something'}
					onSubmit={submit}
					onChange={value => {
						draft.current = value;
						setDraftLines(value.split('\n').length);
						const matches = matchCommands(value).length;
						setMenuRows(matches > 0 ? matches + 2 : 0);
					}}
				/>
			</Box>
			<StatusBar
				model={model && modelLabel(model, settings)}
				activity={activity}
				mode={agent.mode}
				web={web}
				width={columns}
				usage={agent.usage}
				contextLength={contextLength}
			/>
		</Box>
	);
}
