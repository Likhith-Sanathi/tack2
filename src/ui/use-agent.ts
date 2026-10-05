import {useCallback, useMemo, useRef, useState} from 'react';
import {Agent, type AgentEvent, type ApprovalDecision, type ApprovalRequest, type ToolStatus} from '../agent/agent.js';
import type {Citation, Usage} from '../agent/openrouter.js';
import {nextMode, type PermissionMode} from '../agent/permissions.js';
import {tools, type ToolPreview} from '../tools/index.js';

export type ChatItem =
	| {id: number; kind: 'user'; text: string}
	| {id: number; kind: 'assistant'; text: string; done: boolean}
	| {id: number; kind: 'thinking'; text: string; startedAt: number; seconds?: number}
	| {
			id: number;
			kind: 'tool';
			callId: string;
			name: string;
			summary: string;
			status: 'running' | ToolStatus;
			preview?: ToolPreview;
			/** Live output while running (tail only). */
			output?: string;
			result?: string;
	  }
	| {id: number; kind: 'sources'; sources: Citation[]}
	| {id: number; kind: 'notice' | 'error' | 'info'; text: string};

export type PendingApproval = ApprovalRequest & {resolve: (decision: ApprovalDecision) => void};

export type UsageTotals = {promptTokens: number; completionTokens: number; cost: number; lastPromptTokens: number};

const emptyUsage: UsageTotals = {promptTokens: 0, completionTokens: 0, cost: 0, lastPromptTokens: 0};

const MAX_LIVE_OUTPUT = 4000;

let nextId = 0;

const formatK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Marks a still-open thinking block as finished once the model moves on. */
function closeThinking(items: ChatItem[]): ChatItem[] {
	const last = items.at(-1);
	if (last?.kind !== 'thinking' || last.seconds !== undefined) return items;
	return [...items.slice(0, -1), {...last, seconds: Math.max(1, Math.round((Date.now() - last.startedAt) / 1000))}];
}

function applyEvent(current: ChatItem[], event: AgentEvent): ChatItem[] {
	if (event.type === 'reasoning') {
		const last = current.at(-1);
		if (last?.kind === 'thinking' && last.seconds === undefined) {
			return [...current.slice(0, -1), {...last, text: last.text + event.delta}];
		}
		return [...current, {id: nextId++, kind: 'thinking', text: event.delta, startedAt: Date.now()}];
	}
	if (event.type === 'tool_output') {
		return current.map(item =>
			item.kind === 'tool' && item.callId === event.id
				? {...item, output: ((item.output ?? '') + event.chunk).slice(-MAX_LIVE_OUTPUT)}
				: item,
		);
	}
	if (event.type === 'usage' || event.type === 'mode') return current;

	const items = closeThinking(current);
	const last = items.at(-1);
	switch (event.type) {
		case 'text':
			if (last?.kind === 'assistant' && !last.done) {
				return [...items.slice(0, -1), {...last, text: last.text + event.delta}];
			}
			return [...items, {id: nextId++, kind: 'assistant', text: event.delta, done: false}];
		case 'assistant_done':
			if (last?.kind !== 'assistant' || last.done) return items;
			if (last.text.trim() === '') return items.slice(0, -1);
			return [...items.slice(0, -1), {...last, done: true}];
		case 'tool_start':
			return [
				...items,
				{
					id: nextId++,
					kind: 'tool',
					callId: event.id,
					name: event.name,
					summary: event.summary,
					status: 'running',
					preview: event.preview,
				},
			];
		case 'tool_end':
			return items.map(item =>
				item.kind === 'tool' && item.callId === event.id
					? {...item, status: event.status, result: event.result, output: undefined}
					: item,
			);
		case 'notice':
		case 'error':
			return [...items, {id: nextId++, kind: event.type, text: event.message}];
		case 'compacted':
			return [
				...items,
				{id: nextId++, kind: 'info', text: `Conversation compacted: ~${formatK(event.before)} → ~${formatK(event.after)} tokens.`},
			];
		case 'web': {
			// Run by OpenRouter during the response, so it's already finished. It happened before the
			// reply was written, so it goes above the reply that's still streaming.
			const id = nextId++;
			const item: ChatItem = {id, kind: 'tool', callId: `web-${id}`, name: event.name, summary: event.summary, status: 'ok'};
			if (last?.kind === 'assistant' && !last.done) return [...items.slice(0, -1), item, last];
			return [...items, item];
		}
		case 'sources':
			return [...items, {id: nextId++, kind: 'sources', sources: event.sources}];
	}
}

