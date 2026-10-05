import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultThinking, reasoningParam, thinkingLabel, thinkingLevels} from './thinking.js';

test('uses the efforts the model lists, ordered least to most', () => {
	const model = {supportsReasoning: true, reasoning: {supportedEfforts: ['max', 'xhigh', 'high', 'medium', 'low', 'none'], defaultEffort: 'medium'}};
	assert.deepEqual(thinkingLevels(model), ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
	assert.equal(defaultThinking(model), 'medium');
});

test('null efforts means every standard effort', () => {
	const model = {supportsReasoning: true, reasoning: {supportedEfforts: null}};
	assert.deepEqual(thinkingLevels(model), ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
	assert.equal(defaultThinking(model), 'medium');
});

test('mandatory reasoning cannot be turned off', () => {
	const model = {supportsReasoning: true, reasoning: {supportedEfforts: ['high', 'medium', 'low', 'none'], mandatory: true}};
	assert.deepEqual(thinkingLevels(model), ['low', 'medium', 'high']);
	assert.deepEqual(thinkingLevels({supportsReasoning: true, reasoning: {mandatory: true}}), []);
});

test('reasoning off by default starts at off', () => {
	const model = {supportsReasoning: true, reasoning: {supportedEfforts: ['high', 'low', 'none'], defaultEnabled: false}};
	assert.equal(defaultThinking(model), 'none');
});

test('models without effort selection get an on/off toggle', () => {
	assert.deepEqual(thinkingLevels({supportsReasoning: true}), ['off', 'on']);
	assert.equal(defaultThinking({supportsReasoning: true}), 'on');
	assert.equal(defaultThinking({supportsReasoning: true, reasoning: {defaultEnabled: false}}), 'off');
});

test('models without reasoning have no levels', () => {
	assert.deepEqual(thinkingLevels({supportsReasoning: false}), []);
	assert.equal(defaultThinking({supportsReasoning: false}), undefined);
});

test('falls back to the middle level when there is no default or medium', () => {
	assert.equal(defaultThinking({supportsReasoning: true, reasoning: {supportedEfforts: ['high', 'low', 'minimal']}}), 'low');
});

test('request parameters and labels', () => {
	assert.equal(reasoningParam(undefined), undefined);
	assert.deepEqual(reasoningParam('high'), {effort: 'high'});
	assert.deepEqual(reasoningParam('none'), {effort: 'none'});
	assert.deepEqual(reasoningParam('off'), {enabled: false});
	assert.deepEqual(reasoningParam('on'), {enabled: true});
	assert.equal(thinkingLabel('none'), 'off');
	assert.equal(thinkingLabel('xhigh'), 'extra high');
});
