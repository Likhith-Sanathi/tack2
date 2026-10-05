import React, {useImperativeHandle, useReducer, useRef, type Ref} from 'react';
import {Box, Text, useInput, usePaste} from 'ink';
import {matchCommands} from './commands.js';

// Multi-line prompt editor with history. @inkjs/ui's TextInput is single-line, so this is custom.
//
// Enter submits. Shift+Enter (terminals with the kitty keyboard protocol), Option/Alt+Enter,
// Ctrl+J, or a trailing "\" before Enter insert a newline. ↑/↓ move between lines, and at the
// first/last line step through history. Pasted text is inserted as-is, newlines included.
//
// Typing "/" opens a menu of slash commands, filtered as you type, with the rest of the highlighted
// command shown as dim ghost text. ↑/↓ pick a command, Tab (or → at the end) fills it in, Enter
// runs it, and Esc closes the menu.

export type PromptInputHandle = {clear: () => void};

type Props = {
	ref?: Ref<PromptInputHandle>;
	placeholder: string;
	/** Color of the `›` marker; dimmed while the agent works. */
	accentColor: string;
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

const COMMAND_COLUMN = 12;

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

export function PromptInput({ref, placeholder, accentColor, canSubmit, isActive, maxLines, history, onSubmit, onChange}: Props) {
	// Kept in a ref so several keys arriving before a re-render (fast typing) all see fresh state.
	const state = useRef({value: '', cursor: 0});
	// Index into history while browsing it (0 = newest), and the draft it replaced.
	const browsing = useRef<{index: number; draft: string} | null>(null);
	const [, rerender] = useReducer((n: number) => n + 1, 0);
	// Highlighted command in the slash menu, and the input value the user closed the menu for.
	const menu = useRef({selected: 0, dismissedFor: null as string | null});

	const set = (value: string, cursor: number, keepBrowsing = false) => {
		const changed = value !== state.current.value;
		state.current = {value, cursor: Math.max(0, Math.min(cursor, value.length))};
		if (!keepBrowsing) browsing.current = null;
		if (changed) {
			menu.current.selected = 0;
			onChange?.(value);
		}
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

	/** Commands to show in the menu; empty when it is closed. Never shown while browsing history. */
	const menuMatches = (value: string) =>
		browsing.current || menu.current.dismissedFor === value ? [] : matchCommands(value);

	useInput(
		(input, key) => {
			const {value, cursor} = state.current;
			const lines = value.split('\n');
			const pos = position(value, cursor);

			const matches = menuMatches(value);
			if (matches.length > 0) {
				const index = Math.min(menu.current.selected, matches.length - 1);
				const command = matches[index]!.name;
				if (key.upArrow || key.downArrow) {
					const step = key.upArrow ? -1 : 1;
					menu.current.selected = (index + step + matches.length) % matches.length;
					return rerender();
				}
				if (key.tab && !key.shift) return set(command, command.length);
				if (key.rightArrow && cursor === value.length && command !== value) return set(command, command.length);
				if (key.escape) {
					menu.current.dismissedFor = value;
					return rerender();
				}
				if (key.return && !key.shift && !key.meta) {
					if (!canSubmit) return;
					set('', 0);
					onSubmit(command);
					return;
				}
			}

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
	const matches = menuMatches(value);
	const selected = Math.min(menu.current.selected, Math.max(0, matches.length - 1));
	const highlighted = matches[selected]?.name;
	const menuOpen = isActive && matches.length > 0;

	return (
		<Box flexDirection="column" display={isActive ? 'flex' : 'none'}>
			{/* The command menu sits above the input box, like a popup opening upwards. */}
			{menuOpen && (
				<Box flexDirection="column" marginTop={1} paddingX={1}>
					{matches.map((command, i) => {
						const isSelected = i === selected;
						return (
							<Box key={command.name}>
								<Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
									{isSelected ? '❯ ' : '  '}
									{command.name.padEnd(COMMAND_COLUMN)}
								</Text>
								<Text dimColor={!isSelected}>{command.description}</Text>
							</Box>
						);
					})}
					<Text dimColor>{'  ↑/↓ select · Tab complete · Enter run · Esc close'}</Text>
				</Box>
			)}
			<Box flexDirection="column" backgroundColor="gray" paddingX={1} paddingY={1} marginTop={menuOpen ? 0 : 1}>
				{first > 0 && <Text dimColor>{`  ↑ ${first} more line${first === 1 ? '' : 's'}`}</Text>}
				{shown.map((line, i) => {
					const row = first + i;
					const prefix = row === 0 ? <Text color={accentColor}>{'› '}</Text> : <Text>{'  '}</Text>;
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
					// Dim rest of the highlighted command after the cursor; Tab fills it in.
					const ghost = highlighted?.startsWith(value) && cursor === value.length ? highlighted.slice(value.length) : '';
					return (
						<Box key={row}>
							{prefix}
							<Box flexShrink={1}>
								<Text>
									{hasCursor ? line.slice(0, pos.col) : line}
									{hasCursor && <Text inverse>{line[pos.col] ?? ghost[0] ?? ' '}</Text>}
									{hasCursor && line.slice(pos.col + 1)}
									{hasCursor && ghost && <Text dimColor>{ghost.slice(1)}</Text>}
								</Text>
							</Box>
						</Box>
					);
				})}
				{hiddenBelow > 0 && <Text dimColor>{`  ↓ ${hiddenBelow} more line${hiddenBelow === 1 ? '' : 's'}`}</Text>}
			</Box>
		</Box>
	);
}
