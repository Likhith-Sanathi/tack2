// Thinking (reasoning) levels a model accepts, from OpenRouter's model metadata, and how a chosen
// level is sent in a request. See https://openrouter.ai/docs/guides/best-practices/reasoning-tokens

/** The `reasoning` object OpenRouter's model list includes for each model. */
export type ReasoningInfo = {
	/** Accepted efforts. `null`: every effort is accepted. `undefined`: no effort selection. */
	supportedEfforts?: string[] | null;
	defaultEffort?: string;
	/** Reasoning can't be turned off (`effort: "none"` is rejected). */
	mandatory?: boolean;
	/** Whether reasoning is on when the request doesn't say. */
	defaultEnabled?: boolean;
};

export type ThinkingModel = {reasoning?: ReasoningInfo; supportsReasoning: boolean};

/** Efforts from least to most thinking. `none` turns reasoning off. */
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** What "every effort" means when a model's list is null. */
const ALL_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

/**
 * Levels the user can pick for a model, from least to most thinking. Effort levels for models that
 * take them, `off`/`on` for models that can only toggle reasoning, and none if it can't be changed.
 */
export function thinkingLevels(model: ThinkingModel): string[] {
	const info = model.reasoning;
	if (info?.supportedEfforts !== undefined) {
		const efforts = info.supportedEfforts ?? ALL_EFFORTS;
		return EFFORTS.filter(e => efforts.includes(e) && !(e === 'none' && info.mandatory));
	}
	if (model.supportsReasoning && !info?.mandatory) return ['off', 'on'];
	return [];
}

/** The level a model uses when the request doesn't set one, as one of its `thinkingLevels`. */
export function defaultThinking(model: ThinkingModel): string | undefined {
	const levels = thinkingLevels(model);
	if (levels.length === 0) return undefined;
	const enabled = model.reasoning?.defaultEnabled;
	if (levels[0] === 'off' && levels.length === 2) return enabled === false ? 'off' : 'on';
	if (enabled === false && levels.includes('none')) return 'none';
	const preferred = [model.reasoning?.defaultEffort, 'medium'].find(e => e !== undefined && levels.includes(e));
	return preferred ?? levels[Math.floor(levels.length / 2)];
}

/** The `reasoning` request field for a level, or undefined to leave the model's default. */
export function reasoningParam(level: string | undefined): Record<string, unknown> | undefined {
	if (level === undefined) return undefined;
	if (level === 'off') return {enabled: false};
	if (level === 'on') return {enabled: true};
	return {effort: level};
}

/** How a level is shown to the user. */
export function thinkingLabel(level: string): string {
	return level === 'none' ? 'off' : level === 'xhigh' ? 'extra high' : level;
}
