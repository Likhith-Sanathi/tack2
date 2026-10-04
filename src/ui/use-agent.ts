import {useCallback, useMemo, useRef, useState} from 'react';
import {Agent, type AgentEvent, type ApprovalDecision, type ApprovalRequest, type ToolStatus} from '../agent/agent.js';
import type {Usage} from '../agent/openrouter.js';
import {tools} from '../tools/index.js';

export type ChatItem =
	| {id: number; kind: 'user'; text: string}
	| {id: number; kind: 'assistant'; text: string; done: boolean}
	| {id: number; kind: 'tool'; callId: string; name: string; summary: string; status: 'running' | ToolStatus; result?: string}
	| {id: number; kind: 'notice' | 'error' | 'info'; text: string};

export type PendingApproval = ApprovalRequest & {resolve: (decision: ApprovalDecision) => void};

export type UsageTotals = {promptTokens: number; completionTokens: number; cost: number; lastPromptTokens: number};

const emptyUsage: UsageTotals = {promptTokens: 0, completionTokens: 0, cost: 0, lastPromptTokens: 0};

let nextId = 0;

const formatK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function applyEvent(items: ChatItem[], event: AgentEvent): ChatItem[] {
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
			return [...items, {id: nextId++, kind: 'tool', callId: event.id, name: event.name, summary: event.summary, status: 'running'}];
		case 'tool_end':
			return items.map(item =>
				item.kind === 'tool' && item.callId === event.id ? {...item, status: event.status, result: event.result} : item,
			);
		case 'notice':
		case 'error':
			return [...items, {id: nextId++, kind: event.type, text: event.message}];
		case 'compacted':
			return [
				...items,
				{id: nextId++, kind: 'info', text: `Conversation compacted: ~${formatK(event.before)} → ~${formatK(event.after)} tokens.`},
			];
		case 'usage':
			return items;
	}
}

/** Bridges the UI-agnostic Agent into React state. */
export function useAgent(options: {apiKey: string; model: string; cwd: string; priceUsage: (usage: Usage) => number}) {
	const [items, setItems] = useState<ChatItem[]>([]);
	const [running, setRunning] = useState(false);
	const [approval, setApproval] = useState<PendingApproval | null>(null);
	const approvalRef = useRef<PendingApproval | null>(null);
	const [usage, setUsage] = useState<UsageTotals>(emptyUsage);
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
					if (event.type === 'compacted') {
						setUsage(prev => ({...prev, lastPromptTokens: event.after}));
					}
					setItems(prev => applyEvent(prev, event));
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
		setItems([]);
		setUsage(emptyUsage);
	}, [agent]);

	const setModel = useCallback(
		(model: string, contextLength: number | undefined) => {
			agent.model = model;
			agent.contextLength = contextLength;
		},
		[agent],
	);

	const addNotice = useCallback((text: string, kind: 'notice' | 'error' | 'info' = 'info') => {
		setItems(prev => [...prev, {id: nextId++, kind, text}]);
	}, []);

	return {items, running, approval, usage, send, compact, interrupt, reset, setModel, addNotice};
}
