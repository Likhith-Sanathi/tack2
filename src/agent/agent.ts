import {z} from 'zod';
import type {AnyTool} from '../tools/index.js';
import {ApiError, streamChat, type ChatMessage, type StreamResult, type ToolCall, type ToolSpec, type Usage} from './openrouter.js';

export type ToolStatus = 'ok' | 'error' | 'denied' | 'interrupted';

export type AgentEvent =
	| {type: 'text'; delta: string}
	| {type: 'assistant_done'}
	| {type: 'tool_start'; id: string; name: string; summary: string}
	| {type: 'tool_end'; id: string; status: ToolStatus; result: string}
	| {type: 'usage'; usage: Usage}
	| {type: 'notice'; message: string}
	| {type: 'error'; message: string};

export type ApprovalRequest = {toolName: string; summary: string; preview?: string};
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

/**
 * Runs the conversation loop: model -> tool calls -> tool results -> model, until the model
 * replies without tool calls. Knows nothing about the UI; it reports progress through `onEvent`.
 */
export class Agent {
	model: string;
	private messages: ChatMessage[];
	private readonly alwaysAllowed = new Set<string>();
	private controller: AbortController | null = null;

	constructor(private readonly options: AgentOptions) {
		this.model = options.model;
		this.messages = [{role: 'system', content: systemPrompt(options.cwd)}];
	}

	get running(): boolean {
		return this.controller !== null;
	}

	/** Stops the current generation or tool call. The conversation stays usable. */
	interrupt(): void {
		this.controller?.abort();
	}

	/** Clears conversation history and session approvals. */
	reset(): void {
		this.interrupt();
		this.messages = this.messages.slice(0, 1);
		this.alwaysAllowed.clear();
	}

	/** Sends a user message and runs the agent loop until the turn ends. Never throws. */
	async send(text: string): Promise<void> {
		if (this.controller) throw new Error('Agent is already running');
		const controller = new AbortController();
		this.controller = controller;
		this.messages.push({role: 'user', content: text});
		try {
			await this.loop(controller.signal);
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
			const result = await this.callModel(tools, signal);
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
					messages: this.messages,
					tools,
					signal,
					onText: delta => {
						partial += delta;
						this.emit({type: 'text', delta});
					},
				});
				if (result.usage) this.emit({type: 'usage', usage: result.usage});
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
		this.emit({type: 'tool_start', id: call.id, name, summary});

		if (tool.requiresApproval && !this.alwaysAllowed.has(name)) {
			const decision = await Promise.race([
				this.options.requestApproval({toolName: name, summary, preview: tool.preview?.(args)}),
				abortPromise(signal),
			]);
			if (decision === 'interrupted') return finish('interrupted', 'Interrupted by the user.');
			if (decision === 'deny') return finish('denied', 'The user denied this action. Ask them how to proceed.');
			if (decision === 'always') this.alwaysAllowed.add(name);
		}

		try {
			const output = await tool.run(args, {cwd: this.options.cwd, signal});
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
