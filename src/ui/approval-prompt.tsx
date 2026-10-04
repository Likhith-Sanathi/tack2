import React from 'react';
import {Box, Text} from 'ink';
import {Select} from '@inkjs/ui';
import type {ApprovalDecision} from '../agent/agent.js';
import type {PendingApproval} from './use-agent.js';
import {DiffView, diffSummary} from './diff-view.js';

const MAX_PREVIEW_LINES = 30;
// Rows used by everything except the preview: tool line, prompt border, title, summary, margins,
// the three options and the status bar.
const CHROME_ROWS = 14;

export function ApprovalPrompt({approval, rows, columns}: {approval: PendingApproval; rows: number; columns: number}) {
	const {preview} = approval;
	const previewLines = Math.max(0, Math.min(MAX_PREVIEW_LINES, rows - CHROME_ROWS));
	const innerWidth = columns - 4; // border and padding
	const options = [
		{label: 'Yes', value: 'once'},
		{label: `Yes, and don't ask again for ${approval.toolName} this session`, value: 'always'},
		{label: 'No, and tell the agent what to do instead', value: 'deny'},
	];
	const textLines = preview?.type === 'text' ? preview.text.split('\n') : [];
	return (
		<Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
			<Text>
				Allow <Text bold color="yellow">{approval.toolName}</Text>?
			</Text>
			<Text bold={preview?.type === 'diff'}>{preview?.type === 'diff' ? diffSummary(preview) : approval.summary}</Text>
			{preview && previewLines === 0 && <Text dimColor>(enlarge the terminal to see a preview)</Text>}
			{preview?.type === 'diff' && previewLines > 0 && (
				<Box marginY={1}>
					<DiffView diff={preview} width={innerWidth} maxLines={previewLines} />
				</Box>
			)}
			{preview?.type === 'text' && previewLines > 0 && (
				<Box flexDirection="column" marginY={1}>
					{textLines.slice(0, textLines.length > previewLines ? previewLines - 1 : previewLines).map((line, i) => (
						<Text key={i} wrap="truncate-end" dimColor>
							{line || ' '}
						</Text>
					))}
					{textLines.length > previewLines && <Text dimColor>… {textLines.length - previewLines + 1} more lines</Text>}
				</Box>
			)}
			<Select options={options} onChange={value => approval.resolve(value as ApprovalDecision)} />
		</Box>
	);
}
