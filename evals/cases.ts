/**
 * Eval cases: each builds a small fixture repository, runs one real agent through the production prompt and
 * parser, and returns the parsed result for promptfoo to assert on. Usage: tsx evals/cases.ts <case-name>
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeStructured } from '../src/adapters.js';
import { backlogJsonSchema, parseBacklog } from '../src/backlog.js';
import { parseConfig } from '../src/config.js';
import { openSession, parseReview, type Session } from '../src/engine.js';
import { diffAgainst, listChanges } from '../src/git.js';
import { silentLogger } from '../src/log.js';
import { managerJsonSchema, parseDecision } from '../src/manager.js';
import { execute } from '../src/process.js';
import { prompts } from '../src/prompts.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Evals run the agent CLIs on the host against throwaway fixture repos; models come from the environment if set.
const config = parseConfig({
  agentRuntime: { type: 'host', acknowledgeUnsafe: true }, checkRunner: { type: 'host', acknowledgeUnsafe: true },
  models: { reviewer: process.env.EVAL_REVIEWER_MODEL, manager: process.env.EVAL_MANAGER_MODEL, analyst: process.env.EVAL_ANALYST_MODEL },
  manager: { budgetUsd: 1 }, analystBudgetUsd: 2,
});

interface Fixture { repo: string; base: string; scratch: string; }
/** A git repo with `base` committed and `change` left uncommitted (the work under evaluation). */
async function fixture(base: Record<string, string>, change: Record<string, string> = {}): Promise<Fixture> {
  const scratch = await mkdtemp(join(tmpdir(), 'agentic-eval-'));
  const repo = join(scratch, 'repo');
  const write = async (files: Record<string, string>) => { for (const [p, c] of Object.entries(files)) { await mkdir(dirname(join(repo, p)), { recursive: true }); await writeFile(join(repo, p), c); } };
  await mkdir(repo);
  await write(base);
  const git = (args: string[]) => execute('git', args, repo);
  await git(['init', '-q', '-b', 'main']);
  await git(['add', '.']);
  await git(['-c', 'user.name=eval', '-c', 'user.email=eval@localhost', 'commit', '-q', '-m', 'base']);
  const sha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await write(change);
  return { repo, base: sha, scratch };
}

async function session(f: Fixture, roles: { claude?: boolean; codex?: boolean }, extra: Partial<Parameters<typeof openSession>[0]> = {}): Promise<Session> {
  return await openSession({ config, runId: 'eval', dir: join(f.scratch, 'session'), logger: silentLogger, needClaude: Boolean(roles.claude), needCodex: Boolean(roles.codex), ...extra });
}

// ---------------------------------------------------------------- reviewer

const USERS_BASE = {
  'package.json': JSON.stringify({ name: 'users', type: 'module', scripts: { test: 'node --test' } }, null, 2),
  'src/db.js': 'import { DatabaseSync } from "node:sqlite";\nexport const db = new DatabaseSync(":memory:");\ndb.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)");\n',
};
const USERS_TASK = '## Task T-001: Look up users by name\n\nAdd `findUserByName(name)` to src/users.js returning the matching user row or undefined, with tests.\n\nAcceptance criteria:\n- returns the row for an existing name\n- returns undefined for an unknown name';

async function review(change: Record<string, string>) {
  const f = await fixture(USERS_BASE, change);
  const s = await session(f, { codex: true });
  try {
    const changes = await listChanges(f.repo);
    const prompt = prompts.review({
      requirement: USERS_TASK, plan: 'Add findUserByName in src/users.js using the shared db; add node:test tests.',
      status: changes.map(c => `${c.x}${c.y} ${c.path}`).join('\n'), diff: await diffAgainst(f.repo, f.base), checks: '$ npm test (exit 0)',
    });
    return parseReview(await s.callAgent('reviewer', s.agents.reviewer, prompt, f.repo, f.scratch, 'review'));
  } finally { await s.close(); }
}

const USERS_TEST = 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { db } from "../src/db.js";\nimport { findUserByName } from "../src/users.js";\n\ndb.prepare("INSERT INTO users (name, email) VALUES (?, ?)").run("ada", "ada@example.com");\ntest("finds a user", () => assert.equal(findUserByName("ada").email, "ada@example.com"));\ntest("unknown name", () => assert.equal(findUserByName("bob"), undefined));\n';

// ---------------------------------------------------------------- manager

async function manage(base: Record<string, string>, failed: Record<string, string>, requirement: string, gates: string[], feedback: string) {
  const f = await fixture(base, failed);
  const taskDir = join(f.scratch, 'task');
  await mkdir(taskDir, { recursive: true });
  await writeFile(join(taskDir, `feedback-${gates.length - 1}.md`), feedback);
  const limits = { allowSplit: true, allowEscalate: true, maxSubtasks: 4 };
  const s = await session(f, { claude: true }, {
    managerDirs: [taskDir],
    manager: ctx => new ClaudeStructured(ctx, { model: config.models.manager, timeoutMs: config.timeouts.managerMs, maxBudgetUsd: config.manager.budgetUsd, jsonSchema: managerJsonSchema(), addDirs: [taskDir] }),
  });
  try {
    const prompt = prompts.manage({ requirement, taskDir, history: gates.map((g, i) => `- attempt ${i + 1}: ${g}`).join('\n'), feedback, remaining: 2, ...limits });
    return parseDecision(await s.callAgent('manager', s.agents.manager!, prompt, f.repo, taskDir, 'manager'), limits);
  } finally { await s.close(); }
}

