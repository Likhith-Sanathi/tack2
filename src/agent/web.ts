// Web search and page fetching through OpenRouter's server tools. OpenRouter runs these itself
// during a request (the model decides when), so tack only declares them; there's nothing to execute.
// See https://openrouter.ai/docs/guides/features/server-tools/web-search

import type {ToolSpec} from './openrouter.js';

export const WEB_TOOLS: ToolSpec[] = [
	// Exa: about $0.007 per search with up to 10 results.
	{type: 'openrouter:web_search', parameters: {engine: 'exa', max_results: 5}},
	// Full page text, capped so one long page can't flood the context window.
	{type: 'openrouter:web_fetch', parameters: {engine: 'exa', max_content_tokens: 10_000}},
];

export const WEB_NOTE =
	'You can search the web (web_search) and read web pages (web_fetch). Use them for information that ' +
	'may be newer than your training or lives outside the project, such as documentation, error messages ' +
	'or release notes, and mention the URLs you relied on.';

/** True for tool calls OpenRouter runs itself (they may be echoed in the stream). */
export function isServerToolCall(type: string | undefined, name: string): boolean {
	return Boolean(type?.startsWith('openrouter:') || name.startsWith('openrouter:'));
}
