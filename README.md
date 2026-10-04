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

On first launch you pick a model. The list shows OpenRouter models that support tool calling, with prices and context size. Type to filter, then use ↑/↓ and Enter. If nothing matches, Enter uses what you typed as a model id. Your choice is saved in `~/.config/tack/config.json` (or `$XDG_CONFIG_HOME/tack/`) and reused next time.

| Input | Action |
| --- | --- |
| `/model` | Switch model (persists) |
| `/compact` | Summarize the conversation so far to free up context |
| `/clear` | Start a new conversation |
| `/help` | Show commands and keys |
| `/exit` | Quit |
| `Esc` | Interrupt the running generation or tool call |
| `Ctrl+C` | Interrupt when busy, quit when idle |

**Approvals.** `write_file`, `edit_file` and `bash` ask first and show a preview: the file content, the diff, or the command. Choose **Yes** to allow that one call, **Yes, and don't ask again** to allow that tool for the rest of the session, or **No**, which stops the turn so you can tell the agent what to do instead.

**Status bar.** Shows the agent state (ready, thinking, running a tool or waiting for approval), the current model, total input/output tokens, the session cost and how much of the context window the last request used. Cost comes from OpenRouter's usage report. If that's missing, it's estimated from the model's listed prices.

**Long conversations.** When a request would use more than 75% of the model's context window, tack asks the model to summarize the earlier conversation (goals, decisions, files touched, commands run, what's left to do) and continues from that summary. Your latest message and the work since then are kept word for word when they fit. If the model's context size is unknown and the API rejects a request as too long, tack compacts and retries once. The chat on screen keeps the full history; only what is sent to the model shrinks.

**Errors.** API errors, network failures and tool errors appear in the chat; the app keeps running. Rate limits (HTTP 429) and 5xx responses are retried up to 2 times with backoff before an error is shown.

## Tools

| Tool | Approval | Description |
| --- | --- | --- |
| `read_file` | no | Read a file with line numbers (supports offset/limit) |
| `list_dir` | no | List a directory, optionally recursive |
| `search` | no | Regex search across files, optional glob filter |
| `write_file` | yes | Create or overwrite a file |
| `edit_file` | yes | Replace an exact, unique string in a file |
| `bash` | yes | Run a shell command (timeout 2 min by default; killed on interrupt) |

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
	requiresApproval: false,              // true → user is asked before each call
	describe: args => args.url,           // one-line summary shown in the chat
	// preview: args => '...',            // optional details for the approval prompt
	async run({url}, {cwd, signal}) {
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
npm run build
```

`OPENROUTER_BASE_URL` overrides the API endpoint (default `https://openrouter.ai/api/v1`), which is useful for pointing tack at a local mock server.
