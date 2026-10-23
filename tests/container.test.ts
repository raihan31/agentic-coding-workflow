import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerCheckRunner } from '../src/checks.js';
import { AgentRuntimeSchema, ContainerRunnerSchema } from '../src/config.js';
import { containerArgs } from '../src/container.js';
import { ContainerAgentRuntime, worktreeMounts } from '../src/runtime.js';

const dockerAvailable = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 }).status === 0;
const skip = dockerAvailable ? false : 'docker is not available';
const runner = () => new ContainerCheckRunner(ContainerRunnerSchema.parse({ type: 'container', image: 'alpine:3.20', setup: [['sh', '-c', 'echo setup > setup.txt']] }));

test('container checks see the worktree, run setup, and have no network', { skip, timeout: 300_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentic-container-'));
  const r = runner();
  await r.prepare();
  const results = await r.runAll(dir, [
    ['sh', '-c', 'test "$(cat setup.txt)" = setup && echo hi > out.txt'],
    ['sh', '-c', 'if wget -q -T 3 -O /dev/null http://example.com; then echo "network reachable"; exit 1; fi'],
    ['sh', '-c', 'exit 3'],
  ], 60_000);
  assert.deepEqual(results.map(x => [x.phase, x.code]), [['setup', 0], ['check', 0], ['check', 0], ['check', 3]], JSON.stringify(results, null, 2));
  assert.equal((await readFile(join(dir, 'out.txt'), 'utf8')).trim(), 'hi');
});

test('timed-out container checks are killed and removed', { skip, timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentic-container-'));
  const r = runner();
  await r.prepare();
  const [, result] = await r.runAll(dir, [['sleep', '60']], 3_000);
  assert.equal(result.timedOut, true);
  const leftover = spawnSync('docker', ['ps', '-aq', '--filter', 'name=agentic-check-'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(leftover, '');
});

test('containerArgs: secrets by name only, nested mounts ordered, hardening flags', () => {
  const args = containerArgs({
    engine: 'docker', image: 'img', command: ['codex', 'exec'], workdir: '/w', network: 'net', memory: '1g', cpus: '1', pidsLimit: 10,
    mounts: [{ path: '/repo/.git/worktrees/x' }, { path: '/repo/.git', readOnly: true }],
    env: { HOME: '/home/agent' }, secretEnv: { TOKEN: 'super-secret' }, readOnlyRoot: true, tmpfs: ['/tmp'],
  }, 'name1');
  const joined = args.join(' ');
  assert.ok(!joined.includes('super-secret'), 'secret value leaked into argv');
  assert.match(joined, /-e TOKEN( |$)/);
  assert.match(joined, /-e HOME=\/home\/agent/);
  assert.ok(joined.indexOf('dst=/repo/.git,readonly') < joined.indexOf('dst=/repo/.git/worktrees/x'));
  for (const flag of ['--cap-drop ALL', '--security-opt no-new-privileges', '--read-only', '--network net', '--pids-limit 10']) assert.ok(joined.includes(flag), flag);
  assert.deepEqual(args.slice(-3), ['img', 'codex', 'exec']);
});

test('agent mounts: read-only roles cannot write the worktree or git dir; writers can only touch their own admin dir', { skip, timeout: 120_000 }, async () => {
  const repo = await mkdtemp(join(tmpdir(), 'agentic-mnt-'));
  const git = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i');
  const wt = join(repo, '..', `${repo.split('/').pop()}-wt`);
  git('worktree', 'add', '-q', '--detach', wt, 'HEAD');
  const real = (await import('node:fs/promises')).realpath;
  const worktree = await real(wt);
  const runtime = new ContainerAgentRuntime(AgentRuntimeSchema.parse({ type: 'container', image: 'alpine:3.20', network: 'none' }) as never);
  const probe = async (access: 'ro' | 'rw', script: string) => (await runtime.exec({ command: 'sh', args: ['-c', script], cwd: worktree, input: '', timeoutMs: 60_000, mounts: await worktreeMounts(worktree, access) })).stdout.trim();
  const script = `touch file 2>/dev/null && echo wt-ok || echo wt-denied; touch "$(sed 's/gitdir: //' .git)/probe" 2>/dev/null && echo admin-ok || echo admin-denied; touch "$(sed 's/gitdir: //' .git)/../../probe" 2>/dev/null && echo common-ok || echo common-denied`;
  assert.deepEqual((await probe('ro', script)).split('\n'), ['wt-denied', 'admin-denied', 'common-denied']);
  assert.deepEqual((await probe('rw', script)).split('\n'), ['wt-ok', 'admin-ok', 'common-denied']);
});
