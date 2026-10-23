import { randomBytes } from 'node:crypto';
import { appendFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Backlog } from './backlog.js';
import type { Logger } from './log.js';
import type { ProjectState } from './project.js';

export interface ProjectEvent {
  projectId: string;
  runId?: string;
  taskId?: string;
  type: string;
  data: Record<string, unknown>;
  at: string;
}

/** Where project state and progress events go. The file store is always present; others mirror it. */
export interface ProjectStore {
  saveState(dir: string, state: ProjectState): Promise<void>;
  saveBacklog(dir: string, projectId: string, backlog: Backlog): Promise<void>;
  appendEvent(dir: string, event: ProjectEvent): Promise<void>;
  close(): Promise<void>;
}

/** Atomic JSON write (readers never see a half-written file). */
export async function writeJson(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await rename(tmp, path);
}

export class FileStore implements ProjectStore {
  async saveState(dir: string, state: ProjectState): Promise<void> { await writeJson(join(dir, 'state.json'), state); }
  async saveBacklog(dir: string, _projectId: string, backlog: Backlog): Promise<void> { await writeJson(join(dir, 'backlog.json'), backlog); }
  async appendEvent(dir: string, event: ProjectEvent): Promise<void> { await appendFile(join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`); }
  async close(): Promise<void> {}
}

const MIGRATIONS: { id: number; sql: string }[] = [{
  id: 1,
  sql: `
    CREATE TABLE projects (
      id text PRIMARY KEY,
      status text NOT NULL,
      repo text NOT NULL,
      branch text NOT NULL,
      dir text NOT NULL,
      document_name text,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      state jsonb NOT NULL,
      backlog jsonb
    );
    CREATE TABLE tasks (
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      id text NOT NULL,
      status text NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      commit_sha text,
      updated_at timestamptz NOT NULL,
      state jsonb NOT NULL,
      PRIMARY KEY (project_id, id)
    );
    CREATE TABLE events (
      id bigserial PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      run_id text,
      task_id text,
      type text NOT NULL,
      data jsonb NOT NULL,
      at timestamptz NOT NULL
    );
    CREATE INDEX events_project_idx ON events (project_id, id);
    CREATE INDEX projects_updated_idx ON projects (updated_at DESC);
  `,
}];
export const EVENTS_CHANNEL = 'agentic_events';

type Pool = import('pg').Pool;

/** Postgres mirror for the API/UI: projects, tasks, append-only events, and NOTIFY on each event. */
export class PgStore implements ProjectStore {
  private constructor(readonly pool: Pool) {}

  static async connect(connectionString: string): Promise<PgStore> {
    const { default: pg } = await import('pg');
    const store = new PgStore(new pg.Pool({ connectionString, max: 5 }));
    await store.migrate();
    return store;
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(727274)'); // one migrator at a time
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (id integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const applied = new Set((await client.query<{ id: number }>('SELECT id FROM schema_migrations')).rows.map(r => r.id));
      for (const m of MIGRATIONS.filter(m => !applied.has(m.id))) {
        await client.query('BEGIN');
        try {
          await client.query(m.sql);
          await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
      client.release();
    }
  }

  async saveState(dir: string, s: ProjectState): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO projects (id, status, repo, branch, dir, document_name, created_at, updated_at, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at, state = EXCLUDED.state`,
        [s.id, s.status, s.repo, s.branch, dir, s.document.name, s.createdAt, s.updatedAt, s],
      );
      for (const [id, t] of Object.entries(s.tasks)) {
        await client.query(
          `INSERT INTO tasks (project_id, id, status, attempts, commit_sha, updated_at, state) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (project_id, id) DO UPDATE SET status = EXCLUDED.status, attempts = EXCLUDED.attempts, commit_sha = EXCLUDED.commit_sha, updated_at = EXCLUDED.updated_at, state = EXCLUDED.state`,
          [s.id, id, t.status, t.attempts, t.commit ?? null, s.updatedAt, t],
        );
      }
      await client.query('DELETE FROM tasks WHERE project_id = $1 AND NOT (id = ANY($2))', [s.id, Object.keys(s.tasks)]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async saveBacklog(_dir: string, projectId: string, backlog: Backlog): Promise<void> {
    await this.pool.query('UPDATE projects SET backlog = $2 WHERE id = $1', [projectId, backlog]);
  }

  async appendEvent(_dir: string, e: ProjectEvent): Promise<void> {
    const { rows } = await this.pool.query<{ id: string }>(
      'INSERT INTO events (project_id, run_id, task_id, type, data, at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [e.projectId, e.runId ?? null, e.taskId ?? null, e.type, e.data, e.at],
    );
    await this.pool.query('SELECT pg_notify($1, $2)', [EVENTS_CHANNEL, JSON.stringify({ id: rows[0].id, projectId: e.projectId, type: e.type })]);
  }

  async close(): Promise<void> { await this.pool.end(); }
}

/** File store first (source of truth, must succeed); mirrors are best-effort so a database blip never fails a run. */
export class MultiStore implements ProjectStore {
  constructor(private primary: ProjectStore, private mirrors: ProjectStore[], private log: Logger) {}
  private async mirror(op: string, fn: (s: ProjectStore) => Promise<void>): Promise<void> {
    await Promise.all(this.mirrors.map(m => fn(m).catch(err => this.log.warn({ err, op }, 'store mirror write failed'))));
  }
  async saveState(dir: string, state: ProjectState): Promise<void> { await this.primary.saveState(dir, state); await this.mirror('saveState', m => m.saveState(dir, state)); }
  async saveBacklog(dir: string, id: string, backlog: Backlog): Promise<void> { await this.primary.saveBacklog(dir, id, backlog); await this.mirror('saveBacklog', m => m.saveBacklog(dir, id, backlog)); }
  async appendEvent(dir: string, event: ProjectEvent): Promise<void> { await this.primary.appendEvent(dir, event); await this.mirror('appendEvent', m => m.appendEvent(dir, event)); }
  async close(): Promise<void> { await Promise.all([this.primary, ...this.mirrors].map(s => s.close().catch(() => {}))); }
}

export async function createStore(log: Logger, databaseUrl = process.env.DATABASE_URL): Promise<ProjectStore> {
  const mirrors: ProjectStore[] = [];
  if (databaseUrl) mirrors.push(await PgStore.connect(databaseUrl));
  const { notifierFromEnv } = await import('./notify.js');
  const notifier = notifierFromEnv(log);
  if (notifier) mirrors.push(notifier);
  return new MultiStore(new FileStore(), mirrors, log);
}
