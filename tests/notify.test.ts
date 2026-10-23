import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { silentLogger } from '../src/log.js';
import { notifierFromEnv, SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature, WebhookNotifier } from '../src/notify.js';
import type { ProjectEvent } from '../src/store.js';

type Received = { headers: IncomingMessage['headers']; body: string };
async function receiver(statuses: number[] = []) {
  const received: Received[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ headers: req.headers, body });
    res.writeHead(statuses.shift() ?? 204).end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { received, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/hook?token=secret-in-url`, close: () => new Promise(r => server.close(r)) };
}
const event = (type: string, data: Record<string, unknown> = {}, taskId?: string): ProjectEvent => ({ projectId: 'proj-1', runId: 'run-1', taskId, type, data, at: '2026-10-20T00:00:00Z' });

test('notable events are delivered signed; routine ones are not', async () => {
  const r = await receiver();
  try {
    const n = new WebhookNotifier({ urls: [r.url], secret: 's3cret', publicUrl: 'https://agentic.example/', log: silentLogger });
    await n.appendEvent('/d', event('agent.started', { role: 'planner' }));
    await n.appendEvent('/d', event('project.status', { status: 'running' }));
    await n.appendEvent('/d', event('project.status', { status: 'needs_attention', error: 'T-001 needs your input' }));
    await n.appendEvent('/d', event('task.escalated', { question: 'EUR or USD?' }, 'T-001'));
    await n.close();
    assert.deepEqual(r.received.map(x => JSON.parse(x.body).type), ['project.status', 'task.escalated']);
    const first = r.received[0];
    const payload = JSON.parse(first.body);
    assert.equal(payload.data.status, 'needs_attention');
    assert.equal(payload.links.project, 'https://agentic.example/projects/proj-1');
    assert.equal(first.headers['x-agentic-event'], 'project.status');
    assert.ok(verifySignature('s3cret', String(first.headers[TIMESTAMP_HEADER]), first.body, String(first.headers[SIGNATURE_HEADER])));
    assert.ok(!verifySignature('wrong', String(first.headers[TIMESTAMP_HEADER]), first.body, String(first.headers[SIGNATURE_HEADER])));
    assert.ok(!verifySignature('s3cret', String(first.headers[TIMESTAMP_HEADER]), first.body.replace('needs_attention', 'completed'), String(first.headers[SIGNATURE_HEADER])), 'tampered body');
  } finally { await r.close(); }
});

test('signatures expire, so a captured request cannot be replayed later', () => {
  const ts = String(Math.floor(Date.now() / 1000) - 600);
  const sig = `sha256=${'0'.repeat(64)}`;
  assert.equal(verifySignature('k', ts, '{}', sig), false);
  assert.equal(verifySignature('k', 'not-a-number', '{}', sig), false);
});

test('server errors are retried, client errors are not, and failures never throw', async () => {
  const r = await receiver([503, 503, 200, 400]);
  const warnings: unknown[] = [];
  const log = { ...silentLogger, warn: (o: unknown) => { warnings.push(o); } } as unknown as typeof silentLogger;
  try {
    const n = new WebhookNotifier({ urls: [r.url], events: ['*'], retryDelaysMs: [10, 10, 10], log });
    await n.appendEvent('/d', event('agent.started'));
    await n.close();
    assert.equal(r.received.length, 3, '503, 503, then 200');
    await n.appendEvent('/d', event('agent.finished'));
    await n.close();
    assert.equal(r.received.length, 4, '400 is final');
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(JSON.stringify(warnings), /secret-in-url/, 'URL tokens are not logged');
    const down = new WebhookNotifier({ urls: ['http://127.0.0.1:1/x'], events: ['*'], retryDelaysMs: [], log });
    await down.appendEvent('/d', event('run.finished'));
    await down.close();
    assert.equal(warnings.length, 2);
  } finally { await r.close(); }
});

test('configured from env; disabled without URLs; rejects non-http URLs', () => {
  assert.equal(notifierFromEnv(silentLogger, {}), undefined);
  const n = notifierFromEnv(silentLogger, { AGENTIC_WEBHOOK_URLS: 'https://a.example/h, https://b.example/h', AGENTIC_WEBHOOK_EVENTS: 'run.finished' })!;
  assert.ok(n.selects(event('run.finished')));
  assert.ok(!n.selects(event('task.escalated')));
  assert.throws(() => notifierFromEnv(silentLogger, { AGENTIC_WEBHOOK_URLS: 'file:///etc/passwd' }), /not an http\(s\) URL/);
});
