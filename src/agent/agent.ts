import {z} from 'zod';
import type {AnyTool, ToolPreview} from '../tools/index.js';
import {reasoningParam} from './thinking.js';
import {Permissions, type AlwaysOption, type PermissionMode, type ToolKind} from './permissions.js';
import {ApiError, streamChat, type ChatMessage, type StreamResult, type ToolCall, type ToolSpec, type Usage} from './openrouter.js';

/** `blocked`: refused by the permission mode (the turn continues); `denied`: the user said no (it stops). */
export type ToolStatus = 'ok' | 'error' | 'denied' | 'blocked' | 'interrupted';

export type AgentEvent =
	| {type: 'text'; delta: string}
	| {type: 'reasoning'; delta: string}
	| {type: 'assistant_done'}
	| {type: 'tool_start'; id: string; name: string; summary: string; preview?: ToolPreview}
	| {type: 'tool_output'; id: string; chunk: string}
	| {type: 'tool_end'; id: string; status: ToolStatus; result: string}
	| {type: 'usage'; usage: Usage}
	| {type: 'mode'; mode: PermissionMode}
	/** Older messages were replaced by a summary; token counts are estimates. */
	| {type: 'compacted'; before: number; after: number}
	| {type: 'notice'; message: string}
	| {type: 'error'; message: string};

export type ApprovalRequest = {
	toolName: string;
	kind: ToolKind;
	summary: string;
	preview?: ToolPreview;
	/** What "don't ask again" would allow; absent when the call can only be approved once. */
	always?: AlwaysOption;
};
export type ApprovalDecision = 'once' | 'always' | 'deny';

export type AgentOptions = {
	apiKey: string;
	model: string;
	cwd: string;
	tools: AnyTool[];
	onEvent: (event: AgentEvent) => void;
	/** Asks the user whether a tool may run. Must resolve; an interrupt is handled by the agent. */
	requestApproval: (request: ApprovalRequest) => Promise<ApprovalDecision>;
};

const MAX_RETRIES = 3;
/** Compact when the next request is estimated to use this share of the context window. */
const COMPACT_THRESHOLD = 0.75;
/** Rough token estimate; good enough for deciding when to compact. */
const CHARS_PER_TOKEN = 4;
/** Context size assumed when the model's is unknown (only used to cap the summary request). */
const FALLBACK_CONTEXT = 32_000;

const PLAN_MODE_NOTE =
	'PLAN MODE IS ON: you may only read and search. Do not edit files or run commands other than ' +
	'read-only ones (ls, cat, grep, git status/diff/log); ' +
	'investigate, then present a concrete plan and wait for the user to approve it.';

function systemPrompt(cwd: string): string {
	return [
		'You are tack, a coding agent running in the user\'s terminal.',
		`Working directory: ${cwd}`,
		`Platform: ${process.platform}. Date: ${new Date().toISOString().slice(0, 10)}.`,
		'Use the tools to inspect and change files and to run commands. Paths are relative to the working directory.',
		'Read files before editing them, prefer edit_file for small changes, and verify your work when practical.',
		'Be concise. When finished, briefly summarize what you did.',
	].join('\n');
}

class Interrupted extends Error {}

