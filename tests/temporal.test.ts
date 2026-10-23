import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationFailure, Context } from '@temporalio/activity';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { createActivities } from '../src/temporal/activities.js';
import { FailureType, TASK_QUEUE, type ProjectInput } from '../src/temporal/shared.js';
import { bundlerOptions, workflowsPath } from '../src/temporal/worker.js';
import { approveSignal, guideSignal, pauseSignal, projectWorkflow, resumeSignal, viewQuery } from '../src/temporal/workflows.js';

type Activities = ReturnType<typeof createActivities>;
type Calls = { name: string; args: unknown[] }[];

let env: TestWorkflowEnvironment;
let bundle: Awaited<ReturnType<typeof import('@temporalio/worker').bundleWorkflowCode>>;
before(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
  const { bundleWorkflowCode } = await import('@temporalio/worker');
  bundle = await bundleWorkflowCode({ workflowsPath, ...bundlerOptions as object, logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, log() {} } as never });
});
after(async () => { await env?.teardown(); });

const failure = (type: string, message = type) => ApplicationFailure.create({ type, message, nonRetryable: true });

const ready = (id: unknown) => ({ kind: 'ready', taskId: id, input: { worktree: '/w', dir: `/t/${id}`, requirement: String(id), baseSha: 'abc', taskId: id } });

/** Mock activities: two tasks (T-001, T-002); `pending` is the queue startNextTask serves. Behaviour per test via overrides. */
function mocks(calls: Calls, overrides: Partial<Record<keyof Activities, (...args: never[]) => unknown>> = {}, pending = ['T-001', 'T-002']): Activities {
  const base: Record<string, (...args: unknown[]) => unknown> = {
    analyze: async () => ({ dir: '/p', status: 'needs_answers' }),
    applyAnswers: async () => ({ unanswered: [] }),
    beginRun: async () => ({ order: [{ id: 'T-001', dependsOn: [] }, { id: 'T-002', dependsOn: ['T-001'] }], maxRepairs: 1 }),
    startTask: async (_d: unknown, _r: unknown, id: unknown) => ready(id),
    startNextTask: async () => pending.length ? ready(pending.shift()) : { kind: 'none' },
    superviseTask: async () => ({ decision: 'skip', rationale: 'mock' }),
    splitTask: async () => [],
    escalateTask: async () => undefined,
    guideTask: async () => undefined,
    planTask: async () => 'plan',
    attemptTask: async () => ({ gate: 'passed', feedback: '', review: { decision: 'pass', summary: 'ok', findings: [] } }),
    completeTask: async () => 'done',
    abandonTask: async () => undefined,
    setStatus: async () => undefined,
    deliver: async () => ({ delivered: false }),
    finishRun: async (_d: unknown, _r: unknown, stopped?: unknown) => ({ status: (stopped as { status?: string } | undefined)?.status ?? "completed" }),
  };
  return Object.fromEntries(Object.keys(base).map(name => [name, async (...args: unknown[]) => {
    calls.push({ name, args });
    return await ((overrides as Record<string, (...a: unknown[]) => unknown>)[name] ?? base[name])(...args);
  }])) as unknown as Activities;
}

const input = (id: string): ProjectInput => ({ projectId: id, repo: '/repo', document: '/doc.md', runRoot: '/runs', config: {}, rateLimitRetryMinutes: 30, rateLimitMaxWaitHours: 2 });
async function withWorker<T>(activities: Activities, fn: () => Promise<T>): Promise<T> {
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: TASK_QUEUE, workflowBundle: bundle, activities });
  return await worker.runUntil(fn());
}
const waitFor = async (check: () => Promise<boolean>) => { for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('condition not reached'); };
const names = (calls: Calls) => calls.map(c => c.name);

test('waits for approval, applies answers, runs tasks in order, then finishes', { timeout: 120_000 }, async () => {
  const calls: Calls = [];
  await withWorker(mocks(calls), async () => {
    const handle = await env.client.workflow.start(projectWorkflow, { taskQueue: TASK_QUEUE, workflowId: 'wf-happy', args: [input('wf-happy')] });
    await waitFor(async () => (await handle.query(viewQuery)).phase === 'awaiting_approval');
    assert.ok(!names(calls).includes('beginRun'), 'must not run before approval');
    await handle.signal(approveSignal, { answers: { 'Q-001': 'Postgres' } });
    const result = await handle.result();
    assert.equal(result.status, 'completed');
    assert.deepEqual(calls.find(c => c.name === 'applyAnswers')?.args[1], { 'Q-001': 'Postgres' });
    assert.deepEqual(calls.filter(c => c.name === 'completeTask').map(c => c.args[2]), ['T-001', 'T-002']);
    assert.deepEqual(names(calls).slice(-2), ['finishRun', 'deliver']);
  });
});

