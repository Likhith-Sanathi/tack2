// Slash commands offered in the prompt's command menu. The app handles them in `submit`.

export type SlashCommand = {
	name: string;
	description: string;
	/** Other names that run the same command, e.g. `/q` for `/exit`. */
	aliases?: string[];
};

export const COMMANDS: SlashCommand[] = [
	{name: '/model', description: 'Switch model, thinking level and provider'},
	{name: '/sandbox', description: 'Turn the command sandbox on or off'},
	{name: '/web', description: 'Turn web search and page fetching on or off'},
	{name: '/compact', description: 'Summarize the conversation to free up context'},
	{name: '/clear', description: 'Start a new conversation'},
	{name: '/help', description: 'Show commands and keys'},
	{name: '/exit', description: 'Quit tack', aliases: ['/quit', '/q']},
];

/** Maps a command or one of its aliases to the command's main name, or returns null. */
export function resolveCommand(input: string): string | null {
	const word = input.toLowerCase();
	return COMMANDS.find(c => c.name === word || c.aliases?.includes(word))?.name ?? null;
}

/**
 * Commands matching what has been typed, while the input is a lone `/word` (no spaces or new
 * lines). Prefix matches come first, then other commands containing the text. When the text
 * matches an alias rather than the main name (`/q`), the entry shows that alias.
 */
export function matchCommands(value: string): SlashCommand[] {
	if (!/^\/\S*$/.test(value)) return [];
	const query = value.slice(1).toLowerCase();
	const prefix: SlashCommand[] = [];
	const contains: SlashCommand[] = [];
	for (const command of COMMANDS) {
		const names = [command.name, ...(command.aliases ?? [])].map(n => n.slice(1));
		// An exact name wins, then the first name the text starts.
		const starts = names.find(n => n === query) ?? names.find(n => n.startsWith(query));
		if (starts !== undefined) prefix.push({...command, name: `/${starts}`});
		else if (names.some(n => n.includes(query))) contains.push(command);
	}
	return [...prefix, ...contains];
}
