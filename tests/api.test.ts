import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { parseConfig } from '../src/config.js';
import { silentLogger } from '../src/log.js';
import type { ProjectState } from '../src/project.js';
import { execute } from '../src/process.js';
import { PgStore } from '../src/store.js';
import { sampleBacklog } from './fixtures.js';

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://agentic:agentic@localhost:55432/agentic';
const pgAvailable = await (async () => {
  try {
    const { default: pg } = await import('pg');
    const c = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 2_000 });
    await c.connect(); await c.end(); return true;
  } catch { return false; }
})();
const skip = pgAvailable ? false : 'postgres not reachable (npm run stack:up)';

let env: TestWorkflowEnvironment;
let store: PgStore;
let app: FastifyInstance;
let runRoot: string;
let repoRoot: string;
const dbName = `agentic_api_test_${process.pid}`;
const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}` };

before(async () => {
  if (!pgAvailable) return;
  const { default: pg } = await import('pg');
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`); await admin.end();
  store = await PgStore.connect(ADMIN_URL.replace(/\/[^/]+$/, `/${dbName}`));
  env = await TestWorkflowEnvironment.createTimeSkipping();
  runRoot = await mkdtemp(join(tmpdir(), 'agentic-api-runs-'));
  repoRoot = await mkdtemp(join(tmpdir(), 'agentic-api-repos-'));
  app = await buildServer({ store, temporal: env.client, logger: silentLogger, runRoot, uploadsDir: join(runRoot, 'uploads'), defaultConfig: parseConfig({}), token: TOKEN, repoRoots: [repoRoot] });
});
after(async () => {
  if (!pgAvailable) return;
  await app?.close();
  await store?.close();
  await env?.teardown();
  const { default: pg } = await import('pg');
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect(); await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await admin.end();
});

