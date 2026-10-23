import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '../src/adapters.js';
import type { Backlog } from '../src/backlog.js';
import { HostCheckRunner } from '../src/checks.js';
import { parseConfig } from '../src/config.js';
import { silentLogger } from '../src/log.js';
import { execute } from '../src/process.js';
import { analyzeProject, projectPaths, readProject, runProject, taskBrief, type ProjectDeps } from '../src/project.js';
import { sampleBacklog } from './fixtures.js';

const PASS = JSON.stringify({ decision: 'pass', summary: 'ok', findings: [] });
const exists = (p: string) => access(p).then(() => true, () => false);
const git = async (args: string[], cwd: string) => {
  const r = await execute('git', args, cwd);
  assert.equal(r.code, 0, r.stderr);
  return r.stdout.trim();
};

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'agentic-proj-repo-'));
  await git(['init', '-q', '-b', 'main'], repo);
  // The "check" fails while any file contains the word BROKEN.
  await writeFile(join(repo, 'check.mjs'), `import { readdirSync, readFileSync } from 'node:fs';
for (const f of readdirSync('.')) if (f.endsWith('.txt') && readFileSync(f, 'utf8').includes('BROKEN')) { console.error(f + ' is BROKEN'); process.exit(1); }\n`);
  await git(['add', '.'], repo);
  await git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], repo);
  return repo;
}

const agent = (fn: (cwd: string, prompt: string, phase: string) => string | Promise<string>, prompts: string[] = []): Agent =>
  ({ async run(prompt, cwd, _outDir, phase) { prompts.push(prompt); return { output: await fn(cwd, prompt, phase), costUsd: 0.01 }; } });
const taskId = (prompt: string) => /## Task (T-[\d.]+):/.exec(prompt)?.[1] ?? 'unknown';
const decide = (...decisions: object[]) => { let i = 0; const prompts: string[] = []; return { prompts, agent: agent(() => JSON.stringify(decisions[Math.min(i++, decisions.length - 1)]), prompts) }; };
/** Developer that writes <task>.txt; `broken` tasks get content the check rejects. */
const developer = (broken: Set<string> = new Set(), prompts: string[] = []) =>
  agent(async (cwd, prompt) => { const id = taskId(prompt); await writeFile(join(cwd, `${id}.txt`), broken.has(id) ? 'BROKEN' : `done ${id}`); return 'ok'; }, prompts);

async function setup(backlog: Backlog = sampleBacklog()) {
  const repo = await makeRepo();
  const runRoot = await mkdtemp(join(tmpdir(), 'agentic-proj-runs-'));
  const document = join(runRoot, 'prd.md');
  await writeFile(document, '# PRD\n\nREQ-001 core feature (must).');
  const config = parseConfig({ checkRunner: { type: 'host', acknowledgeUnsafe: true }, agentRuntime: { type: 'host', acknowledgeUnsafe: true }, checks: [['node', 'check.mjs']], maxRepairs: 1 });
  const analystPrompts: string[] = [];
  const deps: ProjectDeps = {
    logger: silentLogger, checkRunner: new HostCheckRunner(),
    analyst: agent(() => JSON.stringify(backlog), analystPrompts),
    planner: agent((_cwd, prompt) => `plan for ${taskId(prompt)}`),
    reviewer: agent(() => PASS),
  };
  const state = await analyzeProject({ ...deps, repo, document, config, runRoot });
  return { repo, runRoot, config, deps, state, dir: join(runRoot, state.id), analystPrompts };
}

