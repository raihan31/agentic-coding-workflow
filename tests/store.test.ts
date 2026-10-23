import test from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationFailure } from '@temporalio/activity';
import { RateLimitedError } from '../src/adapters.js';
import { BudgetExceeded } from '../src/engine.js';
import type { ProjectState } from '../src/project.js';
import { EVENTS_CHANNEL, PgStore } from '../src/store.js';
import { toFailure } from '../src/temporal/activities.js';
import { FailureType } from '../src/temporal/shared.js';
import { sampleBacklog } from './fixtures.js';

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://agentic:agentic@localhost:55432/agentic';
const pgAvailable = await (async () => {
  try {
    const { default: pg } = await import('pg');
    const c = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 2_000 });
    await c.connect(); await c.end(); return true;
  } catch { return false; }
})();

const state = (status: ProjectState['status'], tasks: ProjectState['tasks']): ProjectState => ({
  id: 'proj-test', status, repo: '/repo', worktree: '/w', branch: 'agentic/proj-test', baseSha: 'abc', promptVersion: 'v',
  document: { name: 'prd.md', format: 'markdown', sha256: 'x', warnings: [] }, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z',
  tasks, invocations: [],
});

test('PgStore mirrors projects, tasks, backlog and events, and notifies listeners', { skip: pgAvailable ? false : 'postgres not reachable (npm run stack:up)' }, async () => {
  const { default: pg } = await import('pg');
  const dbName = `agentic_test_${process.pid}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = ADMIN_URL.replace(/\/[^/]+$/, `/${dbName}`);
  const store = await PgStore.connect(url);
  const listener = new pg.Client({ connectionString: url });
  try {
    await store.migrate(); // idempotent
    await listener.connect();
    const notified = new Promise<string>(resolve => listener.on('notification', n => resolve(n.payload ?? '')));
    await listener.query(`LISTEN ${EVENTS_CHANNEL}`);

    await store.saveState('/runs/proj-test', state('backlog_ready', { 'T-001': { status: 'pending', attempts: 0 }, 'T-002': { status: 'pending', attempts: 0 } }));
    await store.saveBacklog('/runs/proj-test', 'proj-test', sampleBacklog());
    await store.saveState('/runs/proj-test', state('running', { 'T-001': { status: 'done', attempts: 1, commit: 'c0ffee' } }));
    await store.appendEvent('/runs/proj-test', { projectId: 'proj-test', taskId: 'T-001', type: 'task.status', data: { status: 'done' }, at: '2026-10-20T00:00:01Z' });

    const q = (sql: string) => store.pool.query(sql).then(r => r.rows);
    assert.deepEqual(await q(`SELECT id, status, dir FROM projects`), [{ id: 'proj-test', status: 'running', dir: '/runs/proj-test' }]);
    assert.deepEqual(await q(`SELECT id, status, commit_sha FROM tasks ORDER BY id`), [{ id: 'T-001', status: 'done', commit_sha: 'c0ffee' }], 'tasks removed from the backlog are deleted');
    assert.equal((await q(`SELECT backlog->>'summary' AS s FROM projects`))[0].s, 'A sample project.');
    assert.deepEqual(await q(`SELECT task_id, type, data FROM events`), [{ task_id: 'T-001', type: 'task.status', data: { status: 'done' } }]);
    assert.deepEqual(JSON.parse(await notified), { id: '1', projectId: 'proj-test', type: 'task.status' });
  } finally {
    await listener.end().catch(() => {});
    await store.close();
    await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    await admin.end();
  }
});

test('activities map domain errors to Temporal failure types', async () => {
  const { ProjectValidationError } = await import('../src/project.js');
  const { BacklogError } = await import('../src/backlog.js');
  for (const [error, type] of [
    [new BudgetExceeded(2, 1), FailureType.budget],
    [new RateLimitedError('usage limit'), FailureType.rateLimited],
    [new ProjectValidationError('Q-001 unanswered'), FailureType.validation],
    [new BacklogError(['bad']), FailureType.validation],
  ] as const) {
    const mapped = toFailure(error);
    assert.ok(mapped instanceof ApplicationFailure && mapped.type === type && mapped.nonRetryable, `${error.name} -> ${type}`);
  }
  const plain = new Error('ENOENT');
  assert.equal(toFailure(plain), plain, 'infrastructure errors stay retryable');
});
