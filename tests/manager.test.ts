import test from 'node:test';
import assert from 'node:assert/strict';
import { managerJsonSchema, parseDecision } from '../src/manager.js';

const limits = { allowSplit: true, allowEscalate: true, maxSubtasks: 3 };
const sub = (t: string) => ({ title: t, description: t, acceptanceCriteria: [t] });

test('each decision must carry what it needs', () => {
  assert.deepEqual(parseDecision(JSON.stringify({ decision: 'retry', rationale: 'r', guidance: ' do X ' }), limits), { decision: 'retry', rationale: 'r', guidance: 'do X' });
  assert.throws(() => parseDecision(JSON.stringify({ decision: 'retry', rationale: 'r' }), limits), /retry needs guidance/);
  assert.throws(() => parseDecision(JSON.stringify({ decision: 'escalate', rationale: 'r', question: ' ' }), limits), /escalate needs a question/);
  assert.throws(() => parseDecision(JSON.stringify({ decision: 'split', rationale: 'r', subtasks: [sub('a')] }), limits), /2 to 3 subtasks, got 1/);
  assert.throws(() => parseDecision(JSON.stringify({ decision: 'split', rationale: 'r', subtasks: [sub('a'), { ...sub('b'), acceptanceCriteria: [] }] }), limits), /subtask 2 needs/);
  assert.throws(() => parseDecision(JSON.stringify({ decision: 'skip', rationale: '  ' }), limits), /rationale is empty/);
  assert.throws(() => parseDecision('not json', limits), /not JSON/);
  assert.throws(() => parseDecision(JSON.stringify({ decision: 'merge', rationale: 'r' }), limits), /Malformed/);
});

test('disallowed decisions are rejected, and fields irrelevant to the decision are dropped', () => {
  assert.throws(() => parseDecision(JSON.stringify({ decision: 'split', rationale: 'r', subtasks: [sub('a'), sub('b')] }), { ...limits, allowSplit: false }), /split is not allowed/);
  assert.throws(() => parseDecision(JSON.stringify({ decision: 'escalate', rationale: 'r', question: 'q?' }), { ...limits, allowEscalate: false }), /escalate is not allowed/);
  assert.deepEqual(parseDecision(JSON.stringify({ decision: 'skip', rationale: 'r', guidance: 'ignored', question: 'ignored' }), limits), { decision: 'skip', rationale: 'r' });
});

test('the JSON schema handed to Claude lists every decision', () => {
  const schema = managerJsonSchema() as { properties: { decision: { enum: string[] } }; required: string[] };
  assert.deepEqual(schema.properties.decision.enum, ['retry', 'split', 'escalate', 'skip']);
  assert.deepEqual(schema.required, ['decision', 'rationale']);
});
