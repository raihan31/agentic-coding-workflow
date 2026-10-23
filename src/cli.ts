import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { stopContainers } from './container.js';
import { removeWorktree } from './git.js';
import { createLogger } from './log.js';
import { abortAll, AbortedError } from './process.js';
import { analyzeProject, readProject, runProject, traceability } from './project.js';
import { createStore } from './store.js';
import { initTelemetry, shutdownTelemetry } from './telemetry.js';
import { runWorkflow } from './workflow.js';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const USAGE = `Usage:
  npm start -- run --repo <git-repo> --requirement <file.md> [--config <workflow.json>] [--plan-only | --plan <plan.md>] [--runs-dir <dir>]
  npm start -- clean [--older-than-days 7 | --all] [--purge] [--runs-dir <dir>]

  npm start -- project analyze --repo <git-repo> --document <brd|prd|srs.(md|pdf|docx|txt)> [--config <workflow.json>] [--auto-run]
  npm start -- project run --project <runs/proj-xxxx> [--config <workflow.json>]
  npm start -- project status --project <runs/proj-xxxx> | --id <proj-xxxx>
  npm start -- project deliver --project <runs/proj-xxxx> | --id <proj-xxxx>   (push branch + open/update PR per config.delivery)

  Service mode (durable, via Temporal; start the stack and "npm run worker" first):
  npm start -- project submit --repo <git-repo> --document <file> [--config <workflow.json>]
  npm start -- project approve --id <proj-xxxx> [--answer Q-001="text" ...]
  npm start -- project pause|resume|cancel --id <proj-xxxx>
  npm start -- project rerun --id <proj-xxxx>   run a stopped project again (keeps done tasks, retries the rest)
  npm start -- project guide --id <proj-xxxx> | --project <runs/proj-xxxx> --task T-001 (--guidance "text" | --skip)
                   answer a task the manager escalated (service mode), or leave advice for the next "project run"
  npm start -- worker [--concurrency 4]
  npm start -- api [--port 8787] [--host 127.0.0.1] [--config <default workflow.json>]   (needs DATABASE_URL; serves the web UI)

  project analyze  turns the document into runs/proj-*/backlog.{json,md}; review it, answer blocking
                   questions (fill "answer" in backlog.json), then approve by running "project run"
  --auto-run       run immediately after analysis when there are no blocking questions

  --plan-only   stop after planning; review runs/run-*/plan.md, then rerun with --plan <that file>
  --purge       (clean) also delete run artifacts, not only worktrees`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string' }, requirement: { type: 'string' }, config: { type: 'string' },
    document: { type: 'string' }, project: { type: 'string' }, 'auto-run': { type: 'boolean' },
    id: { type: 'string' }, answer: { type: 'string', multiple: true }, concurrency: { type: 'string' },
    task: { type: 'string' }, guidance: { type: 'string' }, skip: { type: 'boolean' },
    port: { type: 'string' }, host: { type: 'string' },
    plan: { type: 'string' }, 'plan-only': { type: 'boolean' }, 'runs-dir': { type: 'string' },
    'older-than-days': { type: 'string' }, all: { type: 'boolean' }, purge: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  },
});
const runRoot = resolve(values['runs-dir'] ?? join(PROJECT_ROOT, 'runs'));

let signalled = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (signalled) process.exit(130);
    signalled = true;
    console.error(`Received ${signal}; stopping agents and checks (repeat to force quit)...`);
    abortAll();
    stopContainers();
    process.exitCode = 130;
  });
}

