// Slash commands offered in the prompt's command menu. The app handles them in `submit`.

export type SlashCommand = {name: string; description: string};

export const COMMANDS: SlashCommand[] = [
	{name: '/model', description: 'Switch model (saved for next time)'},
	{name: '/compact', description: 'Summarize the conversation to free up context'},
	{name: '/clear', description: 'Start a new conversation'},
	{name: '/help', description: 'Show commands and keys'},
	{name: '/exit', description: 'Quit tack'},
];

/**
 * Commands matching what has been typed, while the input is a lone `/word` (no spaces or new
 * lines). Prefix matches come first, then other commands containing the text.
 */
export function matchCommands(value: string): SlashCommand[] {
	if (!/^\/\S*$/.test(value)) return [];
	const query = value.slice(1).toLowerCase();
	const prefix = COMMANDS.filter(c => c.name.slice(1).startsWith(query));
	const contains = COMMANDS.filter(c => !prefix.includes(c) && c.name.slice(1).includes(query));
	return [...prefix, ...contains];
}
