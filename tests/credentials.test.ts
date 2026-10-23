import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexUsage } from '../src/adapters.js';
import { CredentialsSchema } from '../src/config.js';
import { CLAUDE_HOST_ENV, createCredentials } from '../src/credentials.js';
import { claudeTelemetryEnv } from '../src/telemetry.js';

const exists = (p: string) => access(p).then(() => true, () => false);
const base = { runId: 'run-test', needClaude: true, needCodex: true };

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return fn().finally(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

test('subscription + host runtime keeps the normal CLI logins', async () => {
  const creds = await createCredentials({ mode: 'subscription' }, { ...base, runtime: 'host' });
  assert.deepEqual(creds.claude.passEnv, CLAUDE_HOST_ENV);
  assert.deepEqual(creds.claude.secretEnv, {});
  assert.equal(creds.codex.env.CODEX_HOME, undefined);
  await creds.dispose();
});

test('subscription + container runtime requires a Claude token', async () => {
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
    await assert.rejects(createCredentials({ mode: 'subscription' }, { ...base, runtime: 'container', needCodex: false }), /claude setup-token/);
  });
});

test('subscription + container runtime copies codex auth into a throwaway CODEX_HOME', async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), 'fake-codex-'));
  await writeFile(join(fakeHome, 'auth.json'), '{"auth_mode":"chatgpt"}');
  await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'tok', CODEX_HOME: fakeHome }, async () => {
    const creds = await createCredentials({ mode: 'subscription' }, { ...base, runtime: 'container', codexOtelEndpoint: 'http://collector:4318' });
    assert.deepEqual(creds.claude.secretEnv, { CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
    const home = creds.codex.env.CODEX_HOME;
    assert.notEqual(home, fakeHome);
    assert.deepEqual(creds.codex.mounts, [{ path: home }]);
    assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), '{"auth_mode":"chatgpt"}');
    assert.match(await readFile(join(home, 'config.toml'), 'utf8'), /\[otel\][\s\S]*http:\/\/collector:4318\/v1\/traces/);
    await creds.dispose();
    assert.equal(await exists(home), false);
    assert.equal(await exists(join(fakeHome, 'auth.json')), true, 'must never touch the real auth file');
  });
});

test('gateway mode issues a budgeted per-run key and revokes it', async () => {
  const calls: Array<{ url: string; body?: unknown; auth?: string }> = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: (init?.headers as Record<string, string>).authorization });
    const json = url.endsWith('/key/generate') ? { key: 'sk-virtual' } : url.includes('/key/info') ? { info: { spend: 1.25 } } : {};
    return new Response(JSON.stringify(json), { status: 200 });
  }) as typeof fetch;
  await withEnv({ LITELLM_MASTER_KEY: 'sk-master' }, async () => {
    const cfg = CredentialsSchema.parse({ mode: 'gateway', budgetUsd: 3 });
    const creds = await createCredentials(cfg, { ...base, runtime: 'container', fetch: fakeFetch });
    assert.deepEqual(calls[0], { url: 'http://localhost:4000/key/generate', auth: 'Bearer sk-master', body: { max_budget: 3, duration: '24h', key_alias: 'agentic-run-test', metadata: { agentic_run_id: 'run-test' } } });
    assert.deepEqual(creds.claude.env, { ANTHROPIC_BASE_URL: 'http://agentic-litellm:4000' });
    assert.deepEqual(creds.claude.secretEnv, { ANTHROPIC_AUTH_TOKEN: 'sk-virtual' });
    assert.deepEqual(creds.codex.secretEnv, { AGENTIC_GATEWAY_KEY: 'sk-virtual' });
    assert.match(await readFile(join(creds.codex.env.CODEX_HOME, 'config.toml'), 'utf8'), /base_url = "http:\/\/agentic-litellm:4000\/v1"/);
    assert.equal(creds.budgetUsd, 3);
    assert.equal(await creds.spendUsd(), 1.25);
    await creds.dispose();
    assert.deepEqual(calls.at(-1), { url: 'http://localhost:4000/key/delete', auth: 'Bearer sk-master', body: { keys: ['sk-virtual'] } });
  });
});

test('gateway mode needs the master key', async () => {
  await withEnv({ LITELLM_MASTER_KEY: undefined }, async () => {
    await assert.rejects(createCredentials(CredentialsSchema.parse({ mode: 'gateway' }), { ...base, runtime: 'host' }), /LITELLM_MASTER_KEY/);
  });
});

test('codex JSONL usage is summed over turns', () => {
  const jsonl = ['{"type":"thread.started"}', '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}', 'noise', '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}'].join('\n');
  assert.deepEqual(codexUsage(jsonl), { inputTokens: 15, outputTokens: 3 });
  assert.equal(codexUsage('{"type":"turn.started"}'), undefined);
});

test('claude telemetry env', () => {
  const env = claudeTelemetryEnv('http://c:4318', { 'agentic.run_id': 'r1', 'agentic.role': 'planner' });
  assert.equal(env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
  assert.equal(env.OTEL_RESOURCE_ATTRIBUTES, 'agentic.run_id=r1,agentic.role=planner');
});

test('rate limits are recognised only on error channels', async () => {
  const { isRateLimitMessage } = await import('../src/adapters.js');
  assert.ok(isRateLimitMessage("You've hit your usage limit. Upgrade to Pro"));
  assert.ok(isRateLimitMessage('Error: 429 Too Many Requests'));
  assert.ok(isRateLimitMessage("claude failed (success): You've hit your session limit · resets 4am (Asia/Dhaka)"));
  assert.ok(isRateLimitMessage("You've hit your weekly limit"));
  assert.ok(!isRateLimitMessage('the limit of 10 items per page'));
  assert.ok(isRateLimitMessage('{"type":"error","error":{"type":"overloaded_error"}}'));
  assert.ok(!isRateLimitMessage('TypeError: cannot read properties of undefined'));
});
