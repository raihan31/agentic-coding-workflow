import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Backlog } from './backlog.js';
import type { Logger } from './log.js';
import type { ProjectState } from './project.js';
import type { ProjectEvent, ProjectStore } from './store.js';

/** Statuses worth telling someone about (a human must act, or a run ended). */
const NOTABLE_STATUSES = new Set(['backlog_ready', 'needs_answers', 'needs_attention', 'rate_limited', 'completed', 'partial', 'integration_failed', 'budget_exceeded', 'cancelled', 'failed']);
/** Default event selection; `AGENTIC_WEBHOOK_EVENTS` overrides it (comma-separated types, or `*`). */
const DEFAULT_TYPES = new Set(['project.status', 'task.escalated', 'manager.decision', 'task.split', 'delivery.finished', 'delivery.failed', 'run.finished']);

export interface WebhookOptions {
  urls: string[];
  /** HMAC-SHA256 key; the signature covers `${timestamp}.${body}`. */
  secret?: string;
  /** Event types to send; undefined = defaults, ['*'] = everything. */
  events?: string[];
  /** Base URL of the web UI, for links in payloads. */
  publicUrl?: string;
  timeoutMs?: number;
  /** Delays between retries; the attempt count is one more than its length. */
  retryDelaysMs?: number[];
  fetch?: typeof fetch;
  log: Logger;
}

export interface WebhookPayload {
  id: string; type: string; projectId: string; runId?: string; taskId?: string; at: string;
  data: Record<string, unknown>;
  links?: { project: string };
}

export const SIGNATURE_HEADER = 'x-agentic-signature';
export const TIMESTAMP_HEADER = 'x-agentic-timestamp';

export const sign = (secret: string, timestamp: string, body: string) => `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

/** Receiver-side check (also used by tests); rejects signatures older than `toleranceSec` to stop replays. */
export function verifySignature(secret: string, timestamp: string, body: string, signature: string, toleranceSec = 300, now = Date.now()): boolean {
  if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > toleranceSec) return false;
  const expected = Buffer.from(sign(secret, timestamp, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Outbound webhooks for n8n, Slack bridges, chat-ops, etc. Implemented as a store mirror, so every event any process
 * records (worker, CLI, API) is eligible. Delivery is queued and never blocks or fails a run; close() drains the queue.
 */
export class WebhookNotifier implements ProjectStore {
  private pending = new Set<Promise<void>>();
  private readonly types: Set<string> | 'all';
  constructor(private opts: WebhookOptions) {
    this.types = opts.events?.includes('*') ? 'all' : new Set(opts.events ?? DEFAULT_TYPES);
  }

  /** Which events go out. With the default selection, project.status is sent only for statuses where someone must act or a run ended. */
  selects(e: ProjectEvent): boolean {
    if (this.types !== 'all' && !this.types.has(e.type)) return false;
    if (e.type === 'project.status' && this.types !== 'all' && !this.opts.events) return NOTABLE_STATUSES.has(String(e.data.status));
    return true;
  }

  async saveState(_dir: string, _state: ProjectState): Promise<void> {}
  async saveBacklog(_dir: string, _id: string, _backlog: Backlog): Promise<void> {}

  async appendEvent(_dir: string, e: ProjectEvent): Promise<void> {
    if (!this.selects(e)) return;
    const payload: WebhookPayload = {
      id: randomUUID(), type: e.type, projectId: e.projectId, at: e.at, data: e.data,
      ...(e.runId ? { runId: e.runId } : {}), ...(e.taskId ? { taskId: e.taskId } : {}),
      ...(this.opts.publicUrl ? { links: { project: `${this.opts.publicUrl.replace(/\/+$/, '')}/projects/${e.projectId}` } } : {}),
    };
    for (const url of this.opts.urls) {
      const p = this.deliver(url, payload).finally(() => this.pending.delete(p));
      this.pending.add(p);
    }
  }

  private async deliver(url: string, payload: WebhookPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const delays = this.opts.retryDelaysMs ?? [1_000, 5_000, 30_000];
    const doFetch = this.opts.fetch ?? fetch;
    let lastError = '';
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, delays[attempt - 1]));
      const timestamp = String(Math.floor(Date.now() / 1000));
      try {
        const res = await doFetch(url, {
          method: 'POST', body, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
          headers: {
            'content-type': 'application/json', 'user-agent': 'agentic-orchestrator', 'x-agentic-event': payload.type, 'x-agentic-delivery': payload.id,
            [TIMESTAMP_HEADER]: timestamp, ...(this.opts.secret ? { [SIGNATURE_HEADER]: sign(this.opts.secret, timestamp, body) } : {}),
          },
        });
        if (res.ok) return;
        lastError = `HTTP ${res.status}`;
        if (res.status < 500 && res.status !== 408 && res.status !== 429) break; // the receiver rejected it; retrying will not help
      } catch (error) {
        lastError = (error as Error).message;
      }
    }
    this.opts.log.warn({ url: redact(url), event: payload.type, project_id: payload.projectId, err: lastError }, 'webhook delivery failed');
  }

  /** Waits for in-flight deliveries (bounded), e.g. before a CLI run exits. */
  async close(timeoutMs = 15_000): Promise<void> {
    await Promise.race([Promise.allSettled([...this.pending]), new Promise(r => setTimeout(r, timeoutMs).unref())]);
  }
}

/** Webhook URLs often embed tokens; log the origin and path only. */
const redact = (url: string) => { try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return 'invalid-url'; } };

/** From env: AGENTIC_WEBHOOK_URLS (comma-separated), AGENTIC_WEBHOOK_SECRET, AGENTIC_WEBHOOK_EVENTS, AGENTIC_PUBLIC_URL. */
export function notifierFromEnv(log: Logger, env: NodeJS.ProcessEnv = process.env): WebhookNotifier | undefined {
  const urls = (env.AGENTIC_WEBHOOK_URLS ?? '').split(',').map(u => u.trim()).filter(Boolean);
  if (!urls.length) return undefined;
  for (const u of urls) if (!/^https?:\/\//.test(u)) throw new Error(`AGENTIC_WEBHOOK_URLS: not an http(s) URL: ${redact(u)}`);
  if (!env.AGENTIC_WEBHOOK_SECRET) log.warn('AGENTIC_WEBHOOK_URLS is set without AGENTIC_WEBHOOK_SECRET; webhooks are unsigned');
  const events = env.AGENTIC_WEBHOOK_EVENTS?.split(',').map(e => e.trim()).filter(Boolean);
  return new WebhookNotifier({ urls, secret: env.AGENTIC_WEBHOOK_SECRET || undefined, events: events?.length ? events : undefined, publicUrl: env.AGENTIC_PUBLIC_URL, log });
}