test('an approval that fails validation waits for another approval', { timeout: 120_000 }, async () => {
  const calls: Calls = [];
  let tries = 0;
  const acts = mocks(calls, { beginRun: async () => { if (tries++ === 0) throw failure(FailureType.validation, 'Q-001 unanswered'); return { order: [{ id: 'T-001', dependsOn: [] }], maxRepairs: 0 }; } });
  await withWorker(acts, async () => {
    const handle = await env.client.workflow.start(projectWorkflow, { taskQueue: TASK_QUEUE, workflowId: 'wf-validate', args: [input('wf-validate')] });
    await waitFor(async () => (await handle.query(viewQuery)).phase === 'awaiting_approval');
    await handle.signal(approveSignal, {});
    await waitFor(async () => (await handle.query(viewQuery)).message?.includes('Q-001 unanswered') ?? false);
    assert.equal((await handle.query(viewQuery)).phase, 'awaiting_approval');
    await handle.signal(approveSignal, { answers: { 'Q-001': 'yes' } });
    assert.equal((await handle.result()).status, 'completed');
  });
});

test('a rate limit waits durably, then retries the same step', { timeout: 120_000 }, async () => {
  const calls: Calls = [];
  let attempts = 0;
  const acts = mocks(calls, { attemptTask: async () => { if (attempts++ === 0) throw failure(FailureType.rateLimited, 'usage limit'); return { gate: 'passed', feedback: '' }; } });
  await withWorker(acts, async () => {
    const handle = await env.client.workflow.start(projectWorkflow, { taskQueue: TASK_QUEUE, workflowId: 'wf-rate', args: [input('wf-rate')] });
    await waitFor(async () => (await handle.query(viewQuery)).phase === 'awaiting_approval');
    await handle.signal(approveSignal, {});
    assert.equal((await handle.result()).status, 'completed'); // time skipping fast-forwards the 30 min sleep
    const statuses = calls.filter(c => c.name === 'setStatus').map(c => c.args[2]);
    assert.deepEqual(statuses, ['rate_limited', 'running']);
    assert.equal(calls.filter(c => c.name === 'planTask').length, 2, 'plan is not redone for the retried attempt');
    assert.deepEqual(calls.filter(c => c.name === 'attemptTask').slice(0, 2).map(c => c.args[5]), [0, 0], 'a rate-limit retry repeats the same attempt number');
  });
});

test('a budget stop abandons the task and finishes as budget_exceeded', { timeout: 120_000 }, async () => {
  const calls: Calls = [];
  const acts = mocks(calls, { planTask: async () => { throw failure(FailureType.budget, 'spend reached budget'); } });
  await withWorker(acts, async () => {
    const handle = await env.client.workflow.start(projectWorkflow, { taskQueue: TASK_QUEUE, workflowId: 'wf-budget', args: [input('wf-budget')] });
    await waitFor(async () => (await handle.query(viewQuery)).phase === 'awaiting_approval');
    await handle.signal(approveSignal, {});
    const result = await handle.result();
    assert.equal(result.status, 'budget_exceeded');
    assert.deepEqual(calls.find(c => c.name === 'abandonTask')?.args.slice(2, 3), ['T-001']);
    assert.ok(!names(calls).includes('completeTask'));
  });
});

test('pause holds before the next task until resumed', { timeout: 120_000 }, async () => {
  const calls: Calls = [];
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const acts = mocks(calls, { completeTask: async () => { await gate; return 'done'; } });
  await withWorker(acts, async () => {
    const handle = await env.client.workflow.start(projectWorkflow, { taskQueue: TASK_QUEUE, workflowId: 'wf-pause', args: [input('wf-pause')] });
    await waitFor(async () => (await handle.query(viewQuery)).phase === 'awaiting_approval');
    await handle.signal(approveSignal, {});
    await waitFor(async () => names(calls).includes('completeTask'));
    await handle.signal(pauseSignal);
    release();
    await waitFor(async () => (await handle.query(viewQuery)).phase === 'paused');
    assert.equal(calls.filter(c => c.name === 'startNextTask').length, 1, 'T-002 must not start while paused');
    await handle.signal(resumeSignal);
    assert.equal((await handle.result()).status, 'completed');
    assert.deepEqual(calls.filter(c => c.name === 'setStatus').map(c => c.args[2]), ['paused', 'running']);
  });
});