test('analyze produces a validated backlog on a new branch and stops at the approval gate', async () => {
  const { repo, state, dir, analystPrompts } = await setup();
  assert.equal(state.status, 'backlog_ready');
  assert.deepEqual(Object.keys(state.tasks), ['T-001', 'T-002', 'T-003']);
  assert.match(await readFile(join(dir, 'backlog.md'), 'utf8'), /### T-001/);
  assert.equal(await readFile(projectPaths(dir).document, 'utf8'), '# PRD\n\nREQ-001 core feature (must).');
  assert.match(analystPrompts[0], new RegExp(projectPaths(dir).document.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(await git(['branch', '--list', state.branch], repo), `+ ${state.branch}`); // checked out in the project worktree
});

test('run executes tasks in dependency order, one commit each, then integration checks and traceability', async () => {
  const { deps, dir, state } = await setup();
  const devPrompts: string[] = [];
  const result = await runProject({ ...deps, projectDir: dir, developer: developer(new Set(), devPrompts) });
  assert.equal(result.status, 'completed');
  assert.deepEqual(devPrompts.map(taskId), ['T-001', 'T-002', 'T-003']);
  assert.match(devPrompts[1], /Already completed[\s\S]*T-001/);
  assert.match(devPrompts[0], /Planned for later tasks[\s\S]*T-002/);
  const log = (await git(['log', '--format=%s', `${state.baseSha}..${state.branch}`], state.worktree)).split('\n');
  assert.deepEqual(log, ['T-003: title T-003', 'T-002: title T-002', 'T-001: title T-001']);
  const body = await git(['log', '-1', '--format=%B', result.tasks['T-001'].commit!], state.worktree);
  assert.match(body, /Requirements: REQ-001/);
  assert.equal(result.integration?.passed, true);
  const trace = JSON.parse(await readFile(join(dir, 'traceability.json'), 'utf8')) as { id: string; status: string }[];
  assert.deepEqual(trace.map(r => [r.id, r.status]), [['REQ-001', 'implemented'], ['REQ-002', 'implemented']]);
  assert.match(await readFile(join(dir, 'report.md'), 'utf8'), /# proj-[0-9a-f]+: completed/);
  assert.equal(await exists(join(dir, 'run.lock')), false);
});

test('a failing task blocks its dependents, others continue, and a re-run resumes without redoing work', async () => {
  const { deps, dir, state } = await setup();
  const first = await runProject({ ...deps, projectDir: dir, developer: developer(new Set(['T-001'])), manager: decide({ decision: 'skip', rationale: 'needs a design decision first' }).agent });
  assert.equal(first.status, 'partial');
  assert.match(first.tasks['T-001'].error!, /after 2 attempts \(manager: needs a design decision first\)/);
  assert.deepEqual(Object.fromEntries(Object.entries(first.tasks).map(([k, v]) => [k, v.status])), { 'T-001': 'failed', 'T-002': 'blocked', 'T-003': 'done' });
  assert.equal(first.tasks['T-001'].attempts, 2);
  assert.equal(await git(['status', '--porcelain'], state.worktree), '', 'failed task left changes behind');
  const trace = JSON.parse(await readFile(join(dir, 'traceability.json'), 'utf8')) as { id: string; status: string }[];
  assert.deepEqual(trace.map(r => r.status), ['not_implemented', 'implemented']);

  const devPrompts: string[] = [];
  const second = await runProject({ ...deps, projectDir: dir, developer: developer(new Set(), devPrompts) });
  assert.equal(second.status, 'completed');
  assert.deepEqual(devPrompts.map(taskId), ['T-001', 'T-002'], 'T-003 must not be redone');
  assert.equal(second.invocations.filter(i => i.command === 'run').length, 2);
});

test('blocking questions gate the run until answered, and answers reach the agents', async () => {
  const backlog = sampleBacklog();
  backlog.openQuestions = [{ id: 'Q-001', question: 'Which database?', context: 'assumed SQLite', blocking: true, requirementIds: ['REQ-001'] }];
  const { deps, dir, state } = await setup(backlog);
  assert.equal(state.status, 'needs_answers');
  await assert.rejects(runProject({ ...deps, projectDir: dir, developer: developer() }), /Q-001: Which database/);

  const p = projectPaths(dir);
  const edited = JSON.parse(await readFile(p.backlog, 'utf8')) as Backlog;
  edited.openQuestions[0].answer = 'PostgreSQL 16';
  await writeFile(p.backlog, JSON.stringify(edited));
  const devPrompts: string[] = [];
  const result = await runProject({ ...deps, projectDir: dir, developer: developer(new Set(), devPrompts) });
  assert.equal(result.status, 'completed');
  assert.match(devPrompts[0], /Clarifications from the product owner:\n- Which database\? → PostgreSQL 16/);
  assert.ok(result.approval?.backlogSha256);
});

test('the analyst gets one retry when its backlog is invalid', async () => {
  const bad = sampleBacklog();
  bad.tasks[1].dependsOn = ['T-404'];
  let calls = 0;
  const repo = await makeRepo();
  const runRoot = await mkdtemp(join(tmpdir(), 'agentic-proj-runs-'));
  await writeFile(join(runRoot, 'prd.md'), '# PRD');
  const prompts: string[] = [];
  const state = await analyzeProject({
    repo, runRoot, document: join(runRoot, 'prd.md'), logger: silentLogger, config: parseConfig({ agentRuntime: { type: 'host', acknowledgeUnsafe: true } }),
    checkRunner: new HostCheckRunner(), analyst: agent(() => JSON.stringify(calls++ === 0 ? bad : sampleBacklog()), prompts),
  });
  assert.equal(state.status, 'backlog_ready');
  assert.match(prompts[1], /previous backlog was rejected[\s\S]*depends on unknown task T-404/);
});

test('a second concurrent runner is refused', async () => {
  const { deps, dir } = await setup();
  await writeFile(projectPaths(dir).lock, String(process.pid)); // this process is alive
  await assert.rejects(runProject({ ...deps, projectDir: dir, developer: developer() }), /already being run by process/);
});

test('editing the backlog to add a task picks it up on the next run', async () => {
  const { deps, dir } = await setup();
  await runProject({ ...deps, projectDir: dir, developer: developer() });
  const p = projectPaths(dir);
  const edited = JSON.parse(await readFile(p.backlog, 'utf8')) as Backlog;
  edited.tasks.push({ ...edited.tasks[0], id: 'T-004', title: 'extra', dependsOn: ['T-003'] });
  await writeFile(p.backlog, JSON.stringify(edited));
  const devPrompts: string[] = [];
  const result = await runProject({ ...deps, projectDir: dir, developer: developer(new Set(), devPrompts) });
  assert.deepEqual(devPrompts.map(taskId), ['T-004']);
  assert.equal(result.tasks['T-004'].status, 'done');
  assert.equal((await readProject(dir)).state.status, 'completed');
});

test('task brief includes requirements, scope boundaries and the document path', () => {
  const b = sampleBacklog();
  const brief = taskBrief(b, b.tasks[1], [b.tasks[0]], '/x/document.md');
  assert.match(brief, /## Task T-002: title T-002/);
  assert.match(brief, /REQ-001 \(must\): Core: core feature/);
  assert.match(brief, /Planned for later tasks[\s\S]*T-003/);
  assert.match(brief, /read-only at \/x\/document\.md/);
});

test('a provider rate limit stops the project as rate_limited and the task resumes next run', async () => {
  const { RateLimitedError } = await import('../src/adapters.js');
  const { deps, dir, state } = await setup();
  let limited = true;
  const flaky = agent(async (cwd, prompt) => {
    if (limited && taskId(prompt) === 'T-002') throw new RateLimitedError('codex was rate limited: usage limit');
    await writeFile(join(cwd, `${taskId(prompt)}.txt`), 'ok');
    return 'ok';
  });
  const first = await runProject({ ...deps, projectDir: dir, developer: flaky });
  assert.equal(first.status, 'rate_limited');
  assert.equal(first.tasks['T-001'].status, 'done');
  assert.equal(first.tasks['T-002'].status, 'pending');
  assert.equal(await git(['status', '--porcelain'], state.worktree), '');
  limited = false;
  const second = await runProject({ ...deps, projectDir: dir, developer: flaky });
  assert.equal(second.status, 'completed');
});

test('answers can be applied programmatically and every step is recorded in events.jsonl', async () => {
  const { applyAnswers } = await import('../src/project.js');
  const backlog = sampleBacklog();
  backlog.openQuestions = [{ id: 'Q-001', question: 'Which DB?', context: 'x', blocking: true, requirementIds: ['REQ-001'] }];
  const { deps, dir } = await setup(backlog);
  await assert.rejects(applyAnswers(dir, { 'Q-404': 'x' }), /Unknown question Q-404/);
  assert.deepEqual(await applyAnswers(dir, { 'Q-001': 'Postgres' }), { unanswered: [] });
  assert.equal((await readProject(dir)).state.status, 'backlog_ready');
  await runProject({ ...deps, projectDir: dir, developer: developer() });
  const events = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l) as { type: string; taskId?: string; data: Record<string, unknown> });
  const types = new Set(events.map(e => e.type));
  for (const t of ['project.created', 'backlog.ready', 'backlog.answered', 'backlog.approved', 'task.status', 'agent.started', 'agent.finished', 'checks.finished', 'review.finished', 'attempt.finished', 'integration.finished', 'run.finished']) assert.ok(types.has(t), `missing event ${t}`);
  const t1 = events.filter(e => e.taskId === 'T-001' && e.type === 'task.status').map(e => e.data.status);
  assert.deepEqual(t1, ['running', 'done']);
});

test('manager retry: guidance reaches a fresh plan and attempt from a clean tree', async () => {
  const { deps, dir } = await setup();
  const devPrompts: string[] = [];
  const plannerPrompts: string[] = [];
  // T-001 only works once someone explains how.
  const dev = agent(async (cwd, prompt) => {
    const id = taskId(prompt);
    await writeFile(join(cwd, `${id}.txt`), id === 'T-001' && !prompt.includes('write the result to T-001.txt without the marker') ? 'BROKEN' : `done ${id}`);
    return 'ok';
  }, devPrompts);
  const mgr = decide({ decision: 'retry', rationale: 'the marker trips the check', guidance: 'write the result to T-001.txt without the marker' });
  const result = await runProject({ ...deps, projectDir: dir, developer: dev, manager: mgr.agent, planner: agent((_c, p) => `plan ${taskId(p)}`, plannerPrompts) });
  assert.equal(result.status, 'completed');
  assert.equal(result.tasks['T-001'].attempts, 3, 'two failed attempts, then one in the guided round');
  assert.equal(result.tasks['T-001'].interventions, 1);
  assert.deepEqual(result.tasks['T-001'].guidance?.map(g => g.from), ['manager']);
  assert.match(mgr.prompts[0], /attempt 1: checks\n- attempt 2: checks/);
  assert.match(mgr.prompts[0], /T-001\.txt is BROKEN/, 'the manager sees the last rejection');
  assert.equal(plannerPrompts.filter(p => taskId(p) === 'T-001').length, 2, 're-planned with the guidance');
  assert.match(plannerPrompts[1], /From the engineering manager: write the result/);
  const taskDir = result.tasks['T-001'].dir!;
  assert.equal(JSON.parse(await readFile(join(taskDir, 'manager-0.json'), 'utf8')).decision, 'retry');
  assert.ok(await exists(join(taskDir, 'plan-r1.md')) && await exists(join(taskDir, 'checks-2.json')), 'round artifacts are kept apart');
});

test('manager split: subtasks replace the task, inherit its links, and dependents wait for the last one', async () => {
  const { deps, dir } = await setup();
  const devPrompts: string[] = [];
  const mgr = decide({ decision: 'split', rationale: 'two concerns in one task', subtasks: [
    { title: 'model', description: 'the data model', acceptanceCriteria: ['model exists'] },
    { title: 'endpoint', description: 'the endpoint', acceptanceCriteria: ['endpoint works'] },
  ] });
  const result = await runProject({ ...deps, projectDir: dir, developer: developer(new Set(['T-001']), devPrompts), manager: mgr.agent });
  assert.equal(result.status, 'completed');
  assert.deepEqual(devPrompts.map(taskId), ['T-001', 'T-001', 'T-001.1', 'T-001.2', 'T-002', 'T-003']);
  const { backlog } = await readProject(dir);
  assert.deepEqual(backlog!.tasks.map(t => [t.id, t.dependsOn.join(','), t.splitFrom ?? '']), [['T-001.1', '', 'T-001'], ['T-001.2', 'T-001.1', 'T-001'], ['T-002', 'T-001.2', ''], ['T-003', '', '']]);
  assert.deepEqual(backlog!.tasks[0].requirementIds, ['REQ-001']);
  assert.equal(result.tasks['T-001'], undefined);
  const trace = JSON.parse(await readFile(join(dir, 'traceability.json'), 'utf8')) as { id: string; status: string }[];
  assert.equal(trace[0].status, 'implemented');
});

test('manager escalation: the local run ends needing attention; human guidance carries into the next run', async () => {
  const { guideTask } = await import('../src/project.js');
  const { FileStore } = await import('../src/store.js');
  const { deps, dir } = await setup();
  const mgr = decide({ decision: 'escalate', rationale: 'ambiguous', question: 'Should totals include tax?' });
  const first = await runProject({ ...deps, projectDir: dir, developer: developer(new Set(['T-001'])), manager: mgr.agent });
  assert.equal(first.status, 'needs_attention');
  assert.deepEqual([first.tasks['T-001'].status, first.tasks['T-001'].question], ['needs_attention', 'Should totals include tax?']);
  assert.equal(first.tasks['T-002'].status, 'blocked');

  await guideTask(dir, undefined, { taskId: 'T-001', action: 'retry', guidance: 'Yes, 20% VAT' }, new FileStore());
  const devPrompts: string[] = [];
  const second = await runProject({ ...deps, projectDir: dir, developer: developer(new Set(), devPrompts), manager: mgr.agent });
  assert.equal(second.status, 'completed');
  assert.match(devPrompts[0], /From the product owner: Yes, 20% VAT/);
  assert.equal(second.tasks['T-001'].question, undefined);
});

test('the manager is bounded: interventions run out, and invalid decisions fall back to skip', async () => {
  const { deps, dir, state } = await setup();
  const always = decide({ decision: 'retry', rationale: 'try again', guidance: 'try harder' });
  const cfgPath = projectPaths(dir).config;
  const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
  await writeFile(cfgPath, JSON.stringify({ ...cfg, manager: { ...cfg.manager, maxInterventions: 1 } }));
  const first = await runProject({ ...deps, projectDir: dir, developer: developer(new Set(['T-001'])), manager: always.agent });
  assert.equal(always.prompts.length, 1, 'one decision, then the limit');
  assert.match(first.tasks['T-001'].error!, /after 4 attempts \(manager: the manager already intervened 1 time on this task\)/);
  assert.equal(await git(['status', '--porcelain'], state.worktree), '');

  const bad = decide({ decision: 'split', rationale: 'x', subtasks: [] });
  const second = await runProject({ ...deps, projectDir: dir, developer: developer(new Set(['T-001'])), manager: bad.agent });
  assert.equal(bad.prompts.length, 2, 'one corrective retry');
  assert.match(bad.prompts[1], /previous decision was rejected \(split needs 2 to \d subtasks, got 0\)/);
  assert.match(second.tasks['T-001'].error!, /could not reach a valid decision/);
});

test('a project whose analysis cannot start is still recorded, with the reason', async () => {
  const { recordFailedStart } = await import('../src/project.js');
  const { FileStore } = await import('../src/store.js');
  const runRoot = await mkdtemp(join(tmpdir(), 'agentic-proj-runs-'));
  await recordFailedStart({ id: 'proj-nocreds', repo: '/repos/app', document: '/uploads/0123456789ab-spec.docx', runRoot }, new Error('Containerized Claude needs CLAUDE_CODE_OAUTH_TOKEN'), new FileStore());
  const raw = JSON.parse(await readFile(join(runRoot, 'proj-nocreds', 'state.json'), 'utf8'));
  assert.deepEqual([raw.status, raw.document.name, raw.document.format], ['failed', 'spec.docx', 'docx']);
  assert.match(raw.error, /CLAUDE_CODE_OAUTH_TOKEN/);
  const events = (await readFile(join(runRoot, 'proj-nocreds', 'events.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l).type);
  assert.deepEqual(events, ['project.status']);
});
