// Minimal OpenRouter client: streaming chat completions with tool calling, plus model listing.

const BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';

export type ToolCall = {
	id: string;
	type: 'function';
	function: {name: string; arguments: string};
};

export type ChatMessage =
	| {role: 'system'; content: string}
	| {role: 'user'; content: string}
	| {role: 'assistant'; content: string | null; tool_calls?: ToolCall[]}
	| {role: 'tool'; tool_call_id: string; content: string};

export type ToolSpec = {
	type: 'function';
	function: {name: string; description: string; parameters: unknown};
};

export type Usage = {
	prompt_tokens: number;
	completion_tokens: number;
	cost?: number;
};

export type StreamResult = {
	content: string;
	toolCalls: ToolCall[];
	finishReason: string | null;
	usage?: Usage;
};

export type ModelInfo = {
	id: string;
	name: string;
	contextLength: number;
	/** USD per token. */
	promptPrice: number;
	completionPrice: number;
	supportsTools: boolean;
};

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = 'ApiError';
	}

	get retryable(): boolean {
		return this.status === 429 || (this.status !== undefined && this.status >= 500);
	}
}

function headers(apiKey: string): Record<string, string> {
	return {
		Authorization: `Bearer ${apiKey}`,
		'Content-Type': 'application/json',
		'HTTP-Referer': 'https://github.com/likhith-sanathi/tack2',
		'X-Title': 'tack',
	};
}

async function errorFromResponse(res: Response): Promise<ApiError> {
	let detail = res.statusText;
	try {
		const body = (await res.json()) as {error?: {message?: string}};
		detail = body.error?.message ?? detail;
	} catch {
		// body was not JSON; keep statusText
	}
	const prefix = res.status === 429 ? 'Rate limited' : `HTTP ${res.status}`;
	return new ApiError(`${prefix}: ${detail}`, res.status);
}

/** fetch() with network failures turned into readable errors. */
async function request(url: string, init: RequestInit): Promise<Response> {
	try {
		return await fetch(url, init);
	} catch (error) {
		if (init.signal?.aborted) throw error;
		const cause = (error as {cause?: {message?: string}}).cause?.message;
		throw new ApiError(`Network error: ${cause ?? (error as Error).message}`);
	}
}

/** Yields parsed JSON payloads from an SSE response body. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
	const decoder = new TextDecoder();
	let buffer = '';
	for await (const chunk of body) {
		buffer += decoder.decode(chunk, {stream: true});
		let newline: number;
		while ((newline = buffer.indexOf('\n')) !== -1) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			// Lines starting with ':' are SSE comments (OpenRouter sends keep-alives this way).
			if (!line.startsWith('data:')) continue;
			const data = line.slice(5).trim();
			if (data === '[DONE]') return;
			yield JSON.parse(data);
		}
	}
}

type StreamChunk = {
	error?: {message?: string; code?: number};
	choices?: Array<{
		delta?: {
			content?: string | null;
			reasoning?: string | null;
			reasoning_details?: Array<{type?: string; text?: string; summary?: string}>;
			tool_calls?: Array<{
				index: number;
				id?: string;
				function?: {name?: string; arguments?: string};
			}>;
		};
		finish_reason?: string | null;
	}>;
	usage?: Usage;
};

export async function streamChat(options: {
	apiKey: string;
	model: string;
	messages: ChatMessage[];
	tools: ToolSpec[];
	signal: AbortSignal;
	onText: (delta: string) => void;
	/** Receives the model's thinking, for models that expose it. */
	onReasoning?: (delta: string) => void;
}): Promise<StreamResult> {
	const res = await request(`${BASE_URL}/chat/completions`, {
		method: 'POST',
		headers: headers(options.apiKey),
		signal: options.signal,
		body: JSON.stringify({
			model: options.model,
			messages: options.messages,
			tools: options.tools.length > 0 ? options.tools : undefined,
			stream: true,
			usage: {include: true},
		}),
	});
	if (!res.ok || !res.body) throw await errorFromResponse(res);

	const result: StreamResult = {content: '', toolCalls: [], finishReason: null};
	for await (const event of sseEvents(res.body)) {
		const chunk = event as StreamChunk;
		if (chunk.error) {
			throw new ApiError(chunk.error.message ?? 'Unknown streaming error', chunk.error.code);
		}
		if (chunk.usage) result.usage = chunk.usage;
		const choice = chunk.choices?.[0];
		if (!choice) continue;
		if (choice.finish_reason) result.finishReason = choice.finish_reason;
		const delta = choice.delta;
		// Some providers only fill reasoning_details; avoid showing the same text twice.
		const reasoning =
			delta?.reasoning ||
			(delta?.reasoning_details ?? [])
				.map(d => (d.type === 'reasoning.text' ? d.text : d.type === 'reasoning.summary' ? d.summary : '') ?? '')
				.join('');
		if (reasoning) options.onReasoning?.(reasoning);
		if (delta?.content) {
			result.content += delta.content;
			options.onText(delta.content);
		}
		for (const part of delta?.tool_calls ?? []) {
			// Tool calls arrive in fragments keyed by index; stitch them together.
			const call = (result.toolCalls[part.index] ??= {
				id: '',
				type: 'function',
				function: {name: '', arguments: ''},
			});
			if (part.id) call.id = part.id;
			if (part.function?.name) call.function.name += part.function.name;
			if (part.function?.arguments) call.function.arguments += part.function.arguments;
		}
	}
	result.toolCalls = result.toolCalls.filter(Boolean);
	return result;
}

export async function listModels(apiKey: string): Promise<ModelInfo[]> {
	const res = await request(`${BASE_URL}/models`, {headers: headers(apiKey)});
	if (!res.ok) throw await errorFromResponse(res);
	const body = (await res.json()) as {
		data: Array<{
			id: string;
			name?: string;
			context_length?: number;
			pricing?: {prompt?: string; completion?: string};
			supported_parameters?: string[];
		}>;
	};
	return body.data
		.map(m => ({
			id: m.id,
			name: m.name ?? m.id,
			contextLength: m.context_length ?? 0,
			promptPrice: Number(m.pricing?.prompt ?? 0),
			completionPrice: Number(m.pricing?.completion ?? 0),
			supportsTools: m.supported_parameters?.includes('tools') ?? false,
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
}