test('cancellation abandons the running task and finishes as cancelled', { timeout: 120_000 }, async () => {
  const calls: Calls = [];
  // Like the real activities: heartbeat (how cancellation is delivered) and stop when cancelled.
  const acts = mocks(calls, {
    attemptTask: () => new Promise((_, reject) => {
      const ctx = Context.current();
      const beat = setInterval(() => ctx.heartbeat(), 50);
      ctx.cancellationSignal.addEventListener('abort', () => { clearInterval(beat); reject(ctx.cancellationSignal.reason); });
    }),
  });
  await withWorker(acts, async () => {
    const handle = await env.client.workflow.start(projectWorkflow, { taskQueue: TASK_QUEUE, workflowId: 'wf-cancel', args: [input('wf-cancel')] });
    await waitFor(async () => (await handle.query(viewQuery)).phase === 'awaiting_approval');
    await handle.signal(approveSignal, {});
    await waitFor(async () => names(calls).includes('attemptTask'));
    await handle.cancel();
    const result = await handle.result();
    assert.equal(result.status, 'cancelled');
    assert.ok(names(calls).includes('abandonTask'));
    assert.deepEqual(calls.find(c => c.name === 'finishRun')?.args[2], { status: 'cancelled', error: 'cancelled by user' });
  });
});

test('a failed analysis ends the workflow without waiting for approval', { timeout: 120_000 }, async () => {
  const calls: Calls = [];
  await withWorker(mocks(calls, { analyze: async () => ({ dir: '/p', status: 'failed' }) }), async () => {
    const result = await env.client.workflow.execute(projectWorkflow, { taskQueue: TASK_QUEUE, workflowId: 'wf-analysis-failed', args: [input('wf-analysis-failed')] });
    assert.deepEqual([result.phase, result.status], ['finished', 'failed']);
    assert.deepEqual(names(calls), ['analyze']);
  });
});

test('delivery runs after a completed build; its failure is reported without changing the result', { timeout: 120_000 }, async () => {
  const calls: Calls = [];
  await withWorker(mocks(calls, { deliver: async () => ({ delivered: false, error: 'remote rejected the push' }) }), async () => {
    const handle = await env.client.workflow.start(projectWorkflow, { taskQueue: TASK_QUEUE, workflowId: 'wf-deliver', args: [input('wf-deliver')] });
    await waitFor(async () => (await handle.query(viewQuery)).phase === 'awaiting_approval');
    await handle.signal(approveSignal, {});
    const result = await handle.result();
    assert.equal(result.status, 'completed');
    assert.match(result.message ?? '', /Delivery failed.*remote rejected the push/);
    assert.deepEqual(names(calls).slice(-2), ['finishRun', 'deliver']);
  });
});

const failing = (n: number) => { let left = n; return async () => (left-- > 0 ? { gate: 'checks', feedback: 'tests fail' } : { gate: 'passed', feedback: '' }); };
async function approved(id: string) {
  const handle = await env.client.workflow.start(projectWorkflow, { taskQueue: TASK_QUEUE, workflowId: id, args: [input(id)] });
  await waitFor(async () => (await handle.query(viewQuery)).phase === 'awaiting_approval');
  await handle.signal(approveSignal, {});
  return handle;
}

test('after exhausting repairs, a manager retry re-plans with guidance and continues the attempt count', { timeout: 120_000 }, async () => {
  const calls: Calls = [];
  const acts = mocks(calls, { attemptTask: failing(2), superviseTask: async () => ({ decision: 'retry', rationale: 'wrong approach', guidance: 'use the existing parser' }) }, ['T-001']);
  await withWorker(acts, async () => {
    const result = await (await approved('wf-mgr-retry')).result();
    assert.equal(result.status, 'completed');
    const plans = calls.filter(c => c.name === 'planTask').map(c => c.args[2] as { requirement: string; round: number });
    assert.deepEqual(plans.map(p => p.round), [0, 1]);
    assert.match(plans[1].requirement, /engineering manager: use the existing parser/);
    assert.deepEqual(calls.filter(c => c.name === 'attemptTask').map(c => c.args[5]), [0, 1, 2], 'attempt numbers continue across rounds');
    const failure = calls.find(c => c.name === 'superviseTask')!.args[3] as { gates: string[]; attempts: number };
    assert.deepEqual([failure.gates, failure.attempts], [['checks', 'checks'], 2]);
    assert.deepEqual(calls.find(c => c.name === 'completeTask')!.args[3], { passed: true, attempts: 3 });
  });
});

