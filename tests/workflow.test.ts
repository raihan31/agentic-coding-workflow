import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentError, type Agent } from '../src/adapters.js';
import { HostCheckRunner } from '../src/checks.js';
import { parseConfig } from '../src/config.js';
import { silentLogger } from '../src/log.js';
import { execute } from '../src/process.js';
import { parseReview, runWorkflow, type Options } from '../src/workflow.js';

const PASS = JSON.stringify({ decision: 'pass', summary: 'looks good', findings: [] });

test('accepts clean pass', () => {
  assert.equal(parseReview(PASS).decision, 'pass');
});
test('accepts fenced JSON', () => {
  assert.equal(parseReview('```json\n' + PASS + '\n```').decision, 'pass');
});
test('rejects contradictory pass', () => {
  assert.throws(() => parseReview(JSON.stringify({ decision: 'pass', summary: 'bad', findings: [{ severity: 'high', file: 'x.ts', explanation: 'bug', recommendation: 'fix' }] })));
});
test('rejects malformed data', () => assert.throws(() => parseReview('{"decision":"yes"}'), /Malformed review/));

// ---- integration: real git repo, real host checks, fake agents ----

const exists = (p: string) => access(p).then(() => true, () => false);
const git = async (args: string[], cwd: string) => {
  const r = await execute('git', args, cwd);
  assert.equal(r.code, 0, r.stderr);
  return r.stdout;
};

async function makeRepo(): Promise<string> {
  // tmpdir() is a symlink on macOS, which also exercises the realpath root check.
  const repo = await mkdtemp(join(tmpdir(), 'agentic-repo-'));
  await git(['init', '-q', '-b', 'main'], repo);
  await writeFile(join(repo, 'check.mjs'), `import { readFileSync, existsSync } from 'node:fs';
const s = existsSync('out.txt') ? readFileSync('out.txt', 'utf8').trim() : '<missing>';
if (s !== 'good') { console.error('expected good, got ' + s); process.exit(1); }\n`);
  await git(['add', '.'], repo);
  await git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], repo);
  return repo;
}

interface Calls { prompts: Record<string, string>; }
function agent(calls: Calls, fn: (cwd: string, phase: string, prompt: string) => string | Promise<string>): Agent {
  return { async run(prompt, cwd, _outDir, phase) { calls.prompts[phase] = prompt; return { output: await fn(cwd, phase, prompt), costUsd: 0.01 }; } };
}
const writeOut = (text: string) => (cwd: string) => writeFile(join(cwd, 'out.txt'), text).then(() => 'done');

async function setup(overrides: Omit<Partial<Options>, 'config'> & { config?: Record<string, unknown> } = {}) {
  const calls: Calls = { prompts: {} };
  const repo = await makeRepo();
  const runRoot = await mkdtemp(join(tmpdir(), 'agentic-runs-'));
  const { config, ...rest } = overrides;
  const opts: Options = {
    repo, runRoot, requirement: 'Write good to out.txt',
    config: parseConfig({ checkRunner: { type: 'host', acknowledgeUnsafe: true }, checks: [['node', 'check.mjs']], protectedPaths: ['check.mjs'], ...config }),
    checkRunner: new HostCheckRunner(),
    planner: agent(calls, () => 'PLAN: write it'),
    developer: agent(calls, writeOut('good')),
    reviewer: agent(calls, () => PASS),
    logger: silentLogger,
    ...rest,
  };
  return { calls, repo, opts };
}

test('repairs a failing check, then passes', async () => {
  const { calls, opts } = await setup();
  opts.developer = agent(calls, (cwd, phase) => writeOut(phase === 'developer-0' ? 'bad' : 'good')(cwd));
  const result = await runWorkflow(opts);
  assert.equal(result.status, 'awaiting_human_approval');
  assert.equal(result.attempts, 2);
  assert.match(calls.prompts['developer-1'], /expected good, got bad/);
  assert.ok(!('review-0' in calls.prompts), 'reviewer must not run while checks fail');
  assert.ok(Math.abs(result.costUsd - 0.04) < 1e-9);
  const saved = JSON.parse(await readFile(join(result.directory, 'result.json'), 'utf8'));
  assert.equal(saved.attempts, 2);
  const diff = await readFile(join(result.directory, 'diff-1.patch'), 'utf8');
  assert.match(diff, /\+\+\+ b\/out\.txt[\s\S]*\+good/);
  assert.match(calls.prompts['review-1'], /\+good/);
});

test('reports the right attempt count when repairs are exhausted', async () => {
  const { opts, calls } = await setup({ config: { maxRepairs: 1 } });
  opts.developer = agent(calls, writeOut('bad'));
  const result = await runWorkflow(opts);
  assert.equal(result.status, 'changes_required');
  assert.equal(result.attempts, 2);
});

test('protected path changes are rejected before checks run', async () => {
  const { opts, calls } = await setup();
  opts.developer = agent(calls, async (cwd, phase) => {
    if (phase === 'developer-0') await writeFile(join(cwd, 'check.mjs'), 'process.exit(0)\n');
    else await git(['checkout', '--', 'check.mjs'], cwd);
    return writeOut('good')(cwd);
  });
  const result = await runWorkflow(opts);
  assert.equal(result.status, 'awaiting_human_approval');
  assert.equal(result.attempts, 2);
  assert.match(calls.prompts['developer-1'], /check\.mjs \(modified\)/);
  assert.equal(await exists(join(result.directory, 'checks-0.json')), false);
});

