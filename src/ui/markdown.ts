import chalk from 'chalk';
import {lexer, type Token, type Tokens} from 'marked';
import {stripVTControlCharacters} from 'node:util';

// Renders Markdown to an ANSI-styled string for the terminal. Covers what models typically emit:
// headings, emphasis, inline code, fenced code, lists, quotes, links, rules and tables.

function inline(tokens: Token[] | undefined): string {
	return (tokens ?? []).map(inlineToken).join('');
}

function inlineToken(token: Token): string {
	switch (token.type) {
		case 'strong':
			return chalk.bold(inline((token as Tokens.Strong).tokens));
		case 'em':
			return chalk.italic(inline((token as Tokens.Em).tokens));
		case 'del':
			return chalk.strikethrough(inline((token as Tokens.Del).tokens));
		case 'codespan':
			return chalk.cyan((token as Tokens.Codespan).text);
		case 'link': {
			const link = token as Tokens.Link;
			const text = inline(link.tokens);
			const plain = stripVTControlCharacters(text);
			return plain === link.href ? chalk.blue.underline(text) : `${chalk.blue.underline(text)} ${chalk.dim(`(${link.href})`)}`;
		}
		case 'image':
			return chalk.dim(`[image: ${(token as Tokens.Image).text || (token as Tokens.Image).href}]`);
		case 'br':
			return '\n';
		case 'text': {
			const text = token as Tokens.Text;
			return text.tokens ? inline(text.tokens) : text.text;
		}
		default:
			// escape, html and anything unknown: show the source text as-is.
			return 'text' in token && typeof token.text === 'string' ? token.text : token.raw;
	}
}

function indent(text: string, first: string, rest: string): string {
	return text
		.split('\n')
		.map((line, i) => (i === 0 ? first : rest) + line)
		.join('\n');
}

function list(token: Tokens.List): string {
	const start = typeof token.start === 'number' ? token.start : 1;
	return token.items
		.map((item, i) => {
			const bullet = token.ordered ? `${start + i}.` : '•';
			// Newer marked versions emit the task checkbox as its own token; render it ourselves.
			const check = item.task ? (item.checked ? chalk.green('✔ ') : chalk.dim('☐ ')) : '';
			const body = blocks(item.tokens.filter(t => t.type !== 'checkbox'), true);
			return indent(check + body, chalk.dim(bullet) + ' ', ' '.repeat(bullet.length + 1));
		})
		.join('\n');
}

function table(token: Tokens.Table): string {
	const rows = [token.header, ...token.rows].map(row => row.map(cell => inline(cell.tokens)));
	const widths = token.header.map((_, col) =>
		Math.max(...rows.map(row => stripVTControlCharacters(row[col] ?? '').length)),
	);
	const line = (row: string[]) =>
		row
			.map((cell, col) => {
				const pad = (widths[col] ?? 0) - stripVTControlCharacters(cell).length;
				return token.align[col] === 'right' ? ' '.repeat(pad) + cell : cell + ' '.repeat(pad);
			})
			.join(chalk.dim(' │ '));
	const [header, ...body] = rows;
	const separator = chalk.dim(widths.map(w => '─'.repeat(w)).join('─┼─'));
	return [chalk.bold(line(header ?? [])), separator, ...body.map(line)].join('\n');
}

function block(token: Token, tight: boolean): string | null {
	switch (token.type) {
		case 'space':
			return null;
		case 'heading': {
			const heading = token as Tokens.Heading;
			const text = inline(heading.tokens);
			return heading.depth <= 2 ? chalk.bold.underline(text) : chalk.bold(text);
		}
		case 'paragraph':
			return inline((token as Tokens.Paragraph).tokens);
		case 'text': {
			// Block-level text appears inside tight list items.
			const text = token as Tokens.Text;
			return text.tokens ? inline(text.tokens) : text.text;
		}
		case 'code': {
			const code = token as Tokens.Code;
			const label = code.lang ? chalk.dim(code.lang) + '\n' : '';
			return label + indent(code.text, chalk.dim('│ '), chalk.dim('│ '));
		}
		case 'blockquote':
			return indent(chalk.italic(blocks((token as Tokens.Blockquote).tokens, tight)), chalk.dim('▎ '), chalk.dim('▎ '));
		case 'list':
			return list(token as Tokens.List);
		case 'table':
			return table(token as Tokens.Table);
		case 'hr':
			return chalk.dim('─'.repeat(20));
		default:
			return token.raw.trimEnd();
	}
}

function blocks(tokens: Token[], tight = false): string {
	return tokens
		.map(token => block(token, tight))
		.filter((text): text is string => text !== null)
		.join(tight ? '\n' : '\n\n');
}

export function renderMarkdown(source: string): string {
	try {
		return blocks(lexer(source));
	} catch {
		return source; // never let a rendering problem hide the reply
	}
}
