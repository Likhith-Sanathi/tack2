import React, {useImperativeHandle, useReducer, useRef, type Ref} from 'react';
import {Box, Text, useInput, usePaste} from 'ink';

// Multi-line prompt editor with history. @inkjs/ui's TextInput is single-line, so this is custom.
//
// Enter submits. Shift+Enter (terminals with the kitty keyboard protocol), Option/Alt+Enter,
// Ctrl+J, or a trailing "\" before Enter insert a newline. ↑/↓ move between lines, and at the
// first/last line step through history. Pasted text is inserted as-is, newlines included.

export type PromptInputHandle = {clear: () => void};

type Props = {
	ref?: Ref<PromptInputHandle>;
	placeholder: string;
	/** When false, Enter is ignored (the text is kept) — e.g. while the agent is working. */
	canSubmit: boolean;
	/** When false, the input is hidden and ignores keys but keeps its text. */
	isActive: boolean;
	/** Maximum rows of text to show; the view scrolls to keep the cursor visible. */
	maxLines: number;
	history: string[];
	onSubmit: (value: string) => void;
	onChange?: (value: string) => void;
};

type Position = {row: number; col: number};

function position(value: string, cursor: number): Position {
	const before = value.slice(0, cursor).split('\n');
	return {row: before.length - 1, col: before.at(-1)!.length};
}

function offset(lines: string[], {row, col}: Position): number {
	let result = 0;
	for (let i = 0; i < row; i++) result += lines[i]!.length + 1;
	return result + Math.min(col, lines[row]!.length);
}

function previousWord(value: string, cursor: number): number {
	let i = cursor;
	while (i > 0 && /\s/.test(value[i - 1]!)) i--;
	while (i > 0 && !/\s/.test(value[i - 1]!)) i--;
	return i;
}

function nextWord(value: string, cursor: number): number {
	let i = cursor;
	while (i < value.length && /\s/.test(value[i]!)) i++;
	while (i < value.length && !/\s/.test(value[i]!)) i++;
	return i;
}

