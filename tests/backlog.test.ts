import test from 'node:test';
import assert from 'node:assert/strict';
import { backlogJsonSchema, BacklogError, parseBacklog, renderBacklogMarkdown, taskOrder, unansweredBlockingQuestions } from '../src/backlog.js';
import { sampleBacklog } from './fixtures.js';

const issues = (fn: () => unknown) => { try { fn(); return []; } catch (e) { assert.ok(e instanceof BacklogError, String(e)); return e.problems; } };

test('accepts a valid backlog', () => {
  assert.equal(parseBacklog(sampleBacklog(), { maxTasks: 10 }).tasks.length, 3);
});

test('rejects broken references, duplicates, uncovered musts and oversize backlogs', () => {
  const b = sampleBacklog();
  b.tasks[1].dependsOn = ['T-404'];
  b.tasks[2].requirementIds = ['REQ-999'];
  b.tasks.push({ ...b.tasks[0] });
  const problems = issues(() => parseBacklog(b, { maxTasks: 3 }));
  for (const expected of [/depends on unknown task T-404/, /unknown requirement REQ-999/, /duplicate task id T-001/, /exceeds the limit of 3/]) assert.ok(problems.some(p => expected.test(p)), `${expected} in ${problems}`);
  const uncovered = sampleBacklog();
  uncovered.tasks = uncovered.tasks.filter(t => t.id === 'T-003');
  assert.ok(issues(() => parseBacklog(uncovered, { maxTasks: 10 })).some(p => /must-have requirement REQ-001 is not covered/.test(p)));
  assert.ok(issues(() => parseBacklog({ summary: 1 }, { maxTasks: 10 })).length > 0);
});

test('orders by dependencies and detects cycles', () => {
  const b = sampleBacklog();
  b.tasks.reverse(); // T-003, T-002, T-001
  assert.deepEqual(taskOrder(b.tasks).map(t => t.id), ['T-003', 'T-001', 'T-002']);
  b.tasks.find(t => t.id === 'T-001')!.dependsOn = ['T-002'];
  assert.throws(() => taskOrder(b.tasks), /cycle among tasks: T-002, T-001|cycle among tasks: T-001, T-002/);
});

test('blocking questions need answers', () => {
  const b = sampleBacklog();
  b.openQuestions = [
    { id: 'Q-001', question: 'Which DB?', context: 'assumed SQLite', blocking: true, requirementIds: ['REQ-001'] },
    { id: 'Q-002', question: 'Colour?', context: 'assumed blue', blocking: false, requirementIds: [] },
  ];
  assert.deepEqual(unansweredBlockingQuestions(b).map(q => q.id), ['Q-001']);
  b.openQuestions[0].answer = 'Postgres';
  assert.deepEqual(unansweredBlockingQuestions(b), []);
});

test('JSON schema for the analyst omits the human-only answer field', () => {
  const schema = JSON.stringify(backlogJsonSchema());
  assert.ok(!schema.includes('"answer"'));
  assert.ok(schema.includes('"acceptanceCriteria"'));
});

test('markdown rendering lists tasks in execution order', () => {
  const md = renderBacklogMarkdown(sampleBacklog());
  assert.ok(md.indexOf('### T-001') < md.indexOf('### T-002'));
  assert.match(md, /## Out of scope[\s\S]*mobile app/);
});

test('rejects a backlog with no requirements or tasks that implement nothing', () => {
  const b = sampleBacklog();
  b.requirements = [];
  b.tasks = b.tasks.map(t => ({ ...t, requirementIds: [] }));
  const problems = issues(() => parseBacklog(b, { maxTasks: 10 }));
  assert.ok(problems.some(p => /no requirements extracted/.test(p)));
  assert.ok(problems.some(p => /T-001 implements no requirement/.test(p)));
});