/** Bridges the UI-agnostic Agent into React state. */
export function useAgent(options: {apiKey: string; model: string; cwd: string; priceUsage: (usage: Usage) => number}) {
	const [items, setItems] = useState<ChatItem[]>([]);
	const [running, setRunning] = useState(false);
	const [approval, setApproval] = useState<PendingApproval | null>(null);
	const approvalRef = useRef<PendingApproval | null>(null);
	const [usage, setUsage] = useState<UsageTotals>(emptyUsage);
	const [mode, setModeState] = useState<PermissionMode>('ask');
	const pending = useRef<AgentEvent[]>([]);
	const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const priceRef = useRef(options.priceUsage);
	priceRef.current = options.priceUsage;

	const agent = useMemo(
		() =>
			new Agent({
				apiKey: options.apiKey,
				model: options.model,
				cwd: options.cwd,
				tools,
				onEvent(event) {
					if (event.type === 'usage') {
						const u = event.usage;
						setUsage(prev => ({
							promptTokens: prev.promptTokens + u.prompt_tokens,
							completionTokens: prev.completionTokens + u.completion_tokens,
							cost: prev.cost + (u.cost ?? priceRef.current(u)),
							lastPromptTokens: u.prompt_tokens,
						}));
					}
					// Mode changes come from Shift+Tab or from approving all edits; show them right away.
					if (event.type === 'mode') setModeState(event.mode);
					if (event.type === 'compacted') {
						setUsage(prev => ({...prev, lastPromptTokens: event.after}));
					}
					// Streams can emit hundreds of events a second; apply them in small batches.
					pending.current.push(event);
					flushTimer.current ??= setTimeout(() => {
						flushTimer.current = null;
						const batch = pending.current;
						pending.current = [];
						setItems(prev => batch.reduce(applyEvent, prev));
					}, 30);
				},
				requestApproval: request =>
					new Promise<ApprovalDecision>(resolve => {
						const pending: PendingApproval = {
							...request,
							resolve: decision => {
								approvalRef.current = null;
								setApproval(null);
								resolve(decision);
							},
						};
						approvalRef.current = pending;
						setApproval(pending);
					}),
			}),
		// The agent lives for the whole session; model changes go through setModel.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[],
	);

	const send = useCallback(
		async (text: string) => {
			setItems(prev => [...prev, {id: nextId++, kind: 'user', text}]);
			setRunning(true);
			await agent.send(text);
			setRunning(false);
		},
		[agent],
	);

	const compact = useCallback(async () => {
		setRunning(true);
		await agent.compactNow();
		setRunning(false);
	}, [agent]);

	const interrupt = useCallback(() => {
		agent.interrupt();
		approvalRef.current?.resolve('deny');
	}, [agent]);

	const reset = useCallback(() => {
		agent.reset();
		pending.current = [];
		setItems([]);
		setUsage(emptyUsage);
	}, [agent]);

	const setModel = useCallback(
		(model: string, contextLength: number | undefined, thinking?: string, provider?: string) => {
			agent.model = model;
			agent.contextLength = contextLength;
			agent.thinking = thinking;
			agent.provider = provider;
		},
		[agent],
	);

	const addNotice = useCallback((text: string, kind: 'notice' | 'error' | 'info' = 'info') => {
		setItems(prev => [...prev, {id: nextId++, kind, text}]);
	}, []);

	const cycleMode = useCallback(() => agent.setMode(nextMode(agent.mode)), [agent]);

	const setWeb = useCallback((enabled: boolean) => (agent.web = enabled), [agent]);
	const setSandbox = useCallback((enabled: boolean) => (agent.sandbox = enabled), [agent]);

	return {
		items,
		running,
		approval,
		usage,
		mode,
		cycleMode,
		send,
		compact,
		interrupt,
		reset,
		setModel,
		setWeb,
		setSandbox,
		sandboxUnavailable: agent.sandboxUnavailable,
		addNotice,
	};
}
