import type {AnyTool} from './types.js';
import {readFile} from './read-file.js';
import {writeFile} from './write-file.js';
import {editFile} from './edit-file.js';
import {listDir} from './list-dir.js';
import {search} from './search.js';
import {bash} from './bash.js';
import {glob} from './glob.js';
import {multiEdit} from './multi-edit.js';
import {bashBackground, bashOutput, killProcess} from './background.js';

/** Every tool the agent can use. To add a tool, define it with `defineTool` and append it here. */
export const tools: AnyTool[] = [
	readFile,
	writeFile,
	editFile,
	multiEdit,
	glob,
	search,
	listDir,
	bash,
	bashBackground,
	bashOutput,
	killProcess,
];

export type {AnyTool, Tool, ToolContext, ToolPreview} from './types.js';
export type {DiffLine, FileDiff} from './diff.js';
export {defineTool} from './types.js';