test('an empty diff produces explicit feedback', async () => {
  const { opts, calls } = await setup();
  opts.developer = agent(calls, (cwd, phase) => phase === 'developer-0' ? 'did nothing' : writeOut('good')(cwd));
  const result = await runWorkflow(opts);
  assert.equal(result.attempts, 2);
  assert.match(calls.prompts['developer-1'], /No changes were made/);
});

test('a failing developer process is repairable, not fatal', async () => {
  const { opts, calls } = await setup();
  opts.developer = agent(calls, (cwd, phase) => { if (phase === 'developer-0') throw new AgentError('codex exited 1: rate limited'); return writeOut('good')(cwd); });
  const result = await runWorkflow(opts);
  assert.equal(result.status, 'awaiting_human_approval');
  assert.match(calls.prompts['developer-1'], /rate limited/);
});

test('reviewer gets one retry on invalid output', async () => {
  const { opts, calls } = await setup();
  opts.reviewer = agent(calls, (_cwd, phase) => phase === 'review-0' ? 'not json' : PASS);
  const result = await runWorkflow(opts);
  assert.equal(result.status, 'awaiting_human_approval');
  assert.match(calls.prompts['review-0-retry'], /previous output was rejected/);
});

test('review findings are fed back to the developer', async () => {
  const { opts, calls } = await setup();
  const changes = JSON.stringify({ decision: 'changes_required', summary: 'missing newline', findings: [{ severity: 'medium', file: 'out.txt', explanation: 'x', recommendation: 'add newline' }] });
  opts.reviewer = agent(calls, (_cwd, phase) => phase === 'review-0' ? changes : PASS);
  const result = await runWorkflow(opts);
  assert.equal(result.attempts, 2);
  assert.match(calls.prompts['developer-1'], /add newline/);
});

test('plan-only stops after planning and removes the worktree', async () => {
  const { opts, calls } = await setup({ planOnly: true });
  const result = await runWorkflow(opts);
  assert.equal(result.status, 'plan_ready');
  assert.equal(await readFile(join(result.directory, 'plan.md'), 'utf8'), 'PLAN: write it');
  assert.equal(await exists(result.worktree), false);
  assert.ok(!('developer-0' in calls.prompts));
});

test('a provided plan skips the planner', async () => {
  const { opts, calls } = await setup({ plan: 'HUMAN PLAN' });
  await runWorkflow(opts);
  assert.ok(!('planner' in calls.prompts));
  assert.match(calls.prompts['developer-0'], /HUMAN PLAN/);
});

test('rejects dirty repos and non-root paths', async () => {
  const { opts, repo } = await setup();
  await writeFile(join(repo, 'dirty.txt'), 'x');
  await assert.rejects(runWorkflow(opts), /must be clean/);
  const sub = join(repo, 'sub');
  await execute('mkdir', [sub], repo);
  await assert.rejects(runWorkflow({ ...opts, repo: sub }), /repository root/);
});

test('repo hooks never run', async () => {
  const { opts, repo } = await setup();
  const marker = join(repo, '..', `hook-ran-${Date.now()}`);
  await writeFile(join(repo, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  await runWorkflow(opts);
  assert.equal(await exists(marker), false);
});

test('stops with budget_exceeded once gateway spend reaches the budget', async () => {
  const { opts, calls } = await setup();
  let disposed = false;
  opts.credentials = {
    mode: 'gateway', budgetUsd: 1, claude: { env: {}, secretEnv: {}, passEnv: [], mounts: [] }, codex: { env: {}, secretEnv: {}, passEnv: [], mounts: [] },
    spendUsd: async () => 1.5, dispose: async () => { disposed = true; },
  };
  const result = await runWorkflow(opts);
  assert.equal(result.status, 'budget_exceeded');
  assert.equal(result.costUsd, 1.5);
  assert.equal(result.costSource, 'gateway');
  assert.deepEqual(Object.keys(calls.prompts), []);
  assert.equal(disposed, true);
});

test('security findings at the threshold reject the attempt; lower ones reach the reviewer', async () => {
  let scans = 0;
  const finding = (severity: 'critical' | 'low') => ({ scanner: 'gitleaks' as const, severity, rule: 'github-pat', file: 'out.txt', line: 1, message: 'possible secret' });
  const scanner = {
    enabled: true, prepare: async () => {},
    scan: async () => {
      const f = scans++ === 0 ? [finding('critical')] : [finding('low')];
      return { scanned: ['out.txt'], findings: f, blocking: f.filter(x => x.severity === 'critical'), durationMs: 1 };
    },
  };
  const { opts, calls } = await setup({ scanner });
  const result = await runWorkflow(opts);
  assert.equal(result.status, 'awaiting_human_approval');
  assert.equal(result.attempts, 2);
  assert.match(calls.prompts['developer-1'], /Security scanners flagged[\s\S]*\[gitleaks critical\] out\.txt:1 github-pat[\s\S]*not honoured/);
  assert.ok(!('review-0' in calls.prompts), 'the reviewer only sees changes that pass the scanners');
  assert.match(calls.prompts['review-1'], /below the blocking threshold[\s\S]*\[gitleaks low\]/);
  assert.ok(await exists(join(result.directory, 'security-0.json')));
});
