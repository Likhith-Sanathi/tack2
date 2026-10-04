import React from 'react';
import {Box, Text} from 'ink';
import {Select} from '@inkjs/ui';
import type {ApprovalDecision} from '../agent/agent.js';
import type {PendingApproval} from './use-agent.js';

const MAX_PREVIEW_LINES = 20;
// Rows used by everything except the preview: tool line, prompt border, title, summary, margins,
// "more lines" note, the three options and the status bar.
const CHROME_ROWS = 15;

export function ApprovalPrompt({approval, rows}: {approval: PendingApproval; rows: number}) {
	const preview = approval.preview?.split('\n');
	const previewLines = Math.max(0, Math.min(MAX_PREVIEW_LINES, rows - CHROME_ROWS));
	const options = [
		{label: 'Yes', value: 'once'},
		{label: `Yes, and don't ask again for ${approval.toolName} this session`, value: 'always'},
		{label: 'No, and tell the agent what to do instead', value: 'deny'},
	];
	return (
		<Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
			<Text>
				Allow <Text bold color="yellow">{approval.toolName}</Text>?
			</Text>
			<Text>{approval.summary}</Text>
			{preview && previewLines === 0 && <Text dimColor>({preview.length} lines; enlarge the terminal to preview)</Text>}
			{preview && previewLines > 0 && (
				<Box flexDirection="column" marginY={1}>
					{preview.slice(0, previewLines).map((line, i) => (
						<Text key={i} wrap="truncate-end" color={line.startsWith('+ ') ? 'green' : line.startsWith('- ') ? 'red' : undefined} dimColor={!/^[+-] /.test(line)}>
							{line || ' '}
						</Text>
					))}
					{preview.length > previewLines && <Text dimColor>… {preview.length - previewLines} more lines</Text>}
				</Box>
			)}
			<Select options={options} onChange={value => approval.resolve(value as ApprovalDecision)} />
		</Box>
	);
}
