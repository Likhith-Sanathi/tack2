import React from 'react';
import {Box, Text} from 'ink';
import type {DiffLine, FileDiff} from '../tools/index.js';

const STYLE = {
	add: {sign: '+', color: 'green', background: '#0f3d1a'},
	del: {sign: '-', color: 'red', background: '#4a1414'},
	ctx: {sign: ' ', color: undefined, background: undefined},
} as const;

/** Exactly `width` columns, so backgrounds span the row and long lines never wrap. */
function fit(text: string, width: number): string {
	return text.length > width ? text.slice(0, Math.max(0, width - 1)) + '…' : text.padEnd(width);
}

export function diffSummary(diff: FileDiff): string {
	if (diff.isNew) return `Created ${diff.path} (${diff.added} lines)`;
	return `Updated ${diff.path} (+${diff.added} -${diff.removed})`;
}

/** Changed lines with line numbers and red/green backgrounds; at most `maxLines` rows. */
export function DiffView({diff, width, maxLines}: {diff: FileDiff; width: number; maxLines: number}) {
	const rows: Array<DiffLine | 'gap'> = diff.hunks.flatMap((hunk, i) => (i === 0 ? hunk : ['gap' as const, ...hunk]));
	const numberWidth = String(Math.max(1, ...rows.map(row => (row === 'gap' ? 0 : row.lineNo)))).length;
	// Reserve a row for the "more lines" note when needed.
	const shown = rows.length > maxLines ? rows.slice(0, Math.max(0, maxLines - 1)) : rows;
	const hidden = rows.length - shown.length;

	return (
		<Box flexDirection="column">
			{shown.map((row, i) => {
				if (row === 'gap') return <Text key={i} dimColor>{'  …'}</Text>;
				const style = STYLE[row.kind];
				const number = String(row.lineNo).padStart(numberWidth);
				const text = fit(`${style.sign} ${row.text.replaceAll('\t', '  ')}`, width - numberWidth - 1);
				return (
					<Text key={i} backgroundColor={style.background}>
						<Text color={style.color} dimColor={row.kind === 'ctx'}>
							{number}{' '}
						</Text>
						<Text color={row.kind === 'ctx' ? undefined : 'white'}>{text}</Text>
					</Text>
				);
			})}
			{hidden > 0 && <Text dimColor>{`  … ${hidden} more lines`}</Text>}
		</Box>
	);
}
