import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Client as TemporalClient } from '@temporalio/client';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type pg from 'pg';
import { parseBacklog, type Backlog } from '../backlog.js';
import { parseConfig, type Config } from '../config.js';
import { documentFormat } from '../documents.js';
import { assertCleanRepoRoot } from '../git.js';
import type { Logger } from '../log.js';
import { traceability, type ProjectState } from '../project.js';
import { EVENTS_CHANNEL, type PgStore } from '../store.js';
import { approveProject, cancelProject, guideProjectTask, pauseProject, projectView, resumeProject, resumeProjectRun, submitProject } from '../temporal/client.js';

export interface ApiOptions {
  store: PgStore;
  runRoot: string;
  uploadsDir: string;
  defaultConfig: Config;
  logger: Logger;
  temporal?: TemporalClient;
  /** When set, every /api request needs `Authorization: Bearer <token>` (or `?token=` for EventSource). */
  token?: string;
  /** When set, new projects may only target repositories under these directories. */
  repoRoots?: string[];
  /** Built web UI to serve at /. */
  webDist?: string;
}

interface ProjectRow { id: string; status: string; repo: string; branch: string; dir: string; document_name: string | null; created_at: Date; updated_at: Date; state: ProjectState; backlog: Backlog | null; }
interface EventRow { id: string; project_id: string; run_id: string | null; task_id: string | null; type: string; data: Record<string, unknown>; at: Date; }

const FILE_NAME = /^[A-Za-z0-9._-]+$/;
const PROJECT_FILES = new Set(['report.md', 'backlog.md', 'integration-checks.json', 'traceability.json']);
const MAX_FILE_BYTES = 2_000_000;
const RERUNNABLE = new Set(['failed', 'partial', 'rate_limited', 'budget_exceeded', 'cancelled', 'needs_attention', 'integration_failed']);

/**
 * Finished invocations carry their final cost (gateway-measured when available); for runs still in progress,
 * add what agents have reported so far so the UI shows spend as it happens.
 */
type LiveCost = Map<string, number>; // `${projectId}|${runId}` -> agent-reported USD
const spend = (row: ProjectRow, live: LiveCost) => row.state.invocations.reduce((sum, i) =>
  sum + (i.finishedAt ? i.costUsd ?? 0 : live.get(`${row.id}|${i.runId}`) ?? 0), 0);

const summarize = (row: ProjectRow, live: LiveCost) => {
  const tasks = Object.values(row.state.tasks);
  const count = (s: string) => tasks.filter(t => t.status === s).length;
  return {
    id: row.id, status: row.status, repo: row.repo, branch: row.branch, document: row.document_name, createdAt: row.created_at, updatedAt: row.updated_at,
    tasks: { total: tasks.length, done: count('done'), running: count('running'), failed: count('failed'), blocked: count('blocked'), pending: count('pending'), attention: count('needs_attention') },
    costUsd: spend(row, live),
  };
};
const toEvent = (r: EventRow) => ({ id: Number(r.id), projectId: r.project_id, runId: r.run_id, taskId: r.task_id, type: r.type, data: r.data, at: r.at });

/** One LISTEN connection for the whole process; SSE clients subscribe in memory. */
async function eventBus(store: PgStore, log: Logger): Promise<{ bus: EventEmitter; close: () => Promise<void> }> {
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const client: pg.PoolClient = await store.pool.connect();
  client.on('notification', async n => {
    try {
      const { id } = JSON.parse(n.payload ?? '{}') as { id: string };
      const { rows } = await store.pool.query<EventRow>('SELECT * FROM events WHERE id = $1', [id]);
      if (rows[0]) bus.emit('event', toEvent(rows[0]));
    } catch (error) { log.warn({ err: error }, 'event fan-out failed'); }
  });
  await client.query(`LISTEN ${EVENTS_CHANNEL}`);
  return { bus, close: async () => { await client.query(`UNLISTEN ${EVENTS_CHANNEL}`).catch(() => {}); client.release(); } };
}