test('a manager split replaces the task and the new subtasks run next', { timeout: 120_000 }, async () => {
  const calls: Calls = [];
  const pending = ['T-001', 'T-002'];
  let first = true;
  const acts = mocks(calls, {
    attemptTask: async (_d: never, _r: never, input: never) => ((input as { taskId: string }).taskId === 'T-001' ? { gate: 'review', feedback: 'too big' } : { gate: 'passed', feedback: '' }),
    superviseTask: async () => ({ decision: 'split', rationale: 'too big', subtasks: [{ title: 'a', description: 'a', acceptanceCriteria: ['a'] }, { title: 'b', description: 'b', acceptanceCriteria: ['b'] }] }),
    splitTask: async () => { if (first) { first = false; pending.unshift('T-001.1', 'T-001.2'); } return ['T-001.1', 'T-001.2']; },
  }, pending);
  await withWorker(acts, async () => {
    const result = await (await approved('wf-mgr-split')).result();
    assert.equal(result.status, 'completed');
    assert.deepEqual(calls.find(c => c.name === 'splitTask')!.args[2], 'T-001');
    assert.deepEqual(calls.filter(c => c.name === 'completeTask').map(c => c.args[2]), ['T-001.1', 'T-001.2', 'T-002']);
  });
});

test('a manager escalation waits for a human; guidance restarts the task with a fresh brief', { timeout: 120_000 }, async () => {
  const calls: Calls = [];
  let escalated = false;
  const acts = mocks(calls, {
    attemptTask: async () => (escalated ? { gate: 'passed', feedback: '' } : { gate: 'review', feedback: 'which currency?' }),
    superviseTask: async () => { escalated = true; return { decision: 'escalate', rationale: 'ambiguous', question: 'Which currency should totals use?' }; },
  }, ['T-001']);
  await withWorker(acts, async () => {
    const handle = await approved('wf-mgr-escalate');
    await waitFor(async () => (await handle.query(viewQuery)).phase === 'needs_attention');
    assert.deepEqual((await handle.query(viewQuery)).question, { taskId: 'T-001', question: 'Which currency should totals use?' });
    assert.ok(!names(calls).includes('completeTask'), 'nothing is decided while waiting');
    await handle.signal(guideSignal, { taskId: 'T-001', action: 'retry', guidance: 'EUR, two decimals' });
    assert.equal((await handle.result()).status, 'completed');
    assert.deepEqual(calls.find(c => c.name === 'guideTask')!.args[2], { taskId: 'T-001', action: 'retry', guidance: 'EUR, two decimals' });
    assert.ok(names(calls).includes('startTask'), 'the task restarts with a brief that carries the guidance');
    assert.deepEqual(calls.find(c => c.name === 'completeTask')!.args[3], { passed: true, attempts: 1 });
  });
});

test('a human can skip an escalated task; it fails with that note and the run goes on', { timeout: 120_000 }, async () => {
  const calls: Calls = [];
  const acts = mocks(calls, {
    attemptTask: async (_d: never, _r: never, input: never) => ((input as { taskId: string }).taskId === 'T-001' ? { gate: 'review', feedback: 'x' } : { gate: 'passed', feedback: '' }),
    superviseTask: async () => ({ decision: 'escalate', rationale: 'needs a product call', question: 'Keep legacy API?' }),
  });
  await withWorker(acts, async () => {
    const handle = await approved('wf-mgr-skip');
    await waitFor(async () => (await handle.query(viewQuery)).phase === 'needs_attention');
    await handle.signal(guideSignal, { taskId: 'T-001', action: 'skip' });
    await handle.result();
    const done = calls.filter(c => c.name === 'completeTask');
    assert.deepEqual(done.map(c => [c.args[2], (c.args[3] as { passed: boolean }).passed, c.args[4]]), [['T-001', false, 'skipped by the product owner'], ['T-002', true, undefined]]);
  });
});

test('a resumed project skips analysis and approval and goes straight to the run', { timeout: 120_000 }, async () => {
  const calls: Calls = [];
  await withWorker(mocks(calls), async () => {
    const result = await env.client.workflow.execute(projectWorkflow, { taskQueue: TASK_QUEUE, workflowId: 'wf-resume', args: [{ ...input('wf-resume'), resume: true }] });
    assert.equal(result.status, 'completed');
    assert.ok(!names(calls).includes('analyze'));
    assert.deepEqual(calls.find(c => c.name === 'beginRun')!.args[0], '/runs/wf-resume');
  });
});
