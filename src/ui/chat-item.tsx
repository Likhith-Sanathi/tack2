import React, {useMemo} from 'react';
import {Box, Text} from 'ink';
import {Spinner, StatusMessage} from '@inkjs/ui';
import type {ChatItem} from './use-agent.js';
import {tailToFit} from './fit.js';
import {renderMarkdown} from './markdown.js';
import {DiffView, diffSummary} from './diff-view.js';

const MAX_RESULT_LINES = 6;
const MAX_LIVE_OUTPUT_LINES = 5;
const MAX_THINKING_LINES = 6;
const MAX_DIFF_LINES = 40;

/** The last few lines of a running command's output. */
function LiveOutput({text, maxLines}: {text: string; maxLines: number}) {
	const lines = text.replace(/\r/g, '').trimEnd().split('\n');
	const shown = lines.slice(-maxLines);
	return (
		<Box marginLeft={2} flexDirection="column">
			{lines.length > shown.length && <Text dimColor>{`  … ${lines.length - shown.length} earlier lines`}</Text>}
			{shown.map((line, i) => (
				<Text key={i} dimColor wrap="truncate-end">
					{'  '}
					{line || ' '}
				</Text>
			))}
		</Box>
	);
}

function ToolResult({text, color}: {text: string; color?: string}) {
	const lines = text.split('\n');
	const shown = lines.slice(0, MAX_RESULT_LINES);
	return (
		<Box marginLeft={2} flexDirection="column">
			{shown.map((line, i) => (
				<Text key={i} color={color} dimColor={!color} wrap="truncate-end">
					{i === 0 ? '⎿ ' : '  '}
					{line || ' '}
				</Text>
			))}
			{lines.length > shown.length && <Text dimColor>{`  … ${lines.length - shown.length} more lines`}</Text>}
		</Box>
	);
}

export function ChatItemView({
	item,
	maxRows,
	width = 80,
	awaitingApproval = false,
}: {
	item: ChatItem;
	/** Row budget for a still-streaming message; older lines are hidden until it finishes. */
	maxRows?: number;
	width?: number;
	awaitingApproval?: boolean;
}) {
	// Trailing spaces from a partial stream would overflow the line when wrapped.
	const assistantText = item.kind === 'assistant' ? item.text.trimEnd() : '';
	// Memoized because spinner ticks re-render the live area many times a second.
	const markdown = useMemo(() => renderMarkdown(assistantText), [assistantText]);
	switch (item.kind) {
		case 'user':
			return (
				<Box marginTop={1}>
					<Text color="cyan" bold>
						{'› '}
					</Text>
					<Box flexShrink={1}>
						<Text>{item.text}</Text>
					</Box>
				</Box>
			);
		case 'assistant': {
			// A reply that so far is only whitespace (e.g. a newline before a tool call) has nothing to show.
			if (item.text.trim() === '') return null;
			const shown = maxRows === undefined ? {text: markdown, hidden: false} : tailToFit(markdown, width - 2, maxRows);
			return (
				<Box marginTop={1} flexDirection="column">
					{shown.hidden && <Text dimColor>  … (earlier lines shown when the reply finishes)</Text>}
					<Box>
						<Text color="magenta">{'● '}</Text>
						<Box flexShrink={1}>
							<Text>{shown.text}</Text>
						</Box>
					</Box>
				</Box>
			);
		}
		case 'tool': {
			const color = {running: 'yellow', ok: 'green', error: 'red', denied: 'gray', blocked: 'gray', interrupted: 'gray'}[item.status];
			return (
				<Box marginTop={1} flexDirection="column">
					<Box>
						{item.status !== 'running' ? (
							<Text color={color}>●</Text>
						) : awaitingApproval ? (
							<Text color="yellow">?</Text>
						) : (
							<Spinner />
						)}
						<Text>
							{' '}
							<Text bold color={color}>
								{item.name}
							</Text>{' '}
							<Text dimColor>{item.summary}</Text>
						</Text>
					</Box>
					{item.status === 'running' && item.output && !awaitingApproval && (
						<LiveOutput text={item.output} maxLines={Math.min(MAX_LIVE_OUTPUT_LINES, Math.max(1, (maxRows ?? 99) - 3))} />
					)}
					{item.status === 'ok' && item.preview?.type === 'diff' ? (
						<Box marginLeft={2} flexDirection="column">
							<Text>
								{'⎿ '}
								{diffSummary(item.preview)}
							</Text>
							<Box marginLeft={2}>
								<DiffView diff={item.preview} width={width - 4} maxLines={MAX_DIFF_LINES} />
							</Box>
						</Box>
					) : (
						item.result !== undefined && (
							<ToolResult text={item.result} color={item.status === 'error' ? 'red' : undefined} />
						)
					)}
				</Box>
			);
		}
		case 'thinking': {
			if (item.seconds !== undefined) {
				return (
					<Box marginTop={1}>
						<Text dimColor italic>
							✻ Thought for {item.seconds}s
						</Text>
					</Box>
				);
			}
			const budget = Math.min(MAX_THINKING_LINES, Math.max(1, (maxRows ?? 99) - 1));
			const tail = tailToFit(item.text.trim(), width - 4, budget);
			return (
				<Box marginTop={1} flexDirection="column">
					<Text color="magenta" italic>
						✻ Thinking…
					</Text>
					<Box marginLeft={2}>
						<Text dimColor italic>
							{tail.text}
						</Text>
					</Box>
				</Box>
			);
		}
		case 'notice':
			return (
				<Box marginTop={1}>
					<StatusMessage variant="warning">{item.text}</StatusMessage>
				</Box>
			);
		case 'sources':
			return (
				<Box marginTop={1} marginLeft={2} flexDirection="column">
					<Text dimColor>Sources</Text>
					{item.sources.map((source, i) => (
						<Text key={source.url} dimColor wrap="truncate-end">
							{`${i + 1}. `}
							{source.title ? `${source.title} — ` : ''}
							<Text color="blue">{source.url}</Text>
						</Text>
					))}
				</Box>
			);
		case 'info':
			return (
				<Box marginTop={1}>
					<StatusMessage variant="info">{item.text}</StatusMessage>
				</Box>
			);
		case 'error':
			return (
				<Box marginTop={1}>
					<StatusMessage variant="error">{item.text}</StatusMessage>
				</Box>
			);
	}
}
