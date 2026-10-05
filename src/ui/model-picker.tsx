import React, {useEffect, useMemo, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {Spinner} from '@inkjs/ui';
import type {ModelInfo, ProviderInfo} from '../agent/openrouter.js';
import {defaultThinking, thinkingLabel, thinkingLevels} from '../agent/thinking.js';
import type {ModelSettings} from '../config.js';

// Two steps: pick a model (←/→ set its thinking level), then a provider, or Auto.
// ink-ui's Select can't report the highlighted row and its TextInput uses ←/→, so the lists and
// the filter are drawn here.

export type ModelChoice = {model: string; settings: ModelSettings};

type Props = {
	models: ModelInfo[] | null;
	error: string | null;
	current?: string;
	/** Remembered thinking/provider choices per model. */
	saved: Record<string, ModelSettings>;
	rows: number;
	loadProviders: (model: string, signal: AbortSignal) => Promise<ProviderInfo[]>;
	onSelect: (choice: ModelChoice) => void;
	/** Closes the picker; absent when a model must be chosen. */
	onCancel?: () => void;
};

const perMillion = (perToken: number) => `$${(perToken * 1_000_000).toFixed(2)}`;
const prices = (prompt: number, completion: number) => `${perMillion(prompt)}/${perMillion(completion)} per 1M`;
const context = (tokens: number) => (tokens > 0 ? `${Math.round(tokens / 1000)}k ctx` : '');
const uptime = (value: number) => `${(value <= 1 ? value * 100 : value).toFixed(1)}% up`;

/** Rows of a scrolling list. Always the same height, so the layout doesn't jump. */
function ScrollList({rows, index, visible}: {rows: React.ReactNode[]; index: number; visible: number}) {
	const first = Math.max(0, Math.min(index - Math.floor(visible / 2), rows.length - visible));
	const shown = rows.slice(first, first + visible);
	const below = rows.length - first - shown.length;
	return (
		<Box flexDirection="column">
			<Text dimColor>{first > 0 ? `  ↑ ${first} more` : ' '}</Text>
			{shown.map((row, i) => (
				<Box key={first + i}>
					<Text color={first + i === index ? 'cyan' : undefined}>{first + i === index ? '❯ ' : '  '}</Text>
					<Box flexShrink={1}>{row}</Box>
				</Box>
			))}
			<Text dimColor>{below > 0 ? `  ↓ ${below} more` : ' '}</Text>
		</Box>
	);
}

/** The thinking levels for a model, with the current one highlighted. */
function ThinkingSlider({model, level, isDefault}: {model: ModelInfo | undefined; level?: string; isDefault: boolean}) {
	const levels = model ? thinkingLevels(model) : [];
	if (!model || levels.length === 0) {
		return <Text dimColor>Thinking: not adjustable for this model</Text>;
	}
	return (
		<Text wrap="truncate-end">
			<Text>Thinking </Text>
			<Text dimColor>◀ </Text>
			{levels.map((l, i) => (
				<Text key={l}>
					{i > 0 ? '  ' : ''}
					{l === level ? (
						<Text color="magenta" bold>
							[{thinkingLabel(l)}]
						</Text>
					) : (
						<Text dimColor>{thinkingLabel(l)}</Text>
					)}
				</Text>
			))}
			<Text dimColor> ▶{isDefault ? '  (model default)' : ''}</Text>
		</Text>
	);
}

export function ModelPicker(props: Props) {
	const [step, setStep] = useState<'model' | 'provider'>('model');
	const [filter, setFilter] = useState('');
	const [index, setIndex] = useState(0);
	/** Thinking level chosen per model in this picker, seeded from saved settings. */
	const [thinking, setThinking] = useState<Record<string, string>>(() =>
		Object.fromEntries(
			Object.entries(props.saved).flatMap(([id, s]) => (s.thinking ? [[id, s.thinking] as const] : [])),
		),
	);
	const [chosen, setChosen] = useState<string>('');
	const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
	const [providersError, setProvidersError] = useState<string | null>(null);
	const [providerIndex, setProviderIndex] = useState(0);

	const options = useMemo(() => {
		const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
		return (props.models ?? [])
			.filter(m => m.supportsTools)
			.filter(m => terms.every(t => `${m.id} ${m.name}`.toLowerCase().includes(t)));
	}, [props.models, filter]);

	// Start on the current model once the list has loaded.
	useEffect(() => {
		if (!props.models || !props.current) return;
		const at = options.findIndex(m => m.id === props.current);
		if (at >= 0) setIndex(at);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.models]);

	// Load the chosen model's providers for step two.
	useEffect(() => {
		if (step !== 'provider') return;
		const controller = new AbortController();
		setProviders(null);
		setProvidersError(null);
		props.loadProviders(chosen, controller.signal).then(
			list => {
				const usable = list.filter(p => p.supportsTools);
				setProviders(usable);
				// Start on the provider used last time for this model, else Auto.
				const saved = props.saved[chosen]?.provider;
				setProviderIndex(Math.max(0, usable.findIndex(p => p.slug === saved) + 1));
			},
			(error: Error) => {
				if (!controller.signal.aborted) {
					setProviders([]);
					setProvidersError(error.message);
				}
			},
		);
		return () => controller.abort();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [step, chosen]);

	const highlighted = options[Math.min(index, options.length - 1)];
	const levelFor = (model: ModelInfo | undefined) =>
		model ? (thinking[model.id] ?? defaultThinking(model)) : undefined;

	const choose = (provider?: ProviderInfo) => {
		props.onSelect({
			model: chosen,
			settings: {
				thinking: thinking[chosen],
				provider: provider?.slug,
				providerName: provider?.name,
				providerContext: provider?.contextLength || undefined,
			},
		});
	};

	useInput((input, key) => {
		if (step === 'provider') {
			const count = (providers?.length ?? 0) + 1; // Auto first
			if (key.escape) setStep('model');
			else if (key.upArrow) setProviderIndex(i => Math.max(0, i - 1));
			else if (key.downArrow) setProviderIndex(i => Math.min(count - 1, i + 1));
			else if (key.return && providers !== null) choose(providerIndex === 0 ? undefined : providers[providerIndex - 1]);
			return;
		}

		if (key.escape) return props.onCancel?.();
		if (key.upArrow) return setIndex(i => Math.max(0, i - 1));
		if (key.downArrow) return setIndex(i => Math.min(Math.max(0, options.length - 1), i + 1));
		if (key.leftArrow || key.rightArrow) {
			const levels = highlighted ? thinkingLevels(highlighted) : [];
			const current = levels.indexOf(levelFor(highlighted) ?? '');
			const next = Math.max(0, Math.min(levels.length - 1, current + (key.rightArrow ? 1 : -1)));
			if (highlighted && levels[next]) setThinking(t => ({...t, [highlighted.id]: levels[next]!}));
			return;
		}
		if (key.return) {
			const id = highlighted?.id ?? filter.trim();
			if (!id) return;
			setChosen(id);
			setStep('provider');
			return;
		}
		if (key.backspace || key.delete) {
			setFilter(f => f.slice(0, -1));
			setIndex(0);
			return;
		}
		if (key.ctrl && input === 'u') {
			setFilter('');
			setIndex(0);
			return;
		}
		if (input && !key.ctrl && !key.meta && !key.tab) {
			setFilter(f => f + input.replace(/[\r\n]/g, ''));
			setIndex(0);
		}
	});

	const visible = Math.max(3, Math.min(10, props.rows - 16));

	if (step === 'provider') {
		const model = props.models?.find(m => m.id === chosen);
		const level = levelFor(model);
		const rows = [
			<Text key="auto" wrap="truncate-end">
				<Text bold>Auto</Text>
				<Text dimColor>{'  OpenRouter picks the best available provider and falls back if one fails'}</Text>
			</Text>,
			...(providers ?? []).map(p => (
				<Text key={p.slug} wrap="truncate-end">
					<Text bold>{p.name}</Text>
					<Text dimColor>
						{'  '}
						{[p.slug, prices(p.promptPrice, p.completionPrice), context(p.contextLength), p.quantization, p.uptime !== undefined ? uptime(p.uptime) : '']
							.filter(Boolean)
							.join(' · ')}
					</Text>
				</Text>
			)),
		];
		return (
			<Box flexDirection="column" backgroundColor="black" paddingX={1} paddingY={1} marginTop={1}>
				<Text bold wrap="truncate-end">
					Provider for {chosen}
					{level ? <Text dimColor>{`  · thinking: ${thinkingLabel(level)}`}</Text> : null}
				</Text>
				<Text dimColor>↑/↓ to move, Enter to choose, Esc to go back to models.</Text>
				<Box flexDirection="column">
					{providers === null ? (
						<Spinner label="Loading providers…" />
					) : (
						<>
							{providersError && <Text color="red">Could not load providers ({providersError}); Auto still works.</Text>}
							<ScrollList rows={rows} index={providerIndex} visible={visible} />
						</>
					)}
				</Box>
			</Box>
		);
	}

	const rows = options.map(m => (
		<Text key={m.id} wrap="truncate-end">
			{m.id === props.current ? '✓ ' : ''}
			<Text bold={m === highlighted}>{m.id}</Text>
			<Text dimColor>{`  ${prices(m.promptPrice, m.completionPrice)} · ${context(m.contextLength)}`}</Text>
		</Text>
	));
	return (
		<Box flexDirection="column" backgroundColor="black" paddingX={1} paddingY={1} marginTop={1}>
			<Text bold>Select a model</Text>
			<Text dimColor wrap="truncate-end">
				Type to filter, ↑/↓ to move, ←/→ to set thinking, Enter for providers{props.onCancel ? ', Esc to cancel' : ''}.
			</Text>
			<Box>
				<Text color="blue">{'filter: '}</Text>
				{filter ? <Text>{filter}</Text> : <Text dimColor>e.g. claude, gpt, qwen coder</Text>}
				<Text inverse> </Text>
			</Box>
			<Box flexDirection="column">
				{props.models === null && !props.error && <Spinner label="Loading models from OpenRouter…" />}
				{props.error && <Text color="red">Could not load model list: {props.error}</Text>}
				{props.models !== null && options.length === 0 && (
					<Text dimColor>No tool-capable models match. Press Enter to use "{filter.trim()}" as a model id.</Text>
				)}
				{options.length > 0 && <ScrollList rows={rows} index={index} visible={visible} />}
			</Box>
			<Box marginTop={1}>
				<ThinkingSlider model={highlighted} level={levelFor(highlighted)} isDefault={!highlighted || !thinking[highlighted.id]} />
			</Box>
		</Box>
	);
}