async function run(): Promise<void> {
  if (!values.repo || !values.requirement) { console.error(USAGE); process.exitCode = 2; return; }
  if (values.plan && values['plan-only']) throw new Error('--plan and --plan-only are mutually exclusive');
  const config = await loadConfig(values.config && resolve(values.config));
  const logger = createLogger();
  if (!config.checks.length) logger.warn('no checks configured; only the LLM reviewer gates this run');
  if (config.checkRunner.type === 'host') logger.warn('checks run on the host with your privileges (checkRunner.type = "host")');
  if (config.agentRuntime.type === 'host') logger.warn('agents run on the host, protected only by their CLI sandboxes (agentRuntime.type = "host")');
  const result = await runWorkflow({
    repo: values.repo, requirement: await readFile(resolve(values.requirement), 'utf8'), config, runRoot, logger,
    plan: values.plan && await readFile(resolve(values.plan), 'utf8'), planOnly: values['plan-only'],
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'changes_required' || result.status === 'budget_exceeded') process.exitCode = 1;
}

async function project(sub: string | undefined): Promise<void> {
  const logger = createLogger();
  const config = values.config ? await loadConfig(resolve(values.config)) : undefined;
  const projectDir = values.project ?? (values.id && join(runRoot, values.id));
  if (sub && ['submit', 'approve', 'pause', 'resume', 'cancel', 'rerun'].includes(sub)) return await service(sub, config);
  if (sub === 'guide') {
    if (!values.task || (!values.skip && !values.guidance?.trim()) || (!values.id && !values.project)) { console.error(USAGE); process.exitCode = 2; return; }
    const guide = { taskId: values.task, action: values.skip ? 'skip' as const : 'retry' as const, ...(values.guidance?.trim() ? { guidance: values.guidance.trim() } : {}) };
    if (values.id) {
      const { connectClient, guideProjectTask } = await import('./temporal/client.js');
      await guideProjectTask(await connectClient(), values.id, guide);
    } else {
      if (values.skip) throw new Error('--skip only applies to a running service-mode project; locally, edit the backlog instead');
      const { guideTask } = await import('./project.js');
      const store = await createStore(logger);
      try { await guideTask(resolve(values.project!), undefined, guide, store); } finally { await store.close(); }
    }
    console.log(JSON.stringify({ ok: true, ...guide }, null, 2));
    return;
  }
  if (sub === 'analyze') {
    if (!values.repo || !values.document) { console.error(USAGE); process.exitCode = 2; return; }
    const state = await analyzeProject({ repo: values.repo, document: resolve(values.document), config: config ?? await loadConfig(), runRoot, logger });
    const dir = join(runRoot, state.id);
    if (values['auto-run'] && state.status === 'backlog_ready') return await printRun(await runProject({ projectDir: dir, logger }));
    console.log(JSON.stringify({ project: dir, status: state.status, tasks: Object.keys(state.tasks).length, backlog: join(dir, 'backlog.md'), next: state.status === 'needs_answers' ? `answer blocking questions in ${join(dir, 'backlog.json')}, then: npm start -- project run --project ${dir}` : `review the backlog, then: npm start -- project run --project ${dir}` }, null, 2));
    if (state.status === 'failed' || state.status === 'budget_exceeded') process.exitCode = 1;
  } else if (sub === 'run') {
    if (!projectDir) { console.error(USAGE); process.exitCode = 2; return; }
    const store = await createStore(logger);
    try { await printRun(await runProject({ projectDir, config, logger, store })); } finally { await store.close(); }
  } else if (sub === 'deliver') {
    if (!projectDir) { console.error(USAGE); process.exitCode = 2; return; }
    const { deliverProject } = await import('./delivery.js');
    const store = await createStore(logger);
    try {
      const delivered = await deliverProject(projectDir, store);
      console.log(JSON.stringify(delivered ?? { skipped: 'delivery.push is false in the project config' }, null, 2));
    } finally { await store.close(); }
  } else if (sub === 'status') {
    if (!projectDir) { console.error(USAGE); process.exitCode = 2; return; }
    const { state, backlog } = await readProject(projectDir);
    const trace = backlog ? traceability(backlog, state) : [];
    const { connectClient, projectView } = await import('./temporal/client.js');
    const workflow = values.id ? await connectClient().then(c => projectView(c, state.id)).catch(() => undefined) : undefined;
    console.log(JSON.stringify({
      id: state.id, status: state.status, workflow, branch: state.branch, error: state.error,
      tasks: Object.fromEntries(Object.entries(state.tasks).map(([id, t]) => [id, t.status])),
      requirements: Object.fromEntries(trace.map(r => [r.id, r.status])),
      costUsd: state.invocations.reduce((s, i) => s + (i.costUsd ?? 0), 0),
    }, null, 2));
  } else { console.error(USAGE); process.exitCode = 2; }
}

async function service(sub: string, config: Awaited<ReturnType<typeof loadConfig>> | undefined): Promise<void> {
  const { connectClient, submitProject, approveProject, pauseProject, resumeProject, cancelProject } = await import('./temporal/client.js');
  const client = await connectClient();
  try {
    if (sub === 'submit') {
      if (!values.repo || !values.document) { console.error(USAGE); process.exitCode = 2; return; }
      const { randomBytes } = await import('node:crypto');
      const projectId = `proj-${randomBytes(4).toString('hex')}`;
      await submitProject(client, { projectId, repo: resolve(values.repo), document: resolve(values.document), runRoot, config: config ?? await loadConfig() });
      console.log(JSON.stringify({ project: projectId, dir: join(runRoot, projectId), temporalUi: `http://localhost:8233/namespaces/default/workflows/${projectId}`, next: `review ${join(runRoot, projectId, 'backlog.md')} when analysis finishes, then: npm start -- project approve --id ${projectId}` }, null, 2));
      return;
    }
    if (!values.id) { console.error(USAGE); process.exitCode = 2; return; }
    if (sub === 'approve') {
      const answers = Object.fromEntries((values.answer ?? []).map(a => {
        const at = a.indexOf('=');
        if (at < 1) throw new Error(`--answer must look like Q-001="text" (got ${a})`);
        return [a.slice(0, at), a.slice(at + 1)];
      }));
      await approveProject(client, values.id, { answers });
    } else if (sub === 'rerun') {
      const { resumeProjectRun } = await import('./temporal/client.js');
      await resumeProjectRun(client, join(runRoot, values.id));
    } else if (sub === 'pause') await pauseProject(client, values.id);
    else if (sub === 'resume') await resumeProject(client, values.id);
    else if (sub === 'cancel') await cancelProject(client, values.id);
    console.log(JSON.stringify({ project: values.id, sent: sub }));
  } finally {
    await client.connection.close();
  }
}

async function worker(): Promise<void> {
  const { runWorker } = await import('./temporal/worker.js');
  const { temporalAddress, temporalNamespace } = await import('./temporal/client.js');
  const logger = createLogger();
  const store = await createStore(logger);
  try {
    await runWorker({ address: temporalAddress(), namespace: temporalNamespace(), store, logger, concurrency: Number(values.concurrency ?? 4) });
  } finally {
    await store.close();
  }
}

async function api(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('The API reads projects from Postgres: set DATABASE_URL (e.g. postgres://agentic:agentic@localhost:55432/agentic)');
  const [{ buildServer }, { PgStore }, { connectClient }, { existsSync }] = await Promise.all([import('./api/server.js'), import('./store.js'), import('./temporal/client.js'), import('node:fs')]);
  const logger = createLogger();
  const store = await PgStore.connect(url);
  const temporal = await connectClient().catch(error => { logger.warn({ err: String(error) }, 'Temporal unavailable; project actions are disabled'); return undefined; });
  const webDist = join(PROJECT_ROOT, 'web', 'dist');
  const app = await buildServer({
    store, temporal, logger, runRoot, uploadsDir: join(runRoot, 'uploads'),
    defaultConfig: await loadConfig(values.config && resolve(values.config)),
    token: process.env.AGENTIC_API_TOKEN || undefined,
    repoRoots: process.env.AGENTIC_REPO_ROOTS?.split(':').filter(Boolean).map(r => resolve(r)),
    webDist: existsSync(join(webDist, 'index.html')) ? webDist : undefined,
  });
  const host = values.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost' && !process.env.AGENTIC_API_TOKEN) throw new Error('Refusing to listen beyond localhost without AGENTIC_API_TOKEN: the API can start agents on repositories');
  const address = await app.listen({ host, port: Number(values.port ?? 8787) });
  logger.info({ address, ui: Boolean(existsSync(join(webDist, 'index.html'))), auth: Boolean(process.env.AGENTIC_API_TOKEN) }, `API listening on ${address}`);
  await new Promise(done => { process.once('SIGINT', done); process.once('SIGTERM', done); });
  await app.close();
  await store.close();
  await temporal?.connection.close();
}

async function printRun(state: Awaited<ReturnType<typeof runProject>>): Promise<void> {
  const counts = Object.values(state.tasks).reduce<Record<string, number>>((acc, t) => ({ ...acc, [t.status]: (acc[t.status] ?? 0) + 1 }), {});
  console.log(JSON.stringify({ project: state.id, status: state.status, branch: state.branch, worktree: state.worktree, tasks: counts, integration: state.integration, report: join(state.worktree, '..', 'report.md') }, null, 2));
  if (state.status !== 'completed') process.exitCode = 1;
}

async function clean(): Promise<void> {
  const maxAgeMs = Number(values['older-than-days'] ?? 7) * 86_400_000;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new Error('--older-than-days must be a non-negative number');
  const entries = await readdir(runRoot).catch(() => [] as string[]);
  for (const name of entries.filter(n => n.startsWith('run-') || n.startsWith('proj-'))) {
    const runDir = join(runRoot, name);
    if (!values.all && Date.now() - (await stat(runDir)).mtimeMs < maxAgeMs) continue;
    try {
      // Removing a project worktree keeps its branch (the deliverable).
      const meta = JSON.parse(await readFile(join(runDir, name.startsWith('proj-') ? 'state.json' : 'metadata.json'), 'utf8')) as { repo: string; worktree: string };
      if (await stat(meta.worktree).then(() => true, () => false)) await removeWorktree(meta.repo, meta.worktree);
    } catch (error) {
      console.error(`${name}: could not remove worktree: ${String(error)}`);
      continue;
    }
    if (values.purge) await rm(runDir, { recursive: true, force: true });
    console.error(`${name}: ${values.purge ? 'purged' : 'worktree removed'}`);
  }
}

async function main(): Promise<void> {
  if (values.help) { console.log(USAGE); return; }
  const command = positionals[0] ?? 'run';
  if (command === 'run') {
    const { version } = JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version: string };
    await initTelemetry(version);
    try { await run(); } finally { await shutdownTelemetry(); }
  } else if (command === 'project') {
    const { version } = JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version: string };
    await initTelemetry(version);
    try { await project(positionals[1]); } finally { await shutdownTelemetry(); }
  } else if (command === 'worker') {
    const { version } = JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version: string };
    await initTelemetry(version);
    try { await worker(); } finally { await shutdownTelemetry(); }
  } else if (command === 'api') await api();
  else if (command === 'clean') await clean();
  else { console.error(USAGE); process.exitCode = 2; }
}

main().catch(error => {
  console.error(error instanceof AbortedError ? 'Run aborted.' : error);
  process.exitCode = signalled ? 130 : 1;
});