const SLUG_CHECK = 'import { slugify } from "./slugify.mjs";\nconst cases = [["Hello World", "hello-world"], ["Crème Brûlée", "creme-brulee"]];\nfor (const [i, want] of cases) if (slugify(i) !== want) { console.error(`slugify(${JSON.stringify(i)}) = ${JSON.stringify(slugify(i))}, expected ${JSON.stringify(want)}`); process.exit(1); }\n';

// ---------------------------------------------------------------- cases

export const cases: Record<string, () => Promise<unknown>> = {
  'reviewer-sql-injection': () => review({
    'src/users.js': 'import { db } from "./db.js";\n\nexport function findUserByName(name) {\n  return db.prepare(`SELECT * FROM users WHERE name = \'${name}\'`).get();\n}\n',
    'test/users.test.js': USERS_TEST,
  }),
  'reviewer-clean': () => review({
    'src/users.js': 'import { db } from "./db.js";\n\nconst byName = db.prepare("SELECT id, name, email FROM users WHERE name = ?");\n\n/** The user with this exact name, or undefined. */\nexport function findUserByName(name) {\n  return byName.get(name);\n}\n',
    'test/users.test.js': USERS_TEST,
  }),
  'manager-diagnosable': () => manage(
    { 'check.mjs': SLUG_CHECK, 'slugify.mjs': 'export function slugify(s) { throw new Error("todo"); }\n' },
    { 'slugify.mjs': 'export function slugify(s) { return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }\n' },
    '## Task T-001: Implement slugify\n\nImplement slugify(s) in slugify.mjs: lowercase, words joined by "-", no punctuation.\n\nAcceptance criteria:\n- node check.mjs passes',
    ['checks', 'checks'],
    'Deterministic checks failed:\n$ node check.mjs  (check, exit 1)\nslugify("Crème Brûlée") = "cr-me-br-l-e", expected "creme-brulee"',
  ),
  'manager-ambiguous': () => manage(
    { 'src/invoice.js': 'export function total(lines) { return lines.reduce((s, l) => s + l.qty * l.price, 0); }\n', 'test/invoice.test.js': 'import test from "node:test";\n' },
    { 'src/invoice.js': 'export function total(lines) { const t = lines.reduce((s, l) => s + l.qty * l.price, 0); return Math.round(t * 100) / 100; }\n' },
    '## Task T-004: Round invoice totals\n\nInvoice totals must be rounded according to the finance team\'s rounding policy before display and export.\n\nAcceptance criteria:\n- totals follow the finance rounding policy\n- tests cover the policy\'s edge cases',
    ['review', 'review'],
    'Code review requested changes:\n{"decision":"changes_required","summary":"The task requires the finance team\'s rounding policy, but neither the brief, the repository nor the source document defines it (half-up vs banker\'s rounding, per line vs per invoice, currency precision). The implementation guesses half-up per invoice.","findings":[{"severity":"high","file":"src/invoice.js","explanation":"Rounding mode is a guess; the policy is unspecified","recommendation":"Confirm the policy with the finance team"}]}',
  ),
  'analyst-sample-prd': async () => {
    const f = await fixture({
      'package.json': JSON.stringify({ name: 'text-toolkit', type: 'module', scripts: { test: 'node --test', typecheck: 'tsc --noEmit' } }, null, 2),
      'src/index.ts': 'export const add = (a: number, b: number) => a + b;\n',
    });
    const input = join(f.scratch, 'input');
    await mkdir(input);
    await writeFile(join(input, 'document.md'), await readFile(join(ROOT, 'examples/sample-prd.md'), 'utf8'));
    const s = await session(f, { claude: true }, {
      contextDirs: [input],
      analyst: ctx => new ClaudeStructured(ctx, { model: config.models.analyst, timeoutMs: config.timeouts.analyzeMs, maxBudgetUsd: config.analystBudgetUsd, jsonSchema: backlogJsonSchema(), addDirs: [input] }),
    });
    try {
      const raw = await s.callAgent('analyst', s.agents.analyst!, prompts.analyze({ documentPath: join(input, 'document.md'), maxTasks: 10 }), f.repo, f.scratch, 'analyst');
      return parseBacklog(JSON.parse(raw), { maxTasks: 10 }); // throws on an invalid backlog
    } finally { await s.close(); }
  },
};

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const name = process.argv[2];
  const run = cases[name];
  if (!run) { console.error(`unknown case ${name}; one of: ${Object.keys(cases).join(', ')}`); process.exit(2); }
  try {
    console.log(JSON.stringify({ ok: true, result: await run() }));
  } catch (error) {
    // Parser rejections are eval failures, not crashes.
    console.log(JSON.stringify({ ok: false, error: (error as Error).message.slice(0, 2_000) }));
  }
}
