import React from 'react';
import {Box, Text} from 'ink';
import {Select} from '@inkjs/ui';
import type {ApprovalDecision} from '../agent/agent.js';
import type {PendingApproval} from './use-agent.js';

const MAX_PREVIEW_LINES = 20;

export function ApprovalPrompt({approval}: {approval: PendingApproval}) {
	const preview = approval.preview?.split('\n');
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
			{preview && (
				<Box flexDirection="column" marginY={1}>
					{preview.slice(0, MAX_PREVIEW_LINES).map((line, i) => (
						<Text key={i} wrap="truncate-end" color={line.startsWith('+ ') ? 'green' : line.startsWith('- ') ? 'red' : undefined} dimColor={!/^[+-] /.test(line)}>
							{line || ' '}
						</Text>
					))}
					{preview.length > MAX_PREVIEW_LINES && <Text dimColor>… {preview.length - MAX_PREVIEW_LINES} more lines</Text>}
				</Box>
			)}
			<Select options={options} onChange={value => approval.resolve(value as ApprovalDecision)} />
		</Box>
	);
}