function isContextOverflow(error: unknown): boolean {
	return (
		error instanceof ApiError &&
		(error.status === 400 || error.status === 413) &&
		/context|too long|too many tokens|token limit|maximum.*tokens/i.test(error.message)
	);
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)} … [${text.length - max} more characters]`;
}

/** Renders messages as plain text for the summarizer, shortening tool arguments and results. */
function transcript(messages: ChatMessage[]): string {
	return messages
		.map(m => {
			switch (m.role) {
				case 'system':
					return '';
				case 'user':
					return `USER: ${m.content}`;
				case 'assistant':
					return [
						m.content ? `ASSISTANT: ${m.content}` : '',
						...(m.tool_calls ?? []).map(c => `ASSISTANT called ${c.function.name}(${clip(c.function.arguments, 500)})`),
					]
						.filter(Boolean)
						.join('\n');
				case 'tool':
					return `TOOL RESULT: ${clip(m.content, 1500)}`;
			}
		})
		.filter(Boolean)
		.join('\n\n');
}

const SUMMARY_PROMPT = [
	'Below is a conversation between a user and a coding agent working in their project. It is being',
	'shortened to fit the context window. Write a summary the agent can continue from. Include:',
	'- what the user asked for and any preferences or constraints they stated',
	'- decisions made and why',
	'- files read, created or changed, with the important details (paths, functions, values)',
	'- commands run and their outcomes, including errors still unresolved',
	'- the current state and what remains to be done, including any task in progress',
	'Be specific and concise. Output only the summary.',
].join('\n');

/**
 * Runs the conversation loop: model -> tool calls -> tool results -> model, until the model
 * replies without tool calls. Knows nothing about the UI; it reports progress through `onEvent`.
 */
export class Agent {
	model: string;
	/** The current model's context window in tokens, if known. Enables automatic compaction. */
	contextLength: number | undefined;
	/** Thinking level for the model (see thinking.ts); undefined uses the model's default. */
	thinking: string | undefined;
	/** Provider slug to route to; undefined lets OpenRouter choose. */
	provider: string | undefined;
	private messages: ChatMessage[];
	private summary = '';
	/** Prompt tokens reported for the last request, and how many messages it contained. */
	private lastPrompt = {tokens: 0, messageCount: 0};
	private readonly permissions = new Permissions();
	private controller: AbortController | null = null;

	constructor(private readonly options: AgentOptions) {
		this.model = options.model;
		this.messages = [this.systemMessage()];
	}

	private systemMessage(): ChatMessage {
		const base = systemPrompt(this.options.cwd);
		const content = this.summary
			? `${base}\n\nEarlier parts of this conversation were summarized to save space:\n\n${this.summary}`
			: base;
		return {role: 'system', content};
	}

	get mode(): PermissionMode {
		return this.permissions.mode;
	}

	/** Changes the permission mode; applies from the next tool call. */
	setMode(mode: PermissionMode): void {
		if (mode === this.permissions.mode) return;
		this.permissions.mode = mode;
		this.emit({type: 'mode', mode});
	}

	get running(): boolean {
		return this.controller !== null;
	}

	/** Stops the current generation or tool call. The conversation stays usable. */
	interrupt(): void {
		this.controller?.abort();
	}

	/** Clears conversation history and session approvals. The permission mode is kept. */
	reset(): void {
		this.interrupt();
		this.summary = '';
		this.messages = [this.systemMessage()];
		this.lastPrompt = {tokens: 0, messageCount: 0};
		this.permissions.clearGrants();
	}

	/** Sends a user message and runs the agent loop until the turn ends. Never throws. */
	send(text: string): Promise<void> {
		return this.run(signal => {
			this.messages.push({role: 'user', content: text});
			return this.loop(signal);
		});
	}

	/** Summarizes the conversation so far to free up context. Never throws. */
	compactNow(): Promise<void> {
		return this.run(async signal => {
			if (this.messages.length <= 1) {
				this.emit({type: 'notice', message: 'Nothing to compact yet.'});
				return;
			}
			await this.compact(signal, false);
		});
	}

	private async run(task: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.controller) throw new Error('Agent is already running');
		const controller = new AbortController();
		this.controller = controller;
		try {
			await task(controller.signal);
		} catch (error) {
			if (controller.signal.aborted || error instanceof Interrupted) {
				this.emit({type: 'notice', message: 'Interrupted.'});
			} else {
				this.emit({type: 'error', message: error instanceof Error ? error.message : String(error)});
			}
		} finally {
			this.controller = null;
		}
	}

	private emit(event: AgentEvent): void {
		this.options.onEvent(event);
	}

	private async loop(signal: AbortSignal): Promise<void> {
		const tools: ToolSpec[] = this.options.tools.map(tool => {
			// Some providers reject the $schema key, so drop it.
			const {$schema: _, ...parameters} = z.toJSONSchema(tool.schema);
			return {type: 'function', function: {name: tool.name, description: tool.description, parameters}};
		});

		while (true) {
			const window = this.contextLength;
			if (window && this.estimateTokens() > window * COMPACT_THRESHOLD) {
				await this.compact(signal, true);
			}
			let result: StreamResult;
			try {
				result = await this.callModel(tools, signal);
			} catch (error) {
				// The context limit may be unknown or the estimate too low; compact once and retry.
				if (!isContextOverflow(error)) throw error;
				this.emit({type: 'notice', message: 'The conversation is too long for this model.'});
				await this.compact(signal, true);
				result = await this.callModel(tools, signal);
			}
			this.messages.push({
				role: 'assistant',
				content: result.content || null,
				...(result.toolCalls.length > 0 ? {tool_calls: result.toolCalls} : {}),
			});
			this.emit({type: 'assistant_done'});
			if (result.finishReason === 'length') {
				this.emit({type: 'notice', message: 'Response was cut off by the model\'s output limit.'});
			}
			if (result.toolCalls.length === 0) return;

			// Every tool call must get a result message, even if we stop early.
			let stop = false;
			for (const call of result.toolCalls) {
				if (stop || signal.aborted) {
					this.messages.push({role: 'tool', tool_call_id: call.id, content: 'Skipped: the user interrupted.'});
					continue;
				}
				const status = await this.runTool(call, signal);
				if (status === 'denied' || status === 'interrupted') stop = true;
			}
			if (signal.aborted) throw new Interrupted();
			if (stop) return; // the user declined an action; hand control back to them
		}
	}

	/** Streams one model response, retrying rate limits and server errors that happen before any output. */
	private async callModel(tools: ToolSpec[], signal: AbortSignal): Promise<StreamResult> {
		for (let attempt = 1; ; attempt++) {
			let partial = '';
			try {
				const result = await streamChat({
					apiKey: this.options.apiKey,
					model: this.model,
					reasoning: reasoningParam(this.thinking),
					provider: this.provider,
					messages: this.requestMessages(),
					tools,
					signal,
					onText: delta => {
						partial += delta;
						this.emit({type: 'text', delta});
					},
					onReasoning: delta => this.emit({type: 'reasoning', delta}),
				});
				if (result.usage) {
					this.lastPrompt = {tokens: result.usage.prompt_tokens, messageCount: this.messages.length};
					this.emit({type: 'usage', usage: result.usage});
				}
				return result;
			} catch (error) {
				if (signal.aborted) {
					// Keep whatever was streamed so the model knows what the user saw.
					if (partial) this.messages.push({role: 'assistant', content: `${partial}\n[interrupted by user]`});
					this.emit({type: 'assistant_done'});
					throw new Interrupted();
				}
				const retryable = error instanceof ApiError && error.retryable && partial === '';
				if (!retryable || attempt >= MAX_RETRIES) {
					if (partial) this.emit({type: 'assistant_done'});
					throw error;
				}
				const delay = 2 ** attempt * 1000;
				this.emit({type: 'notice', message: `${(error as Error).message} — retrying in ${delay / 1000}s (${attempt}/${MAX_RETRIES - 1})`});
				await sleep(delay, signal);
			}
		}
	}

	/** The conversation as sent to the model, with a reminder of the mode when it restricts tools. */
	private requestMessages(): ChatMessage[] {
		if (this.permissions.mode !== 'plan') return this.messages;
		const [system, ...rest] = this.messages;
		return [{role: 'system', content: `${system!.content}\n\n${PLAN_MODE_NOTE}`}, ...rest];
	}

	/** Tokens the next request will use: the last reported count plus an estimate for newer messages. */
	private estimateTokens(): number {
		const newer = this.messages.slice(this.lastPrompt.messageCount);
		const chars = newer.reduce((n, m) => n + JSON.stringify(m).length, 0);
		return this.lastPrompt.tokens + chars / CHARS_PER_TOKEN;
	}

	/**
	 * Replaces older messages with a model-written summary kept in the system prompt.
	 * With keepCurrentTurn, the latest user message and what followed stay verbatim if they are small.
	 */
	private async compact(signal: AbortSignal, keepCurrentTurn: boolean): Promise<void> {
		const window = this.contextLength ?? FALLBACK_CONTEXT;
		const history = this.messages.slice(1);

		// The kept tail must start at a user message so no tool result loses its tool call.
		let split = history.length;
		if (keepCurrentTurn) {
			const lastUser = history.findLastIndex(m => m.role === 'user');
			const tailChars = history.slice(lastUser).reduce((n, m) => n + JSON.stringify(m).length, 0);
			if (lastUser > 0 && tailChars / CHARS_PER_TOKEN < window * 0.25) split = lastUser;
		}
		const older = history.slice(0, split);
		const tail = history.slice(split);
		if (older.length === 0) return;

		this.emit({type: 'notice', message: 'Summarizing earlier conversation to free up context…'});
		let text = transcript(older);
		if (this.summary) text = `SUMMARY OF EVEN EARLIER CONVERSATION:\n${this.summary}\n\n${text}`;
		// Keep the request well inside the window; drop the oldest text if needed.
		const maxChars = window * 0.6 * CHARS_PER_TOKEN;
		if (text.length > maxChars) text = `[earliest part omitted]\n${text.slice(-maxChars)}`;

		const result = await streamChat({
			apiKey: this.options.apiKey,
			model: this.model,
			provider: this.provider,
			messages: [
				{role: 'system', content: SUMMARY_PROMPT},
				{role: 'user', content: text},
			],
			tools: [],
			signal,
			onText: () => {},
		}).catch((error: unknown) => {
			if (signal.aborted) throw new Interrupted();
			throw new Error(`Could not summarize the conversation: ${error instanceof Error ? error.message : String(error)}`);
		});
		if (result.usage) this.emit({type: 'usage', usage: result.usage});
		if (!result.content.trim()) throw new Error('Could not summarize the conversation: the model returned nothing.');

		const before = Math.round(this.estimateTokens());
		this.summary = result.content.trim();
		this.messages = [this.systemMessage(), ...tail];
		const after = Math.round(JSON.stringify(this.messages).length / CHARS_PER_TOKEN);
		this.lastPrompt = {tokens: after, messageCount: this.messages.length};
		this.emit({type: 'compacted', before, after});
	}

	private async runTool(call: ToolCall, signal: AbortSignal): Promise<ToolStatus> {
		const finish = (status: ToolStatus, result: string): ToolStatus => {
			this.messages.push({role: 'tool', tool_call_id: call.id, content: result});
			this.emit({type: 'tool_end', id: call.id, status, result});
			return status;
		};

		const name = call.function.name;
		const tool = this.options.tools.find(t => t.name === name);
		let rawArgs: unknown;
		try {
			rawArgs = JSON.parse(call.function.arguments || '{}');
		} catch {
			this.emit({type: 'tool_start', id: call.id, name, summary: call.function.arguments});
			return finish('error', 'Error: tool arguments were not valid JSON.');
		}
		if (!tool) {
			this.emit({type: 'tool_start', id: call.id, name, summary: ''});
			return finish('error', `Error: unknown tool "${name}".`);
		}
		const parsed = tool.schema.safeParse(rawArgs);
		if (!parsed.success) {
			this.emit({type: 'tool_start', id: call.id, name, summary: JSON.stringify(rawArgs)});
			return finish('error', `Error: invalid arguments.\n${z.prettifyError(parsed.error)}`);
		}
		const args = parsed.data;
		const summary = tool.describe(args);
		const ctx = {
			cwd: this.options.cwd,
			signal,
			onOutput: (chunk: string) => this.emit({type: 'tool_output', id: call.id, chunk}),
		};
		const permission = this.permissions.check(tool, args);
		if (permission.behavior === 'deny') {
			this.emit({type: 'tool_start', id: call.id, name, summary});
			return finish('blocked', permission.reason);
		}

		let preview: ToolPreview | undefined;
		try {
			preview = await tool.preview?.(args, ctx);
		} catch (error) {
			// The call would fail (e.g. old_string not found), so report it without asking the user.
			this.emit({type: 'tool_start', id: call.id, name, summary});
			return finish('error', `Error: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.emit({type: 'tool_start', id: call.id, name, summary, preview});

		if (permission.behavior === 'ask') {
			const decision = await Promise.race([
				this.options.requestApproval({toolName: name, kind: tool.kind, summary, preview, always: permission.always}),
				abortPromise(signal),
			]);
			if (decision === 'interrupted') return finish('interrupted', 'Interrupted by the user.');
			if (decision === 'deny') return finish('denied', 'The user denied this action. Ask them how to proceed.');
			if (decision === 'always' && permission.always) {
				const before = this.permissions.mode;
				this.permissions.grant(permission.always);
				if (this.permissions.mode !== before) this.emit({type: 'mode', mode: this.permissions.mode});
			}
		}

		try {
			const output = await tool.run(args, ctx);
			if (signal.aborted) return finish('interrupted', `Interrupted by the user. Partial output:\n${output}`);
			return finish('ok', output);
		} catch (error) {
			if (signal.aborted) return finish('interrupted', 'Interrupted by the user.');
			return finish('error', `Error: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

function abortPromise(signal: AbortSignal): Promise<'interrupted'> {
	return new Promise(resolve => {
		if (signal.aborted) resolve('interrupted');
		signal.addEventListener('abort', () => resolve('interrupted'), {once: true});
	});
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener('abort', () => {
			clearTimeout(timer);
			reject(new Interrupted());
		}, {once: true});
	});
}