export function PromptInput({ref, placeholder, canSubmit, isActive, maxLines, history, onSubmit, onChange}: Props) {
	// Kept in a ref so several keys arriving before a re-render (fast typing) all see fresh state.
	const state = useRef({value: '', cursor: 0});
	// Index into history while browsing it (0 = newest), and the draft it replaced.
	const browsing = useRef<{index: number; draft: string} | null>(null);
	const [, rerender] = useReducer((n: number) => n + 1, 0);

	const set = (value: string, cursor: number, keepBrowsing = false) => {
		const changed = value !== state.current.value;
		state.current = {value, cursor: Math.max(0, Math.min(cursor, value.length))};
		if (!keepBrowsing) browsing.current = null;
		if (changed) onChange?.(value);
		rerender();
	};

	useImperativeHandle(ref, () => ({clear: () => set('', 0)}));

	const insert = (text: string) => {
		const {value, cursor} = state.current;
		set(value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length);
	};

	const showHistory = (index: number, cursorAtStart: boolean) => {
		const entry = index < 0 ? (browsing.current?.draft ?? '') : history[history.length - 1 - index]!;
		browsing.current = index < 0 ? null : {index, draft: browsing.current?.draft ?? state.current.value};
		set(entry, cursorAtStart ? 0 : entry.length, index >= 0);
	};

	useInput(
		(input, key) => {
			const {value, cursor} = state.current;
			const lines = value.split('\n');
			const pos = position(value, cursor);

			if (key.return) {
				if (key.shift || key.meta) return insert('\n');
				if (value[cursor - 1] === '\\') return set(value.slice(0, cursor - 1) + '\n' + value.slice(cursor), cursor);
				if (!canSubmit || !value.trim()) return;
				set('', 0);
				onSubmit(value);
				return;
			}
			if (input === '\n') return insert('\n'); // Ctrl+J
			if (key.upArrow) {
				if (pos.row > 0) return set(value, offset(lines, {row: pos.row - 1, col: pos.col}), true);
				const next = (browsing.current?.index ?? -1) + 1;
				if (next < history.length) showHistory(next, true);
				return;
			}
			if (key.downArrow) {
				if (pos.row < lines.length - 1) return set(value, offset(lines, {row: pos.row + 1, col: pos.col}), true);
				if (browsing.current) showHistory(browsing.current.index - 1, false);
				return;
			}
			if (key.leftArrow) return set(value, key.meta || key.ctrl ? previousWord(value, cursor) : cursor - 1, true);
			if (key.rightArrow) return set(value, key.meta || key.ctrl ? nextWord(value, cursor) : cursor + 1, true);
			// Option+B / Option+F: word movement in terminals that send arrows that way.
			if (key.meta && input === 'b') return set(value, previousWord(value, cursor), true);
			if (key.meta && input === 'f') return set(value, nextWord(value, cursor), true);
			if (key.home || (key.ctrl && input === 'a')) return set(value, offset(lines, {row: pos.row, col: 0}), true);
			if (key.end || (key.ctrl && input === 'e')) return set(value, offset(lines, {row: pos.row, col: Infinity}), true);
			if (key.ctrl && input === 'u') {
				const start = offset(lines, {row: pos.row, col: 0});
				return set(value.slice(0, start) + value.slice(cursor), start);
			}
			if (key.ctrl && input === 'k') {
				const end = offset(lines, {row: pos.row, col: Infinity});
				return set(value.slice(0, cursor) + value.slice(end), cursor);
			}
			if ((key.ctrl && input === 'w') || ((key.backspace || key.delete) && key.meta)) {
				const start = previousWord(value, cursor);
				return set(value.slice(0, start) + value.slice(cursor), start);
			}
			if (key.backspace || key.delete) {
				if (cursor === 0) return;
				return set(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
			}
			if (key.ctrl || key.meta || key.escape || key.tab || !input) return;
			insert(input.replace(/\r\n?/g, '\n'));
		},
		{isActive},
	);

	usePaste(text => insert(text.replace(/\r\n?/g, '\n').replaceAll('\t', '  ')), {isActive});

	const {value, cursor} = state.current;
	const lines = value.split('\n');
	const pos = position(value, cursor);
	// Scroll the visible window so the cursor's line stays in view.
	const visible = Math.max(1, maxLines);
	const first = Math.max(0, Math.min(pos.row - visible + 1, lines.length - visible));
	const shown = lines.slice(first, first + visible);
	const hiddenBelow = lines.length - first - shown.length;

	return (
		<Box flexDirection="column" display={isActive ? 'flex' : 'none'}>
			{first > 0 && <Text dimColor>{`  ↑ ${first} more line${first === 1 ? '' : 's'}`}</Text>}
			{shown.map((line, i) => {
				const row = first + i;
				const prefix = row === 0 ? <Text color="cyan">{'› '}</Text> : <Text>{'  '}</Text>;
				if (!value) {
					return (
						<Box key={row}>
							{prefix}
							<Text>
								<Text inverse>{placeholder[0] ?? ' '}</Text>
								<Text dimColor>{placeholder.slice(1)}</Text>
							</Text>
						</Box>
					);
				}
				const hasCursor = row === pos.row && isActive;
				return (
					<Box key={row}>
						{prefix}
						<Box flexShrink={1}>
							<Text>
								{hasCursor ? line.slice(0, pos.col) : line}
								{hasCursor && <Text inverse>{line[pos.col] ?? ' '}</Text>}
								{hasCursor && line.slice(pos.col + 1)}
							</Text>
						</Box>
					</Box>
				);
			})}
			{hiddenBelow > 0 && <Text dimColor>{`  ↓ ${hiddenBelow} more line${hiddenBelow === 1 ? '' : 's'}`}</Text>}
		</Box>
	);
}
