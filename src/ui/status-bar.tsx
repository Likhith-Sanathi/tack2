import React from 'react';
import {Box, Text} from 'ink';
import {Spinner} from '@inkjs/ui';
import type {UsageTotals} from './use-agent.js';
import type {PermissionMode} from '../agent/permissions.js';

export type Activity = 'idle' | 'thinking' | 'tool' | 'approval';

function formatTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function ModeIndicator({mode}: {mode: PermissionMode}) {
	switch (mode) {
		case 'ask':
			return <Text dimColor>ask mode (shift+tab)</Text>;
		case 'auto-edit':
			return <Text color="magenta">⏵⏵ auto-accept edits <Text dimColor>(shift+tab)</Text></Text>;
		case 'plan':
			return <Text color="cyan">⏸ plan mode <Text dimColor>(shift+tab)</Text></Text>;
		case 'auto':
			return <Text color="red" bold>⏵⏵⏵ auto: no approvals <Text dimColor bold={false}>(shift+tab)</Text></Text>;
	}
}

export function StatusBar(props: {
	model?: string;
	activity: Activity;
	mode: PermissionMode;
	usage: UsageTotals;
	contextLength?: number;
}) {
	const {usage} = props;
	const context = props.contextLength
		? ` · ctx ${Math.round((usage.lastPromptTokens / props.contextLength) * 100)}%`
		: '';
	return (
		<Box justifyContent="space-between" paddingX={1}>
			<Box gap={1}>
				{props.activity === 'idle' ? (
					<Text color="green">● ready</Text>
				) : props.activity === 'approval' ? (
					<Text color="yellow">● awaiting approval · esc to interrupt</Text>
				) : (
					<Spinner label={`${props.activity === 'tool' ? 'running tool' : 'thinking'} · esc to interrupt`} />
				)}
				<Text dimColor>·</Text>
				<ModeIndicator mode={props.mode} />
			</Box>
			<Text dimColor>
				{props.model ?? 'no model'} · ↑{formatTokens(usage.promptTokens)} ↓{formatTokens(usage.completionTokens)} · $
				{usage.cost.toFixed(4)}
				{context}
			</Text>
		</Box>
	);
}
