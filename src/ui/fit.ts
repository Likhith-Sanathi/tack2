// Ink can only redraw the live (non-<Static>) part of the screen while it is shorter than the
// terminal; taller frames leave a copy in scrollback on every re-render. These helpers keep
// live content within a row budget.

import {stripVTControlCharacters} from 'node:util';

/** Rows `line` occupies when wrapped at `width` columns (approximate: assumes 1 column per char). */
function wrappedRows(line: string, width: number): number {
	return Math.max(1, Math.ceil(stripVTControlCharacters(line).length / Math.max(1, width)));
}

/** Returns the tail of `text` that fits in `maxRows` rows at `width` columns. */
export function tailToFit(text: string, width: number, maxRows: number): {text: string; hidden: boolean} {
	const lines = text.split('\n');
	let rows = 0;
	let start = lines.length;
	while (start > 0) {
		const next = wrappedRows(lines[start - 1]!, width);
		if (rows + next > maxRows) break;
		rows += next;
		start--;
	}
	if (start === 0) return {text, hidden: false};
	// A single line too long for the budget: keep its end.
	// Styling is dropped here so the cut can't land inside an escape sequence.
	if (start === lines.length) {
		return {text: stripVTControlCharacters(text).slice(-Math.max(0, maxRows * width)), hidden: true};
	}
	return {text: lines.slice(start).join('\n'), hidden: true};
}