export async function buildServer(opts: ApiOptions): Promise<FastifyInstance> {
  // Request logs at warn: the UI polls and streams, and per-request info lines would drown the run logs.
  // forceCloseConnections: open SSE streams (browser tabs) must not hold up shutdown.
  const app = Fastify({ loggerInstance: opts.logger.child({ component: 'http' }, { level: 'warn' }) as FastifyBaseLogger, bodyLimit: 1_000_000, forceCloseConnections: true });
  await app.register(import('@fastify/multipart'), { limits: { fileSize: 20_000_000, files: 1 } });
  const { bus, close } = await eventBus(opts.store, opts.logger);
  app.addHook('onClose', close);
  const db = opts.store.pool;

  app.addHook('onRequest', async (req, reply) => {
    if (!opts.token || !req.url.startsWith('/api/') || req.url === '/api/health') return;
    const header = req.headers.authorization;
    const query = (req.query as { token?: string } | undefined)?.token;
    if (header !== `Bearer ${opts.token}` && query !== opts.token) return reply.code(401).send({ error: 'unauthorized' });
  });

  const liveCost = async (ids: string[]): Promise<LiveCost> => {
    const { rows } = await db.query<{ project_id: string; run_id: string; usd: string }>(
      `SELECT project_id, run_id, sum((data->>'costUsd')::numeric) AS usd FROM events
       WHERE type = 'agent.finished' AND project_id = ANY($1) AND data ? 'costUsd' GROUP BY 1, 2`, [ids]);
    return new Map(rows.map(r => [`${r.project_id}|${r.run_id}`, Number(r.usd)]));
  };
  const project = async (id: string, reply: FastifyReply): Promise<ProjectRow | undefined> => {
    const { rows } = await db.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [id]);
    if (!rows[0]) { await reply.code(404).send({ error: `project ${id} not found` }); return undefined; }
    return rows[0];
  };
  const needTemporal = (reply: FastifyReply): TemporalClient | undefined => {
    if (!opts.temporal) { void reply.code(503).send({ error: 'Temporal is not connected; start the stack and restart the API' }); return undefined; }
    return opts.temporal;
  };

  app.get('/api/health', async () => ({ ok: true, temporal: Boolean(opts.temporal), auth: Boolean(opts.token) }));

  app.get('/api/projects', async () => {
    const { rows } = await db.query<ProjectRow>('SELECT * FROM projects ORDER BY updated_at DESC LIMIT 200');
    const live = await liveCost(rows.map(r => r.id));
    return rows.map(r => summarize(r, live));
  });

  app.get('/api/projects/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const row = await project(req.params.id, reply);
    if (!row) return;
    const workflow = opts.temporal ? await projectView(opts.temporal, row.id).catch(() => undefined) : undefined;
    return {
      ...summarize(row, await liveCost([row.id])), state: row.state, backlog: row.backlog, workflow,
      traceability: row.backlog ? traceability(row.backlog, row.state) : [],
    };
  });

  app.get('/api/projects/:id/events', async (req: FastifyRequest<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>) => {
    const { rows } = await db.query<EventRow>(
      'SELECT * FROM events WHERE project_id = $1 AND id > $2 ORDER BY id LIMIT $3',
      [req.params.id, Number(req.query.after ?? 0), Math.min(Number(req.query.limit ?? 500), 2_000)],
    );
    return rows.map(toEvent);
  });

  // Server-sent events: everything, or one project's events.
  app.get('/api/stream', (req: FastifyRequest<{ Querystring: { project?: string } }>, reply) => {
    const only = req.query.project;
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    reply.raw.write(': connected\n\n');
    const onEvent = (e: ReturnType<typeof toEvent>) => { if (!only || e.projectId === only) reply.raw.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`); };
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    bus.on('event', onEvent);
    req.raw.on('close', () => { clearInterval(ping); bus.off('event', onEvent); });
  });

  const readText = async (path: string, reply: FastifyReply) => {
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) return reply.code(404).send({ error: 'not found' });
    if (info.size > MAX_FILE_BYTES) return reply.code(413).send({ error: `file is ${info.size} bytes; open it from disk` });
    return reply.type('text/plain; charset=utf-8').send(await readFile(path, 'utf8'));
  };

  app.get('/api/projects/:id/files/:name', async (req: FastifyRequest<{ Params: { id: string; name: string } }>, reply) => {
    const row = await project(req.params.id, reply);
    if (!row) return;
    if (!PROJECT_FILES.has(req.params.name)) return reply.code(404).send({ error: 'not found' });
    return readText(join(row.dir, req.params.name), reply);
  });

  // Artifacts of a task's latest run: plan, diffs, checks, reviews, feedback, logs.
  app.get('/api/projects/:id/tasks/:taskId/files', async (req: FastifyRequest<{ Params: { id: string; taskId: string } }>, reply) => {
    const row = await project(req.params.id, reply);
    if (!row) return;
    const dir = row.state.tasks[req.params.taskId]?.dir;
    if (!dir) return [];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = await Promise.all(entries.filter(e => e.isFile()).map(async e => ({ name: e.name, size: (await stat(join(dir, e.name))).size })));
    return files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  });

  app.get('/api/projects/:id/tasks/:taskId/files/:name', async (req: FastifyRequest<{ Params: { id: string; taskId: string; name: string } }>, reply) => {
    const row = await project(req.params.id, reply);
    if (!row) return;
    const dir = row.state.tasks[req.params.taskId]?.dir;
    if (!dir || !FILE_NAME.test(req.params.name)) return reply.code(404).send({ error: 'not found' });
    return readText(join(dir, req.params.name), reply);
  });

  const saveUpload = async (filename: string): Promise<string> => {
    const name = basename(filename || 'document');
    documentFormat(name); // throws for unsupported types
    await mkdir(opts.uploadsDir, { recursive: true });
    return join(opts.uploadsDir, `${randomBytes(6).toString('hex')}-${name.replace(/[^A-Za-z0-9._-]/g, '_')}`);
  };

  /**
   * New project: multipart (UI: `document` file + `repo` + optional `config` JSON string) or JSON for automation
   * (n8n etc.): { repo, config?, document: { name, content, encoding?: "base64" | "utf8" } }.
   */
  app.post('/api/projects', { bodyLimit: 30_000_000 }, async (req, reply) => {
    const temporal = needTemporal(reply);
    if (!temporal) return;
    const fields: Record<string, string> = {};
    let documentPath: string | undefined;
    if (req.isMultipart()) {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          try { documentPath = await saveUpload(part.filename); } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
          await pipeline(part.file, createWriteStream(documentPath));
          if (part.file.truncated) return reply.code(413).send({ error: 'document too large' });
        } else {
          fields[part.fieldname] = String(part.value);
        }
      }
    } else {
      const body = (req.body ?? {}) as { repo?: unknown; config?: unknown; document?: { name?: unknown; content?: unknown; encoding?: unknown } };
      if (typeof body.repo === 'string') fields.repo = body.repo;
      if (body.config !== undefined) fields.config = typeof body.config === 'string' ? body.config : JSON.stringify(body.config);
      const doc = body.document;
      if (doc && typeof doc.name === 'string' && typeof doc.content === 'string') {
        if (doc.encoding !== undefined && doc.encoding !== 'base64' && doc.encoding !== 'utf8') return reply.code(400).send({ error: 'document.encoding must be "base64" or "utf8"' });
        const bytes = Buffer.from(doc.content, doc.encoding === 'base64' ? 'base64' : 'utf8');
        if (bytes.length > 20_000_000) return reply.code(413).send({ error: 'document too large' });
        try { documentPath = await saveUpload(doc.name); } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
        await writeFile(documentPath, bytes);
      }
    }
    if (!documentPath) return reply.code(400).send({ error: 'attach a document (md, txt, pdf or docx)' });
    if (!fields.repo) return reply.code(400).send({ error: 'repo (absolute path to a git repository on the server) is required' });
    const repo = resolve(fields.repo);
    if (opts.repoRoots?.length && !opts.repoRoots.some(root => repo === root || repo.startsWith(root + sep))) {
      return reply.code(403).send({ error: `repo must be under one of: ${opts.repoRoots.join(', ')}` });
    }
    // Fail now, not later inside the workflow where the caller (UI, n8n) never hears about it.
    try { await assertCleanRepoRoot(repo); } catch (error) { return reply.code(400).send({ error: `repo: ${(error as Error).message}` }); }
    let config = opts.defaultConfig;
    if (fields.config?.trim()) {
      try { config = parseConfig(JSON.parse(fields.config)); } catch (error) { return reply.code(400).send({ error: `invalid config: ${(error as Error).message}` }); }
    }
    const projectId = `proj-${randomBytes(4).toString('hex')}`;
    await submitProject(temporal, { projectId, repo, document: documentPath, runRoot: opts.runRoot, config });
    return reply.code(201).send({ id: projectId });
  });

  app.post('/api/projects/:id/approve', async (req: FastifyRequest<{ Params: { id: string }; Body: { answers?: Record<string, string> } | undefined }>, reply) => {
    const temporal = needTemporal(reply);
    if (!temporal) return;
    const answers = Object.fromEntries(Object.entries(req.body?.answers ?? {}).filter(([, v]) => typeof v === 'string' && v.trim()));
    await approveProject(temporal, req.params.id, { answers });
    return { ok: true };
  });

  // Answer to a task the manager escalated: retry with guidance, or skip it.
  app.post('/api/projects/:id/tasks/:taskId/guide', async (req: FastifyRequest<{ Params: { id: string; taskId: string }; Body: { action?: unknown; guidance?: unknown } | undefined }>, reply) => {
    const temporal = needTemporal(reply);
    if (!temporal) return;
    const { action, guidance } = req.body ?? {};
    if (action !== 'retry' && action !== 'skip') return reply.code(400).send({ error: 'action must be "retry" or "skip"' });
    if (guidance !== undefined && (typeof guidance !== 'string' || guidance.length > 8_000)) return reply.code(400).send({ error: 'guidance must be a string of at most 8000 characters' });
    if (action === 'retry' && !guidance?.trim()) return reply.code(400).send({ error: 'retrying needs guidance' });
    const row = await project(req.params.id, reply);
    if (!row) return;
    if (!row.state.tasks[req.params.taskId]) return reply.code(404).send({ error: `unknown task ${req.params.taskId}` });
    try {
      await guideProjectTask(temporal, req.params.id, { taskId: req.params.taskId, action, ...(guidance?.trim() ? { guidance: guidance.trim() } : {}) });
    } catch (error) {
      if ((error as Error).name === 'WorkflowNotFoundError') return reply.code(409).send({ error: 'no running workflow for this project; use "project guide --project <dir>" and run it again' });
      throw error;
    }
    return { ok: true };
  });

  // Run a project again after its run ended early: keeps done tasks, retries the rest.
  app.post('/api/projects/:id/rerun', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const temporal = needTemporal(reply);
    if (!temporal) return;
    const row = await project(req.params.id, reply);
    if (!row) return;
    if (!RERUNNABLE.has(row.state.status)) return reply.code(409).send({ error: `a ${row.state.status} project cannot be run again` });
    try {
      await resumeProjectRun(temporal, row.dir);
    } catch (error) {
      if ((error as Error).name === 'WorkflowExecutionAlreadyStartedError') return reply.code(409).send({ error: 'this project is already running' });
      throw error;
    }
    return reply.code(202).send({ ok: true });
  });

  for (const action of ['pause', 'resume', 'cancel'] as const) {
    app.post(`/api/projects/:id/${action}`, async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const temporal = needTemporal(reply);
      if (!temporal) return;
      await ({ pause: pauseProject, resume: resumeProject, cancel: cancelProject })[action](temporal, req.params.id);
      return { ok: true };
    });
  }

  // Push the branch and open/update the PR (uses this server's env for the token).
  app.post('/api/projects/:id/deliver', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const row = await project(req.params.id, reply);
    if (!row) return;
    const { deliverProject } = await import('../delivery.js');
    const { MultiStore, FileStore } = await import('../store.js');
    try {
      const delivered = await deliverProject(row.dir, new MultiStore(new FileStore(), [opts.store], opts.logger));
      if (!delivered) return reply.code(409).send({ error: 'Delivery is disabled for this project (config.delivery.push)' });
      return delivered;
    } catch (error) { return reply.code(422).send({ error: (error as Error).message }); }
  });

  // Validates a backlog edited in the UI before the workflow sees it.
  app.post('/api/backlog/validate', async (req: FastifyRequest<{ Body: unknown }>, reply) => {
    try { parseBacklog(req.body, { maxTasks: opts.defaultConfig.project.maxTasks }); return { ok: true }; } catch (error) { return reply.code(422).send({ ok: false, error: (error as Error).message }); }
  });

  if (opts.webDist) {
    // wildcard (dynamic) serving: assets from a rebuild are served without restarting the API.
    await app.register(import('@fastify/static'), { root: opts.webDist });
    app.setNotFoundHandler((req, reply) => req.url.startsWith('/api/') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html'));
  }
  return app;
}