async function gitRepo(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  await execute('git', ['init', '-q', '-b', 'main'], path);
  await execute('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], path);
  return path;
}

function multipart(fields: Record<string, string>, file?: { name: string; content: string }) {
  const boundary = '----agentic-test';
  const parts = Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  if (file) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${file.name}"\r\nContent-Type: text/markdown\r\n\r\n${file.content}\r\n`);
  return { payload: `${parts.join('')}--${boundary}--\r\n`, headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function seedProject(id: string): Promise<string> {
  const dir = join(runRoot, id);
  const taskDir = join(dir, 'tasks', 'T-001', 'run-1');
  await mkdir(taskDir, { recursive: true });
  await writeFile(join(taskDir, 'plan.md'), '# the plan');
  await writeFile(join(dir, 'report.md'), '# report');
  await writeFile(join(dir, 'state.json'), '{"secret":"not via the files API"}');
  const state: ProjectState = {
    id, status: 'running', repo: join(repoRoot, 'r'), worktree: join(dir, 'worktree'), branch: `agentic/${id}`, baseSha: 'abc', promptVersion: 'v',
    document: { name: 'prd.md', format: 'markdown', sha256: 'x', warnings: [] }, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z',
    tasks: { 'T-001': { status: 'running', attempts: 0, dir: taskDir }, 'T-002': { status: 'pending', attempts: 0 }, 'T-003': { status: 'pending', attempts: 0 } },
    invocations: [{ command: 'analyze', runId: id, startedAt: 'x', finishedAt: 'y', costUsd: 0.3 }, { command: 'run', runId: 'run-1', startedAt: 'z' }],
  };
  await store.saveState(dir, state);
  await store.saveBacklog(dir, id, sampleBacklog());
  await store.appendEvent(dir, { projectId: id, runId: 'run-1', taskId: 'T-001', type: 'agent.finished', data: { role: 'planner', costUsd: 0.25 }, at: '2026-10-20T00:00:01Z' });
  return dir;
}

test('rejects requests without the token (health stays open)', { skip }, async () => {
  assert.equal((await app.inject({ url: '/api/projects' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/projects', headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/health' })).statusCode, 200);
  assert.equal((await app.inject({ url: `/api/projects?token=${TOKEN}` })).statusCode, 200);
});

test('lists and details projects with live spend and traceability', { skip }, async () => {
  await seedProject('proj-api1');
  const list = (await app.inject({ url: '/api/projects', headers: auth })).json() as { id: string; costUsd: number; tasks: { total: number; running: number } }[];
  const row = list.find(p => p.id === 'proj-api1')!;
  assert.equal(row.tasks.total, 3);
  assert.equal(row.tasks.running, 1);
  assert.ok(Math.abs(row.costUsd - 0.55) < 1e-9, `finished 0.30 + in-progress 0.25, got ${row.costUsd}`);
  const detail = (await app.inject({ url: '/api/projects/proj-api1', headers: auth })).json() as { backlog: { summary: string }; traceability: { id: string; status: string }[] };
  assert.equal(detail.backlog.summary, 'A sample project.');
  assert.deepEqual(detail.traceability.map(t => t.id), ['REQ-001', 'REQ-002']);
  assert.equal((await app.inject({ url: '/api/projects/proj-nope', headers: auth })).statusCode, 404);
});

test('serves task artifacts and allow-listed project files, never anything else', { skip }, async () => {
  await seedProject('proj-api2');
  const files = (await app.inject({ url: '/api/projects/proj-api2/tasks/T-001/files', headers: auth })).json() as { name: string }[];
  assert.deepEqual(files.map(f => f.name), ['plan.md']);
  assert.equal((await app.inject({ url: '/api/projects/proj-api2/tasks/T-001/files/plan.md', headers: auth })).body, '# the plan');
  assert.equal((await app.inject({ url: '/api/projects/proj-api2/files/report.md', headers: auth })).body, '# report');
  for (const url of ['/api/projects/proj-api2/files/state.json', '/api/projects/proj-api2/tasks/T-001/files/..%2F..%2F..%2Fstate.json', '/api/projects/proj-api2/tasks/T-001/files/.%2E']) {
    assert.equal((await app.inject({ url, headers: auth })).statusCode, 404, url);
  }
});

test('creating a project validates input and starts a durable workflow', { skip }, async () => {
  const repo = await gitRepo(join(repoRoot, 'my-repo'));
  assert.match((await app.inject({ method: 'POST', url: '/api/projects', ...multipart({ repo: join(repoRoot, 'missing') }, { name: 'prd.md', content: '# PRD' }) })).body, /repo: /, 'a bad repo is rejected up front');
  const noFile = multipart({ repo });
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', ...noFile })).statusCode, 400);
  const badType = multipart({ repo }, { name: 'spec.pages', content: 'x' });
  assert.match((await app.inject({ method: 'POST', url: '/api/projects', ...badType })).body, /Unsupported document type/);
  const outside = multipart({ repo: '/etc' }, { name: 'prd.md', content: '# PRD' });
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', ...outside })).statusCode, 403);
  const badConfig = multipart({ repo, config: '{"maxRepairs": 99}' }, { name: 'prd.md', content: '# PRD' });
  assert.match((await app.inject({ method: 'POST', url: '/api/projects', ...badConfig })).body, /invalid config/);

  const ok = multipart({ repo }, { name: 'prd.md', content: '# PRD' });
  const res = await app.inject({ method: 'POST', url: '/api/projects', ...ok });
  assert.equal(res.statusCode, 201, res.body);
  const { id } = res.json() as { id: string };
  const description = await env.client.workflow.getHandle(id).describe();
  assert.equal(description.type, 'projectWorkflow');
  const history = await env.client.workflow.getHandle(id).fetchHistory();
  const payload = history.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0]?.data;
  const input = JSON.parse(Buffer.from(payload!).toString()) as { repo: string; document: string };
  assert.equal(input.repo, repo);
  assert.match(input.document, /uploads\/[0-9a-f]+-prd\.md$/);

  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${id}/approve`, headers: auth, payload: { answers: { 'Q-001': 'yes', 'Q-002': '  ' } } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${id}/pause`, headers: auth })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${id}/cancel`, headers: auth })).statusCode, 200);
});

test('streams events over SSE as they are written', { skip, timeout: 30_000 }, async () => {
  await seedProject('proj-api3');
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const controller = new AbortController();
  const res = await fetch(`${address}/api/stream?project=proj-api3&token=${TOKEN}`, { signal: controller.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  try {
    const reader = res.body!.getReader();
    // NOTIFY delivery is asynchronous: the seed's own event may still arrive first, so read until ours shows up.
    const received = (async () => {
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += new TextDecoder().decode(value);
        const events = buffer.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)) as { projectId: string; type: string; taskId: string });
        const ours = events.find(e => e.type === 'task.status');
        if (ours) return ours;
      }
    })();
    await store.appendEvent(join(runRoot, 'proj-api3'), { projectId: 'proj-api3', taskId: 'T-002', type: 'task.status', data: { status: 'running' }, at: '2026-10-20T00:00:02Z' });
    const event = await received;
    assert.deepEqual([event.projectId, event.type, event.taskId], ['proj-api3', 'task.status', 'T-002']);
  } finally {
    controller.abort();
  }
});

test('guiding an escalated task validates the answer and needs a running workflow', { skip }, async () => {
  await seedProject('proj-api4');
  const guide = (taskId: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/projects/proj-api4/tasks/${taskId}/guide`, headers: auth, payload: payload as object });
  assert.equal((await guide('T-001', { action: 'merge' })).statusCode, 400);
  assert.match((await guide('T-001', { action: 'retry', guidance: '  ' })).body, /retrying needs guidance/);
  assert.equal((await guide('T-001', { action: 'retry', guidance: 'x'.repeat(8_001) })).statusCode, 400);
  assert.equal((await guide('T-404', { action: 'skip' })).statusCode, 404);
  assert.equal((await guide('T-001', { action: 'retry', guidance: 'use EUR' })).statusCode, 409, 'seeded project has no workflow');
});

test('rerun is refused for projects that are still active', { skip }, async () => {
  await seedProject('proj-api5'); // status running
  const res = await app.inject({ method: 'POST', url: '/api/projects/proj-api5/rerun', headers: auth });
  assert.equal(res.statusCode, 409);
  assert.match(res.body, /running project cannot be run again/);
});

test('projects can be created from JSON (automation intake)', { skip }, async () => {
  const repo = await gitRepo(join(repoRoot, 'json-repo'));
  const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: payload as object });
  assert.equal((await post({ repo })).statusCode, 400);
  assert.match((await post({ repo, document: { name: 'x.md', content: 'x', encoding: 'hex' } })).body, /encoding must be/);
  assert.match((await post({ repo, document: { name: 'x.exe', content: 'x' } })).body, /Unsupported document type/);
  const res = await post({ repo, config: { maxRepairs: 1 }, document: { name: 'prd.md', content: Buffer.from('# PRD\n').toString('base64'), encoding: 'base64' } });
  assert.equal(res.statusCode, 201, res.body);
  const { id } = res.json() as { id: string };
  const history = await env.client.workflow.getHandle(id).fetchHistory();
  const input = JSON.parse(Buffer.from(history.events![0].workflowExecutionStartedEventAttributes!.input!.payloads![0].data!).toString()) as { document: string; config: { maxRepairs: number } };
  assert.equal(input.config.maxRepairs, 1);
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(input.document, 'utf8'), '# PRD\n');
  await env.client.workflow.getHandle(id).terminate();
});
