# tack

A small coding agent for your terminal. Chat with any [OpenRouter](https://openrouter.ai) model; it can read, search, edit and create files and run shell commands in the current directory, asking for your approval before anything destructive.

Built with TypeScript, [Ink](https://github.com/vadimdemedes/ink) and [@inkjs/ui](https://github.com/vadimdemedes/ink-ui).

## Setup

Requires Node.js 22 or newer and an OpenRouter API key (<https://openrouter.ai/keys>).

```sh
export OPENROUTER_API_KEY=sk-or-...
npm install && npm start      # install, build and run in this checkout
```

`npm install` also compiles the project (via the `prepare` script). To use it in other projects, install the `tack` command globally and run it from any directory:

```sh
npm install -g .              # from this checkout
cd ~/some/project && tack
```

The agent works in the directory you start it from. File tools refuse paths outside that directory; shell commands run there too.

## Usage

On first launch you pick a model, in two steps:

1. **Model.** The list shows OpenRouter models that support tool calling, with prices and context size. Type to filter, `↑`/`↓` to move. `←`/`→` set the **thinking level** for the highlighted model, using the levels OpenRouter lists for it (e.g. off · low · medium · high · extra high · max, or just off/on). Models that don't let you change it say so. Until you change it, the model's own default is used. If nothing matches the filter, `Enter` uses what you typed as a model id.
2. **Provider.** `Enter` lists the providers serving that model, with price, context size, quantization and recent uptime. Type to filter them by name, slug or quantization (e.g. `fp8`). **Auto**, the first option, lets OpenRouter choose and fall back to another provider if one fails. Picking a provider pins every request to it with no fallback, so if it's down you'll see the error. `Esc` goes back to the model list.

Your choices are saved in `~/.config/tack/config.json` (or `$XDG_CONFIG_HOME/tack/`): the current model, plus the thinking level and provider for each model you've used, which the picker remembers next time. The status bar shows them, e.g. `deepseek/deepseek-v4 (high, via DeepInfra)`.

| Input | Action |
| --- | --- |
| `/` | Open the command menu: type to filter, `↑`/`↓` to pick, `Tab` (or `→`) to fill in, `Enter` to run, `Esc` to close |
| `/model` | Switch model, thinking level and provider (saved) |
| `/web` | Turn web search and page fetching on or off (saved) |
| `/compact` | Summarize the conversation so far to free up context |
| `/clear` | Start a new conversation |
| `/help` | Show commands and keys |
| `/exit`, `/quit`, `/q` | Quit |
| `Enter` | Send |
| `Shift+Enter`, `Option/Alt+Enter`, `Ctrl+J`, or `\` then `Enter` | New line (Shift+Enter needs a terminal with the kitty keyboard protocol, e.g. kitty, Ghostty, WezTerm, iTerm2) |
| `↑` / `↓` | Move between lines; at the first/last line, browse previous prompts |
| `Shift+Tab` | Cycle permission modes: ask → auto-accept edits → plan → auto |
| `Esc` | Interrupt the running generation or tool call |
| `Ctrl+C` | Interrupt when busy; otherwise clear the input, or quit if it's empty |

You can keep typing while the agent works; Enter sends once it's done. Pasted text keeps its line breaks. Prompt history is saved in `history.json` next to the config.

**Permission modes.** Reading, listing and searching never need approval, and neither do read-only commands such as `ls`, `cat`, `grep`, `git status`, `git diff` or `git log`, as long as they stay inside the working directory: no absolute paths, `~` or `..`, and no redirects, pipes, quotes or variables. For everything else, the mode shown in the status bar decides; press `Shift+Tab` to cycle through them:

| Mode | File edits (`write_file`, `edit_file`) | Commands (`bash`) |
| --- | --- | --- |
| **ask** (default) | ask | ask |
| **auto-accept edits** | run without asking (edits are limited to the working directory) | ask |
| **plan** | refused | refused (read-only commands still run) |
| **auto** | run without asking | run without asking |

**auto** never asks. Every command runs as soon as the model requests it, including ones that delete files or reach the network, so use it only in a project you can restore (for example, one committed to git). File tools still refuse paths outside the working directory, but shell commands can reach anything your user account can. It comes last in the cycle, so getting to plan mode never passes through it, and one more `Shift+Tab` returns to ask. The status bar shows it in red.

In plan mode the agent is told it can only read and propose a plan. Refused calls return a message to the model, so it carries on with a plan instead of stopping. Switch modes when you want it to proceed.

**Approvals.** File changes show a diff with line numbers (new files show all their lines); commands show the command. Choose **Yes** to allow that one call, or **No**, which stops the turn so you can tell the agent what to do instead. The middle option, "don't ask again", depends on the call:

- **File edits:** switches to auto-accept edits for the rest of the session.
- **Commands:** allows commands with the same prefix for the rest of the session, shown in the option, e.g. `` `npm test` `` also covers `npm test -- --watch=false`. Plain programs are scoped by name (`ls`, `cat`, `grep`); programs with subcommands include the subcommand (`git status`, `cargo build`, `npm run build`). Programs that can run arbitrary code or change files from their arguments (`python`, `node`, `npx`, `sh`, `sudo`, `rm`, `mv`, `sed`, `find`, `curl`…) are approved for that exact command only.
- **Not offered** for commands that chain, pipe, substitute or redirect (`&&`, `;`, `|`, `$(…)`, `>`…) or set environment variables, since their prefix says nothing about what they do. These are approved one at a time.

Session approvals are cleared by `/clear`; the mode is kept.

**While it works.** Models that expose their reasoning show it live under "Thinking…", collapsed to "Thought for Ns" once they answer. Commands show their latest output lines as they run. After a file change, the chat shows its diff.

**Status bar.** Shows the agent state (ready, thinking, running a tool or waiting for approval), the current model, total input/output tokens, the session cost and how much of the context window the last request used. Cost comes from OpenRouter's usage report. If that's missing, it's estimated from the model's listed prices.

**Web.** The model can search the web and read pages through OpenRouter's built-in server tools, `openrouter:web_search` and `openrouter:web_fetch`, both using Exa. The model decides when to use them and OpenRouter runs them during the request, so they need no approval and work in every permission mode. Each search costs about $0.007 (Exa, up to 10 results) and each page fetch about $0.001, included in the cost shown in the status bar. Searches appear in the chat above the reply, and the pages the model cited are listed under it. Web access is on by default; `/web` turns it off and on, and the status bar shows `· web` while it's on.

**Long conversations.** When a request would use more than 75% of the model's context window, tack asks the model to summarize the earlier conversation (goals, decisions, files touched, commands run, what's left to do) and continues from that summary. Your latest message and the work since then are kept word for word when they fit. If the model's context size is unknown and the API rejects a request as too long, tack compacts and retries once. The chat on screen keeps the full history; only what is sent to the model shrinks.

**Errors.** API errors, network failures and tool errors appear in the chat; the app keeps running. Rate limits (HTTP 429) and 5xx responses are retried up to 2 times with backoff before an error is shown.

## Tools

| Tool | Kind | Description |
| --- | --- | --- |
| `read_file` | read | Read a file with line numbers (supports offset/limit) |
| `glob` | read | Find files by name pattern (`**/*.test.ts`), most recently modified first |
| `search` | read | Regex search across files using a bundled ripgrep, with optional glob filter, context lines (`context`) or just the matching files (`files_only`) |
| `list_dir` | read | List a directory, optionally recursive |
| `write_file` | edit | Create or overwrite a file |
| `edit_file` | edit | Replace an exact, unique string in a file |
| `multi_edit` | edit | Several replacements in one file, applied in order; all succeed or nothing is written |
| `bash` | execute | Run a shell command (timeout 2 min by default; killed on interrupt). Stdin is closed and pagers and git credential prompts are disabled, so commands can't hang waiting for input |
| `bash_background` | execute | Start a long-running command (dev server, watcher) and return right away with an id and its first output |
| `bash_output` | read | Read what a background process printed since the last read, optionally waiting for new output; without an id, list them |
| `kill_process` | execute (no approval) | Stop a background process and anything it started |

`glob`, `search` and recursive `list_dir` skip what git ignores: `.gitignore` files at every level and `.git/info/exclude`, plus `.git`, `node_modules` and a few build directories even without a `.gitignore`. `search` runs ripgrep, which comes with tack via `@vscode/ripgrep` (npm installs the right binary for your platform), so it's fast in large repos and behaves the same on every machine. It uses ripgrep's `--engine auto`, so lookarounds and backreferences work too. If the binary is missing or ripgrep rejects a pattern, `search` falls back to a built-in JavaScript search that produces the same output (set `TACK_NO_RIPGREP=1` to force it). Background processes are stopped when tack exits. `kill_process` needs no approval because it can only stop processes the agent started.

### Adding a tool

Create a file in `src/tools/` and use `defineTool`. The zod schema is used both to validate the model's arguments and, converted to JSON Schema, to describe the tool to the model. `args` is typed from it:

```ts
// src/tools/fetch-url.ts
import {z} from 'zod';
import {defineTool} from './types.js';

export const fetchUrl = defineTool({
	name: 'fetch_url',
	description: 'Fetch a URL and return the response body as text.',
	schema: z.object({
		url: z.string().url().describe('The URL to fetch'),
	}),
	kind: 'read',                         // 'read' never asks; 'edit' follows the edit rules above;
	                                      // 'execute' asks unless approved for the session
	// approvalScope: args => ...,        // optional: what "don't ask again" covers (null = once only)
	// isReadOnly: args => ...,           // optional: true for calls that only read (run without asking)
	describe: args => args.url,           // one-line summary shown in the chat
	// preview: args => ({type: 'text', text: '...'}), // optional details for the approval prompt;
	//                                    // file tools return a diff from diffFile() in ./diff.js
	async run({url}, {signal, onOutput}) { // onOutput(chunk) streams progress to the UI
		const res = await fetch(url, {signal}); // honor `signal` so Esc can interrupt
		return (await res.text()).slice(0, 20_000);
	},
});
```

Then register it in `src/tools/index.ts`:

```ts
export const tools: AnyTool[] = [readFile, writeFile, editFile, listDir, search, bash, fetchUrl];
```

Return a string for the model, or throw an `Error`. Thrown errors are shown in red and sent back to the model as the tool result.

## Project layout

```
src/
  cli.tsx              entry point: reads the API key and config, renders the app
  config.ts            persisted settings (selected model)
  agent/
    openrouter.ts      streaming chat-completions client, model list
    permissions.ts     permission modes and approval rules (allow / ask / refuse)
    agent.ts           agent loop, tool execution, approvals, interrupts (no UI code)
  tools/               tool definitions and registry
  ui/
    use-agent.ts       hook that turns agent events into React state
    app.tsx            layout, input, commands, key handling
    chat-item.tsx, approval-prompt.tsx, model-picker.tsx, status-bar.tsx
```

The `Agent` class reports progress through an `onEvent` callback and asks for approval through a `requestApproval` callback. It doesn't import React or Ink, so you could use it from a different UI or from tests.

## Development

```sh
npm run dev        # run from source with tsx
npm run typecheck
npm test           # permission rules, and the agent loop against a fake API server
npm run build
```

`OPENROUTER_BASE_URL` overrides the API endpoint (default `https://openrouter.ai/api/v1`), which is useful for pointing tack at a local mock server.
