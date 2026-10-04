import React, {useMemo, useState} from 'react';
import {Box, Text} from 'ink';
import {Select, Spinner, TextInput} from '@inkjs/ui';
import type {ModelInfo} from '../agent/openrouter.js';

function price(perToken: number): string {
	return `$${(perToken * 1_000_000).toFixed(2)}`;
}

export function ModelPicker(props: {
	models: ModelInfo[] | null;
	error: string | null;
	current?: string;
	rows: number;
	onSelect: (model: string) => void;
}) {
	const [filter, setFilter] = useState('');
	const options = useMemo(() => {
		const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
		return (props.models ?? [])
			.filter(m => m.supportsTools)
			.filter(m => terms.every(t => `${m.id} ${m.name}`.toLowerCase().includes(t)))
			.map(m => ({
				label: `${m.id === props.current ? '✓ ' : ''}${m.id}  (${price(m.promptPrice)} in / ${price(m.completionPrice)} out per 1M, ${Math.round(m.contextLength / 1000)}k ctx)`,
				value: m.id,
			}));
	}, [props.models, props.current, filter]);

	return (
		<Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} marginTop={1}>
			<Text bold>Select a model</Text>
			<Text dimColor>
				Type to filter, ↑/↓ to move, Enter to choose{props.current ? ', Esc to cancel' : ''}. Enter any model id
				to use it directly.
			</Text>
			<Box>
				<Text color="blue">{'filter: '}</Text>
				<TextInput
					placeholder="e.g. claude, gpt, qwen coder"
					onChange={setFilter}
					onSubmit={value => {
						// Select handles Enter when it has options; this covers custom ids.
						if (options.length === 0 && value.trim()) props.onSelect(value.trim());
					}}
				/>
			</Box>
			<Box marginTop={1} flexDirection="column">
				{props.models === null && !props.error && <Spinner label="Loading models from OpenRouter…" />}
				{props.error && <Text color="red">Could not load model list: {props.error}</Text>}
				{props.models !== null && options.length === 0 && (
					<Text dimColor>No tool-capable models match. Press Enter to use "{filter.trim()}" as a model id.</Text>
				)}
				{options.length > 0 && <Select options={options} visibleOptionCount={Math.max(3, Math.min(10, props.rows - 12))} onChange={props.onSelect} />}
			</Box>
		</Box>
	);
}
