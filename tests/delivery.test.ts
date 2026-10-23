import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '../src/adapters.js';
import { HostCheckRunner } from '../src/checks.js';
import { parseConfig } from '../src/config.js';
import { deliverProject, parseGitHubRemote } from '../src/delivery.js';
import { silentLogger } from '../src/log.js';
import { execute } from '../src/process.js';
import { analyzeProject, readProject, runProject, type ProjectDeps } from '../src/project.js';
import { FileStore } from '../src/store.js';
import { sampleBacklog } from './fixtures.js';

const git = async (args: string[], cwd: string) => {
  const r = await execute('git', args, cwd);
  assert.equal(r.code, 0, r.stderr);
  return r.stdout.trim();
};
const agent = (fn: (cwd: string, prompt: string) => string | Promise<string>): Agent => ({ async run(prompt, cwd) { return { output: await fn(cwd, prompt), costUsd: 0.01 }; } });

/** Fake GitHub REST API: records calls; reports an open PR for the branch once one was created. */
async function fakeGitHub() {
  const calls: { method: string; url: string; body?: Record<string, unknown>; auth?: string }[] = [];
  let created = false;
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push({ method: req.method!, url: req.url!, body: raw ? JSON.parse(raw) : undefined, auth: req.headers.authorization });
    const json = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.method === 'GET' && req.url === '/repos/acme/app') return json(200, { default_branch: 'main' });
    if (req.method === 'GET' && req.url!.startsWith('/repos/acme/app/pulls')) return json(200, created ? [{ number: 7, html_url: 'https://github.example/acme/app/pull/7' }] : []);
    if (req.method === 'POST' && req.url === '/repos/acme/app/pulls') { created = true; return json(201, { number: 7, html_url: 'https://github.example/acme/app/pull/7' }); }
    if (req.method === 'PATCH' && req.url === '/repos/acme/app/pulls/7') return json(200, { number: 7, html_url: 'https://github.example/acme/app/pull/7' });
    json(404, { message: 'not found' });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return { calls, url: `http://127.0.0.1:${port}`, close: () => new Promise(r => server.close(r)) };
}

async function setup(delivery: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'agentic-delivery-'));
  const remote = join(root, 'remote.git');
  const repo = join(root, 'repo');
  await execute('git', ['init', '-q', '--bare', '-b', 'main', remote], root);
  await execute('git', ['init', '-q', '-b', 'main', repo], root);
  await writeFile(join(repo, 'README.md'), '# app\n');
  await git(['add', '.'], repo);
  await git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], repo);
  await git(['remote', 'add', 'origin', remote], repo);
  const runRoot = join(root, 'runs');
  await writeFile(join(root, 'prd.md'), '# PRD');
  const config = parseConfig({ checkRunner: { type: 'host', acknowledgeUnsafe: true }, agentRuntime: { type: 'host', acknowledgeUnsafe: true }, maxRepairs: 0, delivery });
  const deps: ProjectDeps = {
    logger: silentLogger, checkRunner: new HostCheckRunner(),
    analyst: agent(() => JSON.stringify(sampleBacklog())), planner: agent(() => 'plan'),
    developer: agent(async (cwd, prompt) => { await writeFile(join(cwd, `${/## Task (T-\d+)/.exec(prompt)![1]}.txt`), 'x'); return 'ok'; }),
    reviewer: agent(() => JSON.stringify({ decision: 'pass', summary: 'Looks right | well tested', findings: [] })),
  };
  const state = await analyzeProject({ ...deps, repo, document: join(root, 'prd.md'), config, runRoot });
  return { deps, remote, dir: join(runRoot, state.id), branch: state.branch };
}

test('parses GitHub remotes in every common form', () => {
  for (const url of ['git@github.com:acme/app.git', 'https://github.com/acme/app.git', 'https://github.com/acme/app', 'ssh://git@github.com/acme/app.git', 'https://x-access-token:t@github.com/acme/app.git']) {
    assert.deepEqual(parseGitHubRemote(url), { host: 'github.com', repository: 'acme/app' }, url);
  }
  assert.deepEqual(parseGitHubRemote('git@ghe.corp:team/svc.git'), { host: 'ghe.corp', repository: 'team/svc' });
  assert.equal(parseGitHubRemote('/srv/git/app.git'), undefined);
});

test('a completed run pushes the branch and opens a draft PR with the traceability report; re-delivery updates it', async () => {
  const gh = await fakeGitHub();
  process.env.AGENTIC_TEST_GH_TOKEN = 'ghs_test';
  try {
    const { deps, remote, dir, branch } = await setup({ push: true, pullRequest: { enabled: true, repository: 'acme/app', apiUrl: gh.url, tokenEnv: 'AGENTIC_TEST_GH_TOKEN' } });
    const state = await runProject({ ...deps, projectDir: dir });
    assert.equal(state.status, 'completed');
    assert.equal(state.delivery?.prUrl, 'https://github.example/acme/app/pull/7');
    assert.equal(await git(['rev-parse', branch], remote), await git(['rev-parse', 'HEAD'], state.worktree), 'branch pushed to the remote');

    const post = gh.calls.find(c => c.method === 'POST')!;
    assert.equal(post.auth, 'Bearer ghs_test');
    assert.deepEqual([post.body!.head, post.body!.base, post.body!.draft], [branch, 'main', true]);
    const body = String(post.body!.body);
    assert.match(body, /a human review is still required/);
    assert.match(body, /\| REQ-001: Core \| must \| implemented \| T-001, T-002 \|/);
    assert.match(body, /Looks right \\\| well tested/, 'pipes in agent text are escaped');

    // More work later: delivering again updates the same PR instead of opening another.
    await deliverProject(dir, new FileStore(), { fetch });
    assert.equal(gh.calls.filter(c => c.method === 'POST').length, 1);
    assert.equal(gh.calls.filter(c => c.method === 'PATCH').length, 1);
    const events = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l).type);
    assert.equal(events.filter(t => t === 'delivery.finished').length, 2);
  } finally {
    delete process.env.AGENTIC_TEST_GH_TOKEN;
    await gh.close();
  }
});

test('a missing token is recorded as a delivery failure without changing the project result', async () => {
  const { deps, dir } = await setup({ push: true, pullRequest: { enabled: true, repository: 'acme/app', tokenEnv: 'AGENTIC_TEST_NO_TOKEN' } });
  const state = await runProject({ ...deps, projectDir: dir });
  assert.equal(state.status, 'completed');
  assert.match(state.delivery?.error ?? '', /needs a token in \$AGENTIC_TEST_NO_TOKEN/);
  assert.ok(state.delivery?.pushedAt, 'the push itself still happened');
});

test('delivery is opt-in and only for completed projects', async () => {
  const off = await setup({});
  await runProject({ ...off.deps, projectDir: off.dir });
  assert.equal(await deliverProject(off.dir, new FileStore()), undefined);
  assert.equal((await readProject(off.dir)).state.delivery, undefined);

  const early = await setup({ push: true });
  await assert.rejects(deliverProject(early.dir, new FileStore()), /only completed projects are delivered/);
});
