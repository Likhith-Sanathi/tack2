import {structuredPatch} from 'diff';

export type DiffLine = {kind: 'add' | 'del' | 'ctx'; lineNo: number; text: string};

/** A file change, shown to the user before approval and in the chat afterwards. */
export type FileDiff = {
	type: 'diff';
	path: string;
	/** The file did not exist before. */
	isNew: boolean;
	added: number;
	removed: number;
	/** Groups of changed lines with surrounding context; gaps between groups are elided. */
	hunks: DiffLine[][];
};

export function diffFile(path: string, before: string | null, after: string): FileDiff {
	const patch = structuredPatch(path, path, before ?? '', after, '', '', {context: 3});
	let added = 0;
	let removed = 0;
	const hunks = patch.hunks.map(hunk => {
		let oldNo = hunk.oldStart;
		let newNo = hunk.newStart;
		const lines: DiffLine[] = [];
		for (const line of hunk.lines) {
			const text = line.slice(1);
			if (line.startsWith('\\')) continue; // "\ No newline at end of file"
			if (line.startsWith('+')) {
				lines.push({kind: 'add', lineNo: newNo++, text});
				added++;
			} else if (line.startsWith('-')) {
				lines.push({kind: 'del', lineNo: oldNo++, text});
				removed++;
			} else {
				lines.push({kind: 'ctx', lineNo: newNo++, text});
				oldNo++;
			}
		}
		return lines;
	});
	return {type: 'diff', path, isNew: before === null, added, removed, hunks};
}
