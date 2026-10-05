import React from 'react';
import {Box, Text} from 'ink';
import {Spinner} from '@inkjs/ui';
import type {UsageTotals} from './use-agent.js';
import type {PermissionMode} from '../agent/permissions.js';

export type Activity = 'idle' | 'thinking' | 'tool' | 'approval';

function formatTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const ACTIVITY: Record<Activity, string> = {
	idle: 'ready',
	thinking: 'thinking',
	tool: 'running tool',
	approval: 'awaiting approval',
};

const MODES: Record<PermissionMode, {label: string; color?: string; bold?: boolean}> = {
	ask: {label: 'ask mode'},
	'auto-edit': {label: '⏵⏵ auto-accept edits', color: 'magenta'},
	plan: {label: '⏸ plan mode', color: 'cyan'},
	auto: {label: '⏵⏵⏵ auto: no approvals', color: 'red', bold: true},
};

/** Room the right side needs before the left side gives up its key hints. */
const MIN_RIGHT = 30;

/**
 * One line, always: the live area is sized assuming the status bar takes exactly one row. The
 * left side keeps its size; on the right the model name is cut short first, and when even that
 * isn't enough the key hints on the left are dropped.
 */
export function StatusBar(props: {
	model?: string;
	activity: Activity;
	mode: PermissionMode;
	web: boolean;
	usage: UsageTotals;
	contextLength?: number;
	width: number;
}) {
	const {usage} = props;
	const mode = MODES[props.mode];
	const busy = props.activity !== 'idle';
	const stats = [
		`↑${formatTokens(usage.promptTokens)} ↓${formatTokens(usage.completionTokens)}`,
		`$${usage.cost.toFixed(4)}`,
		props.contextLength ? `ctx ${Math.round((usage.lastPromptTokens / props.contextLength) * 100)}%` : '',
	]
		.filter(Boolean)
		.join(' · ');
	const model = props.model ?? 'no model';

	// Plain-text length of the full left side, to decide whether the hints fit.
	const fullLeft = [
		`● ${ACTIVITY[props.activity]}${busy ? ' · esc to interrupt' : ''}`,
		'·',
		`${mode.label} (shift+tab)`,
		props.web ? '· web' : '',
	]
		.filter(Boolean)
		.join(' ');
	const hints = fullLeft.length + MIN_RIGHT + 4 <= props.width;

	const activityText = `${ACTIVITY[props.activity]}${busy && hints ? ' · esc to interrupt' : ''}`;
	return (
		<Box paddingX={1} width={props.width} height={1} overflow="hidden">
			<Box flexShrink={0} gap={1}>
				{props.activity === 'idle' ? (
					<Text color="green">● {activityText}</Text>
				) : props.activity === 'approval' ? (
					<Text color="yellow">● {activityText}</Text>
				) : (
					<Spinner label={activityText} />
				)}
				<Text dimColor>·</Text>
				<Text color={mode.color} bold={mode.bold} dimColor={!mode.color}>
					{mode.label}
					{hints && <Text dimColor bold={false}> (shift+tab)</Text>}
				</Text>
				{props.web && <Text dimColor>· web</Text>}
			</Box>
			{/* Right-aligned; only the model name shrinks (with "…"). */}
			<Box flexGrow={1} flexShrink={1} justifyContent="flex-end" marginLeft={2} minWidth={0}>
				<Box flexShrink={1} minWidth={0}>
					<Text dimColor wrap="truncate-end">
						{model}
					</Text>
				</Box>
				<Box flexShrink={0}>
					<Text dimColor>{` · ${stats}`}</Text>
				</Box>
			</Box>
		</Box>
	);
}
