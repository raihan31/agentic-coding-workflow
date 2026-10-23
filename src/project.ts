import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import pLimit from 'p-limit';
import { AgentError, ClaudeStructured, RateLimitedError, type Agent } from './adapters.js';
import { backlogJsonSchema, BacklogError, parseBacklog, renderBacklogMarkdown, taskOrder, unansweredBlockingQuestions, type Backlog, type Task } from './backlog.js';
import type { CheckRunner } from './checks.js';
import { parseConfig, type Config } from './config.js';
import type { RunCredentials } from './credentials.js';
import { documentFormat, loadDocument, type DocumentFormat } from './documents.js';
import { attemptTask, BudgetExceeded, openSession, planTask, type AttemptResult, type EngineEvent, type Gate, type Session, type TaskInput } from './engine.js';
import { addWorktree, assertCleanRepoRoot, commitAll, discardChanges, headSha } from './git.js';
import { createLogger, type Logger } from './log.js';
import { guidanceSection } from './guidance.js';
import { managerJsonSchema, ManagerDecisionError, parseDecision, type ManagerDecision, type Subtask } from './manager.js';
import { PROMPT_VERSION, prompts } from './prompts.js';
import type { AgentRuntime } from './runtime.js';
import type { SecurityScanner } from './security.js';
import { FileStore, writeJson, type ProjectStore } from './store.js';
import { instruments, withSpan } from './telemetry.js';

export type ProjectStatus = 'backlog_ready' | 'needs_answers' | 'running' | 'paused' | 'rate_limited' | 'needs_attention' | 'completed' | 'partial' | 'integration_failed' | 'budget_exceeded' | 'cancelled' | 'failed';
export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'needs_attention';
/** Advice added to a task's brief after a failure, by the manager agent or a human. */
export interface Guidance { from: 'manager' | 'human'; text: string; at: string; }
export interface TaskState {
  status: TaskStatus; attempts: number; commit?: string; baseSha?: string; dir?: string;
  startedAt?: string; finishedAt?: string; error?: string; reviewSummary?: string;
  /** Manager decisions taken for this task in the current run. */
  interventions?: number;
  guidance?: Guidance[];
  /** An escalated task's open question for a human. */
  question?: string;
}
export interface Invocation { command: 'analyze' | 'run'; runId: string; startedAt: string; finishedAt?: string; status?: ProjectStatus; costUsd?: number; costSource?: string; tokens?: { input: number; output: number }; }
export interface ProjectState {
  id: string; status: ProjectStatus; repo: string; worktree: string; branch: string; baseSha: string;
  document: { name: string; format: DocumentFormat; sha256: string; warnings: string[] };
  promptVersion: string; createdAt: string; updatedAt: string;
  approval?: { approvedAt: string; backlogSha256: string };
  integration?: { passed: boolean; at: string };
  /** Branch push / pull request, when delivery is enabled. */
  delivery?: { pushedAt?: string; remote?: string; prUrl?: string; prNumber?: number; error?: string };
  tasks: Record<string, TaskState>;
  invocations: Invocation[];
  error?: string;
}

/** Overrides for tests or custom wiring; anything omitted is built from the config. */
export interface ProjectDeps {
  analyst?: Agent; planner?: Agent; developer?: Agent; reviewer?: Agent; manager?: Agent;
  checkRunner?: CheckRunner; runtime?: AgentRuntime; credentials?: RunCredentials; scanner?: SecurityScanner; logger?: Logger;
  /** Defaults to the file store; pass a MultiStore to mirror into Postgres. */
  store?: ProjectStore;
}

/** The backlog cannot be run as it stands (missing, invalid, or blocking questions unanswered); a human must act. */
export class ProjectValidationError extends Error { constructor(message: string) { super(message); this.name = 'ProjectValidationError'; } }

const NO_CHECKS: CheckRunner = { kind: 'none', prepare: async () => {}, runAll: async () => [] };
const now = () => new Date().toISOString();
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export const projectPaths = (dir: string) => ({
  dir,
  state: join(dir, 'state.json'),
  config: join(dir, 'config.json'),
  backlog: join(dir, 'backlog.json'),
  backlogMd: join(dir, 'backlog.md'),
  input: join(dir, 'input'),
  document: join(dir, 'input', 'document.md'),
  worktree: join(dir, 'worktree'),
  tasks: join(dir, 'tasks'),
  lock: join(dir, 'run.lock'),
});

export async function readProject(dir: string): Promise<{ state: ProjectState; config: Config; backlog?: Backlog; backlogRaw?: string }> {
  const p = projectPaths(resolve(dir));
  const state = JSON.parse(await readFile(p.state, 'utf8')) as ProjectState;
  const config = parseConfig(JSON.parse(await readFile(p.config, 'utf8')));
  const backlogRaw = await readFile(p.backlog, 'utf8').catch(() => undefined);
  return { state, config, backlogRaw, backlog: backlogRaw ? parseBacklog(JSON.parse(backlogRaw), { maxTasks: config.project.maxTasks }) : undefined };
}

/** State + event plumbing shared by every step. */
class Tracker {
  constructor(readonly dir: string, readonly state: ProjectState, private store: ProjectStore, private runId?: string) {}
  async save(): Promise<void> {
    this.state.updatedAt = now();
    await this.store.saveState(this.dir, this.state);
  }
  async event(type: string, data: Record<string, unknown> = {}, taskId?: string): Promise<void> {
    await this.store.appendEvent(this.dir, { projectId: this.state.id, runId: this.runId, taskId, type, data, at: now() });
  }
  async setStatus(status: ProjectStatus, error?: string): Promise<void> {
    this.state.status = status;
    if (error) this.state.error = error; else delete this.state.error;
    await this.save();
    await this.event('project.status', { status, ...(error ? { error } : {}) });
  }
  async setTask(id: string, patch: Partial<TaskState>): Promise<void> {
    Object.assign(this.state.tasks[id], patch);
    await this.save();
    const t = this.state.tasks[id];
    await this.event('task.status', { status: t.status, attempts: t.attempts, ...(t.commit ? { commit: t.commit } : {}), ...(t.error ? { error: t.error } : {}) }, id);
  }
  /** Engine events (agent calls, checks, reviews) go to the same stream. */
  engineHandler = (e: EngineEvent) => { const { type, taskId, ...data } = e; return this.event(type, data, taskId); };
}

async function tracker(dir: string, store: ProjectStore, runId?: string): Promise<Tracker> {
  return new Tracker(dir, (await readProject(dir)).state, store, runId);
}

/** One local runner per project. A lock left by a dead process is taken over. */
async function acquireLock(path: string): Promise<() => Promise<void>> {
  for (let i = 0; i < 2; i++) {
    try {
      const handle = await open(path, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return () => rm(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(path, 'utf8').catch(() => ''));
      let alive = false;
      try { if (pid) { process.kill(pid, 0); alive = true; } } catch { /* dead */ }
      if (alive) throw new Error(`Project is already being run by process ${pid} (${path})`);
      await rm(path, { force: true });
    }
  }
  throw new Error(`Could not lock ${path}`);
}

// ---------------------------------------------------------------- analyze

export interface AnalyzeOptions extends ProjectDeps { repo: string; document: string; config: Config; runRoot: string; /** Defaults to a random proj-* id. */ id?: string; }

/** Document → validated backlog on a fresh project branch. Stops at the backlog-approval gate. */
export async function analyzeProject(opts: AnalyzeOptions): Promise<ProjectState> {
  const { config } = opts;
  const doc = await loadDocument(opts.document); // fail before any spend
  const repo = await assertCleanRepoRoot(opts.repo);
  const id = opts.id ?? `proj-${randomBytes(4).toString('hex')}`;
  const p = projectPaths(join(resolve(opts.runRoot), id));
  const store = opts.store ?? new FileStore();
  const log = (opts.logger ?? createLogger()).child({ project_id: id });
  const baseSha = await headSha(repo);
  const invocation: Invocation = { command: 'analyze', runId: id, startedAt: now() };
  const state: ProjectState = {
    id, status: 'backlog_ready', repo, worktree: p.worktree, branch: `${config.project.branchPrefix}${id}`, baseSha, promptVersion: PROMPT_VERSION, createdAt: now(), updatedAt: now(),
    document: { name: opts.document.split('/').pop()!, format: doc.format, sha256: doc.sha256, warnings: doc.warnings },
    tasks: {}, invocations: [invocation],
  };
  const track = new Tracker(p.dir, state, store, id);
  const session = await openSession({
    config, runId: id, dir: p.dir, logger: log, needClaude: !opts.analyst, needCodex: false, contextDirs: [p.input], onEvent: track.engineHandler,
    analyst: opts.analyst ?? (ctx => new ClaudeStructured(ctx, { model: config.models.analyst, timeoutMs: config.timeouts.analyzeMs, passEnv: config.agentEnv, maxBudgetUsd: config.analystBudgetUsd, jsonSchema: backlogJsonSchema(), addDirs: [p.input] })),
    checkRunner: NO_CHECKS, runtime: opts.runtime, credentials: opts.credentials,
  });

  return await withSpan('agentic.project.analyze', { 'agentic.project_id': id, 'agentic.document.format': doc.format }, async () => {
    try {
      await mkdir(p.input, { recursive: true });
      const original = join(p.input, `original${extname(opts.document).toLowerCase()}`);
      await copyFile(opts.document, original);
      await writeFile(p.document, doc.text);
      await writeJson(p.config, config);
      await addWorktree(repo, p.worktree, baseSha, state.branch);
      await track.save();
      await track.event('project.created', { repo, branch: state.branch, document: state.document.name });
      for (const w of doc.warnings) log.warn(w);

      log.info({ phase: 'analyze' }, 'analyzing document');
      const basePrompt = prompts.analyze({ documentPath: p.document, originalPath: doc.format === 'markdown' || doc.format === 'text' ? undefined : original, maxTasks: config.project.maxTasks });
      let backlog: Backlog | undefined;
      let lastError = '';
      for (let i = 0; i < 2 && !backlog; i++) {
        const prompt = lastError ? `${basePrompt}\n\nYour previous backlog was rejected. Fix these problems:\n${lastError}` : basePrompt;
        try {
          backlog = parseBacklog(JSON.parse(await session.callAgent('analyst', session.agents.analyst!, prompt, p.worktree, p.dir, i === 0 ? 'analyst' : 'analyst-retry')), { maxTasks: config.project.maxTasks });
        } catch (error) {
          if (!(error instanceof BacklogError || error instanceof AgentError || error instanceof SyntaxError)) throw error;
          lastError = message(error).slice(0, 4_000);
          log.warn({ problems: lastError.slice(0, 1_000) }, 'backlog rejected');
        }
      }
      if (!backlog) throw new Error(`Analyst failed to produce a valid backlog twice: ${lastError}`);
      await store.saveBacklog(p.dir, id, backlog);
      await writeFile(p.backlogMd, renderBacklogMarkdown(backlog));
      for (const t of backlog.tasks) state.tasks[t.id] = { status: 'pending', attempts: 0 };
      await track.event('backlog.ready', { requirements: backlog.requirements.length, tasks: backlog.tasks.length, openQuestions: backlog.openQuestions.length });
      await track.setStatus(unansweredBlockingQuestions(backlog).length ? 'needs_answers' : 'backlog_ready');
      log.info({ requirements: backlog.requirements.length, tasks: backlog.tasks.length, open_questions: backlog.openQuestions.length, status: state.status }, `backlog ready for review: ${p.backlogMd}`);
    } catch (error) {
      await track.setStatus(stoppedStatus(error), message(error)).catch(() => {});
      if (!(error instanceof BudgetExceeded || error instanceof RateLimitedError)) throw error;
    } finally {
      await closeInvocation(session, track, invocation);
    }
    return state;
  });
}

/**
 * Service mode: analysis failed before the project existed (bad credentials, sandbox unavailable...). Records a
 * minimal failed project so the UI and API show why, instead of the failure living only in worker logs.
 */
export async function recordFailedStart(opts: { id: string; repo: string; document: string; runRoot: string }, error: unknown, store: ProjectStore): Promise<void> {
  const p = projectPaths(join(resolve(opts.runRoot), opts.id));
  const existing = await readFile(p.state, 'utf8').then(t => JSON.parse(t) as ProjectState, () => undefined);
  if (existing?.branch) return; // the project got far enough to record its own status
  // Otherwise a placeholder (overwritten if a retry of the analysis succeeds).
  const name = opts.document.split('/').pop()!.replace(/^[0-9a-f]{12}-/, ''); // uploads are stored as <random>-<name>
  let format: DocumentFormat = 'markdown';
  try { format = documentFormat(name); } catch { /* keep the default */ }
  const state: ProjectState = {
    id: opts.id, status: 'failed', repo: opts.repo, worktree: p.worktree, branch: '', baseSha: '', promptVersion: PROMPT_VERSION,
    document: { name, format, sha256: '', warnings: [] }, createdAt: now(), updatedAt: now(), tasks: {}, invocations: [], error: message(error),
  };
  await mkdir(p.dir, { recursive: true });
  const track = new Tracker(p.dir, state, store, opts.id);
  await track.save();
  await track.event('project.status', { status: 'failed', error: message(error) });
}

const stoppedStatus = (error: unknown): ProjectStatus =>
  error instanceof BudgetExceeded ? 'budget_exceeded' : error instanceof RateLimitedError ? 'rate_limited' : 'failed';

async function closeInvocation(session: Session, track: Tracker, inv: Invocation): Promise<void> {
  const cost = await session.close();
  Object.assign(inv, { finishedAt: now(), status: track.state.status, tokens: { ...session.tokens }, ...cost });
  instruments().projects.add(1, { command: inv.command, status: track.state.status });
  await track.save().catch(() => {});
}

/** Records product-owner answers to open questions in backlog.json (e.g. from the UI). */
export async function applyAnswers(dir: string, answers: Record<string, string>, store: ProjectStore = new FileStore()): Promise<{ unanswered: string[] }> {
  const { backlog, state } = await readProject(dir);
  if (!backlog) throw new Error(`No backlog in ${dir}`);
  for (const [qid, answer] of Object.entries(answers)) {
    const q = backlog.openQuestions.find(x => x.id === qid);
    if (!q) throw new Error(`Unknown question ${qid}`);
    q.answer = answer;
  }
  await store.saveBacklog(dir, state.id, backlog);
  await writeFile(projectPaths(dir).backlogMd, renderBacklogMarkdown(backlog));
  const unanswered = unansweredBlockingQuestions(backlog).map(q => q.id);
  const track = new Tracker(dir, state, store);
  await track.event('backlog.answered', { questions: Object.keys(answers) });
  if (state.status === 'needs_answers' && !unanswered.length) await track.setStatus('backlog_ready');
  return { unanswered };
}

// ---------------------------------------------------------------- run steps

/** The task brief every agent sees: the task, the requirements it implements, answered questions and project context. */
export function taskBrief(backlog: Backlog, task: Task, done: Task[], documentPath: string, guidance: Guidance[] = []): string {
  const reqs = backlog.requirements.filter(r => task.requirementIds.includes(r.id));
  const answers = backlog.openQuestions.filter(q => q.answer?.trim() && (q.requirementIds.some(r => task.requirementIds.includes(r)) || !q.requirementIds.length));
  const later = taskOrder(backlog.tasks).filter(t => t.id !== task.id && !done.includes(t));
  return [
    `Project: ${backlog.summary}`, '',
    `## Task ${task.id}: ${task.title}`, '', task.description, '',
    'Acceptance criteria:', ...task.acceptanceCriteria.map(a => `- ${a}`), '',
    ...(reqs.length ? ['Implements these requirements:', ...reqs.map(r => `- ${r.id} (${r.priority}): ${r.title}: ${r.description}`), ''] : []),
    ...(answers.length ? ['Clarifications from the product owner:', ...answers.map(q => `- ${q.question} → ${q.answer}`), ''] : []),
    ...(done.length ? ['Already completed and committed on this branch (build on them, do not redo them):', ...done.map(t => `- ${t.id}: ${t.title}`), ''] : []),
    ...(later.length ? ['Planned for later tasks (do not implement now):', ...later.map(t => `- ${t.id}: ${t.title}`), ''] : []),
    `The full source document is available read-only at ${documentPath}.`,
    'Implement only this task, include tests for it, and keep the build and all existing tests passing.',
  ].join('\n') + guidanceSection(guidance);
}

export interface RunPlan { order: { id: string; dependsOn: string[] }[]; maxRepairs: number; maxConcurrency?: number; }

/** Approval gate + run setup: validates the (possibly edited) backlog, resets non-done tasks, cleans the worktree. */
export async function beginRun(dir: string, runId: string, store: ProjectStore): Promise<RunPlan> {
  let loaded: Awaited<ReturnType<typeof readProject>>;
  try { loaded = await readProject(dir); } catch (error) {
    if (error instanceof BacklogError) throw new ProjectValidationError(`backlog.json is invalid after editing:\n${error.message}`);
    throw error;
  }
  if (!loaded.backlog || !loaded.backlogRaw) throw new ProjectValidationError(`No backlog in ${dir}; analyze the document first`);
  const backlog = loaded.backlog;
  const unanswered = unansweredBlockingQuestions(backlog);
  if (unanswered.length) throw new ProjectValidationError(`Answer the blocking questions in ${projectPaths(dir).backlog} (fill "answer") before running:\n${unanswered.map(q => `- ${q.id}: ${q.question}`).join('\n')}`);
  const track = new Tracker(dir, loaded.state, store, runId);
  const s = track.state;
  s.approval = { approvedAt: now(), backlogSha256: sha256(loaded.backlogRaw) };
  s.invocations.push({ command: 'run', runId, startedAt: now() });
  for (const t of backlog.tasks) {
    // Failed and blocked tasks are retried on every run; tasks added by editing the backlog start pending.
    // Human guidance carries over to the retry; manager decisions start afresh.
    if (s.tasks[t.id]?.status !== 'done') {
      const human = s.tasks[t.id]?.guidance?.filter(g => g.from === 'human');
      s.tasks[t.id] = { status: 'pending', attempts: 0, ...(human?.length ? { guidance: human } : {}) };
    }
  }
  for (const id of Object.keys(s.tasks)) if (!backlog.tasks.some(t => t.id === id)) delete s.tasks[id];
  await discardChanges(s.worktree); // a crashed run may have left a task half-done
  await track.event('backlog.approved', { backlogSha256: s.approval.backlogSha256 });
  await track.setStatus('running');
  return { order: taskOrder(backlog.tasks).map(t => ({ id: t.id, dependsOn: t.dependsOn })), maxRepairs: loaded.config.maxRepairs, maxConcurrency: loaded.config.project.maxConcurrency };
}

export type TaskStart = { kind: 'skip' } | { kind: 'blocked'; waitingOn: string[] } | { kind: 'ready'; input: TaskInput };

/** Decides whether a task can run now; if so marks it running and returns its brief and base commit. */
export async function startTask(dir: string, runId: string, taskId: string, store: ProjectStore): Promise<TaskStart> {
  const { backlog } = await readProject(dir);
  const track = await tracker(dir, store, runId);
  const s = track.state;
  if (s.tasks[taskId].status === 'done') return { kind: 'skip' };
  const task = backlog!.tasks.find(t => t.id === taskId)!;
  const missing = task.dependsOn.filter(d => s.tasks[d]?.status !== 'done');
  if (missing.length) {
    await track.setTask(taskId, { status: 'blocked', error: `waiting on ${missing.join(', ')}`, finishedAt: now() });
    instruments().tasks.add(1, { status: 'blocked' });
    return { kind: 'blocked', waitingOn: missing };
  }
  const p = projectPaths(dir);
  const baseSha = await headSha(p.worktree);
  const taskDir = join(p.tasks, taskId, runId);
  const done = backlog!.tasks.filter(t => s.tasks[t.id].status === 'done');
  await track.setTask(taskId, { status: 'running', attempts: 0, baseSha, dir: taskDir, startedAt: now(), finishedAt: undefined, error: undefined, commit: undefined, reviewSummary: undefined, question: undefined });
  return { kind: 'ready', input: { worktree: p.worktree, dir: taskDir, requirement: taskBrief(backlog!, task, done, p.document, s.tasks[taskId].guidance), baseSha, taskId } };
}

export type NextTask = { kind: 'none' } | (TaskStart & { taskId: string });

/** Starts the earliest task (in dependency order) not yet visited in this run. The backlog may have grown by a split. */
export async function startNextTask(dir: string, runId: string, store: ProjectStore): Promise<NextTask> {
  const { backlog, state } = await readProject(dir);
  const next = taskOrder(backlog!.tasks).find(t => state.tasks[t.id]?.status === 'pending');
  if (!next) return { kind: 'none' };
  return { ...await startTask(dir, runId, next.id, store), taskId: next.id };
}

/** Finds all tasks currently ready to run in parallel (pending and all dependencies satisfied). */
export async function getReadyTasks(dir: string, runId: string, store: ProjectStore): Promise<(TaskStart & { taskId: string })[]> {
  const { backlog, state } = await readProject(dir);
  const pending = backlog!.tasks.filter(t => state.tasks[t.id]?.status === 'pending');
  const ready: (TaskStart & { taskId: string })[] = [];
  for (const t of pending) {
    const unfulfilled = t.dependsOn.filter(d => state.tasks[d]?.status !== 'done');
    if (unfulfilled.length === 0) {
      const res = await startTask(dir, runId, t.id, store);
      if (res.kind === 'ready') {
        ready.push({ ...res, taskId: t.id });
      }
    }
  }
  return ready;
}

/** What the drivers report when a task has used up its repairs. `requirement` is the brief of the last round. */
export interface TaskFailure { requirement: string; attempts: number; gates: Gate[]; feedback: string; reviewSummary?: string; }

/**
 * The manager agent decides what happens to a task that exhausted its repairs. A retry's guidance is recorded and the
 * failed changes are discarded here; the caller applies split, escalate and skip. Never throws for a bad decision:
 * it falls back to skip, which is the behavior without a manager.
 */
export async function superviseTask(session: Session | undefined, dir: string, runId: string, taskId: string, failure: TaskFailure, store: ProjectStore): Promise<ManagerDecision> {
  const { backlog, config } = await readProject(dir);
  const track = await tracker(dir, store, runId);
  const t = track.state.tasks[taskId];
  const m = config.manager;
  const used = t.interventions ?? 0;
  const manager = session?.agents.manager;
  if (!m.enabled || !manager) return { decision: 'skip', rationale: 'no manager agent configured' };
  if (used >= m.maxInterventions) return { decision: 'skip', rationale: `the manager already intervened ${used} time${used === 1 ? '' : 's'} on this task` };

  const capacity = config.project.maxTasks - backlog!.tasks.length + 1;
  const limits = { allowSplit: m.allowSplit && capacity >= 2, allowEscalate: m.allowEscalate, maxSubtasks: Math.min(5, capacity) };
  const taskDir = t.dir ?? join(projectPaths(dir).tasks, taskId, runId);
  const prompt = prompts.manage({
    requirement: failure.requirement, taskDir, feedback: failure.feedback.slice(0, 12_000), reviewSummary: failure.reviewSummary,
    history: failure.gates.map((g, i) => `- attempt ${i + 1}: ${g}`).join('\n') || '- (none)', remaining: m.maxInterventions - used, ...limits,
  });
  let decision: ManagerDecision | undefined;
  let lastError = '';
  for (let i = 0; i < 2 && !decision; i++) {
    try {
      const full = lastError ? `${prompt}\n\nYour previous decision was rejected (${lastError}). Fix it.` : prompt;
      decision = parseDecision(await session!.callAgent('manager', manager, full, track.state.worktree, taskDir, `manager-${used}${i ? '-retry' : ''}`, taskId), limits);
    } catch (error) {
      if (!(error instanceof AgentError || error instanceof ManagerDecisionError)) throw error;
      lastError = message(error).slice(0, 1_000);
    }
  }
  decision ??= { decision: 'skip', rationale: `the manager could not reach a valid decision: ${lastError}` };
  await mkdir(taskDir, { recursive: true });
  await writeJson(join(taskDir, `manager-${used}.json`), decision);
  t.interventions = used + 1;
  if (decision.decision === 'retry') {
    t.guidance = [...t.guidance ?? [], { from: 'manager', text: decision.guidance!, at: now() }];
    await discardChanges(track.state.worktree); // the next round starts from the task's base commit
  }
  await track.save();
  await track.event('manager.decision', {
    decision: decision.decision, rationale: decision.rationale, intervention: used + 1,
    ...(decision.guidance ? { guidance: decision.guidance } : {}), ...(decision.question ? { question: decision.question } : {}),
    ...(decision.subtasks ? { subtasks: decision.subtasks.map(x => x.title) } : {}),
  }, taskId);
  instruments().managerDecisions.add(1, { decision: decision.decision });
  session!.log.info({ task: taskId, decision: decision.decision }, `manager: ${decision.decision}: ${decision.rationale.slice(0, 200)}`);
  return decision;
}

/**
 * Replaces a failed task with sequential subtasks: the first inherits its dependencies, tasks that depended on it
 * now depend on the last one, and requirement links carry over, so coverage and order stay valid.
 */
export async function splitTask(dir: string, runId: string, taskId: string, subtasks: Subtask[], store: ProjectStore): Promise<string[]> {
  const { backlog, config } = await readProject(dir);
  const track = await tracker(dir, store, runId);
  const s = track.state;
  const index = backlog!.tasks.findIndex(t => t.id === taskId);
  const original = backlog!.tasks[index];
  const taken = new Set(backlog!.tasks.map(t => t.id));
  let n = 0;
  const nextId = () => { let id; do id = `${taskId}.${++n}`; while (taken.has(id)); return id; };
  const created: Task[] = [];
  for (const sub of subtasks) {
    created.push({
      id: nextId(), title: sub.title, description: sub.description, acceptanceCriteria: sub.acceptanceCriteria,
      requirementIds: original.requirementIds, dependsOn: created.length ? [created[created.length - 1].id] : original.dependsOn,
      size: 'S', risk: original.risk, splitFrom: taskId,
    });
  }
  const last = created[created.length - 1].id;
  const tasks = [...backlog!.tasks.slice(0, index), ...created, ...backlog!.tasks.slice(index + 1)]
    .map(t => ({ ...t, dependsOn: t.dependsOn.map(d => d === taskId ? last : d) }));
  const updated = parseBacklog({ ...backlog, tasks }, { maxTasks: config.project.maxTasks });
  await discardChanges(s.worktree);
  await store.saveBacklog(dir, s.id, updated);
  await writeFile(projectPaths(dir).backlogMd, renderBacklogMarkdown(updated));
  const guidance = s.tasks[taskId]?.guidance?.filter(g => g.from === 'human');
  delete s.tasks[taskId];
  for (const t of created) s.tasks[t.id] = { status: 'pending', attempts: 0, ...(guidance?.length ? { guidance } : {}) };
  await track.save();
  await track.event('task.split', { into: created.map(t => ({ id: t.id, title: t.title })) }, taskId);
  return created.map(t => t.id);
}

/** Parks a task on a question for a human; its failed changes are discarded. */
export async function escalateTask(dir: string, runId: string, taskId: string, question: string, store: ProjectStore, opts: { waitForHuman: boolean }): Promise<void> {
  const track = await tracker(dir, store, runId);
  await discardChanges(track.state.worktree);
  await track.setTask(taskId, { status: 'needs_attention', question, error: `needs your input: ${question}`, finishedAt: now() });
  await track.event('task.escalated', { question }, taskId);
  if (opts.waitForHuman) await track.setStatus('needs_attention', `${taskId} needs your input: ${question}`);
}

export interface GuideInput { taskId: string; action: 'retry' | 'skip'; guidance?: string; }

/** A human's answer to an escalation (or advice for a failed task before re-running). */
export async function guideTask(dir: string, runId: string | undefined, g: GuideInput, store: ProjectStore): Promise<void> {
  const track = await tracker(dir, store, runId);
  const t = track.state.tasks[g.taskId];
  if (!t) throw new ProjectValidationError(`Unknown task ${g.taskId}`);
  if (t.status === 'done') throw new ProjectValidationError(`${g.taskId} is already done`);
  if (g.guidance?.trim()) t.guidance = [...t.guidance ?? [], { from: 'human', text: g.guidance.trim(), at: now() }];
  delete t.question;
  await track.save();
  await track.event('task.guided', { action: g.action, ...(g.guidance?.trim() ? { guidance: g.guidance.trim() } : {}) }, g.taskId);
}

/** Commits a passing task, or discards a failing one's changes. */
export async function completeTask(dir: string, runId: string, taskId: string, outcome: { passed: boolean; attempts: number; reviewSummary?: string; note?: string }, store: ProjectStore): Promise<TaskStatus> {
  const { backlog, config } = await readProject(dir);
  const track = await tracker(dir, store, runId);
  const s = track.state;
  const task = backlog!.tasks.find(t => t.id === taskId)!;
  const patch: Partial<TaskState> = { attempts: outcome.attempts, reviewSummary: outcome.reviewSummary, finishedAt: now() };
  if (outcome.passed) {
    const msg = `${task.id}: ${task.title}\n\n${task.description}\n\nTask: ${task.id}\nRequirements: ${task.requirementIds.join(', ') || '-'}\nProject: ${s.id}`;
    patch.commit = await commitAll(s.worktree, msg, config.project.gitAuthor);
    patch.status = 'done';
  } else {
    await discardChanges(s.worktree);
    patch.status = 'failed';
    patch.error = `checks or review still failing after ${outcome.attempts} attempts${outcome.note ? ` (${outcome.note})` : ''}; see ${s.tasks[taskId].dir}`;
    patch.question = undefined;
  }
  await track.setTask(taskId, patch);
  instruments().tasks.add(1, { status: patch.status });
  return patch.status;
}

/** An infrastructure stop mid-task (budget, rate limit, crash, cancel): drop partial work; the task reruns next time. */
export async function abandonTask(dir: string, runId: string, taskId: string, reason: string, store: ProjectStore): Promise<void> {
  const track = await tracker(dir, store, runId);
  await discardChanges(track.state.worktree).catch(() => {});
  if (!track.state.tasks[taskId]) return; // replaced by a split
  await track.setTask(taskId, { status: 'pending', error: reason, finishedAt: now() });
}

/** Integration checks (when anything was built), final status, reports. `stopped` carries the reason if the run ended early. */
export async function finishRun(dir: string, runId: string, session: Session | undefined, store: ProjectStore, stopped?: { status: ProjectStatus; error: string }): Promise<ProjectState> {
  const { backlog, config } = await readProject(dir);
  const track = await tracker(dir, store, runId);
  const s = track.state;
  const doneCount = backlog!.tasks.filter(t => s.tasks[t.id].status === 'done').length;
  if (!stopped && doneCount && session) {
    const checks = await session.checkRunner.runAll(s.worktree, config.checks, config.timeouts.checkMs);
    await writeJson(join(dir, 'integration-checks.json'), checks);
    s.integration = { passed: checks.every(c => c.code === 0), at: now() };
    await track.event('integration.finished', { passed: s.integration.passed });
  }
  const waiting = backlog!.tasks.some(t => s.tasks[t.id].status === 'needs_attention');
  const status: ProjectStatus = stopped?.status ?? (waiting ? 'needs_attention' : doneCount < backlog!.tasks.length ? 'partial' : s.integration?.passed === false ? 'integration_failed' : 'completed');
  await track.setStatus(status, stopped?.error);
  const inv = [...s.invocations].reverse().find(i => i.runId === runId);
  if (session && inv) await closeInvocation(session, track, inv);
  await writeReports(dir, s, backlog!);
  await track.event('run.finished', { status, costUsd: inv?.costUsd ?? 0 });
  return s;
}

/** Engine session for a project run: project config, the document mounted read-only, events into the store. */
export async function openRunSession(dir: string, runId: string, store: ProjectStore, deps: ProjectDeps & { config?: Config; logger: Logger }): Promise<Session> {
  const loaded = await readProject(dir);
  const config = deps.config ?? loaded.config;
  const p = projectPaths(dir);
  const track = new Tracker(dir, loaded.state, store, runId);
  const buildManager = config.manager.enabled && !deps.manager;
  await mkdir(p.tasks, { recursive: true }); // mounted for the manager; a missing bind source would be created as root
  return await openSession({
    config, runId, dir: join(dir, 'runs', runId), logger: deps.logger, contextDirs: [p.input], onEvent: track.engineHandler,
    needClaude: !deps.planner || buildManager, needCodex: !deps.developer || !deps.reviewer,
    planner: deps.planner, developer: deps.developer, reviewer: deps.reviewer, managerDirs: [p.tasks],
    manager: deps.manager ?? (buildManager ? ctx => new ClaudeStructured(ctx, {
      model: config.models.manager, timeoutMs: config.timeouts.managerMs, passEnv: config.agentEnv, maxBudgetUsd: config.manager.budgetUsd,
      jsonSchema: managerJsonSchema(), addDirs: [p.input, p.tasks],
    }) : undefined),
    checkRunner: deps.checkRunner, runtime: deps.runtime, credentials: deps.credentials, scanner: deps.scanner,
  });
}

/** Status changes driven from outside a step (pause, rate-limit wait). */
export async function setProjectStatus(dir: string, runId: string, status: ProjectStatus, store: ProjectStore, note?: string): Promise<void> {
  const track = await tracker(dir, store, runId);
  await track.setStatus(status, note);
}

export const isStop = (error: unknown) => error instanceof BudgetExceeded || error instanceof RateLimitedError;

// ---------------------------------------------------------------- local driver

export interface RunProjectOptions extends ProjectDeps { projectDir: string; /** Overrides the config saved at analyze time. */ config?: Config; }

async function executeTaskWithLifecycle(
  dir: string,
  runId: string,
  start: { kind: 'ready'; input: TaskInput; taskId: string },
  session: Session,
  plan: RunPlan,
  log: Logger,
  store: ProjectStore
): Promise<void> {
  const id = start.taskId;
  const tlog = log.child({ task: id });
  tlog.info(`task ${id}`);
  await withSpan('agentic.task', { 'agentic.task_id': id }, async span => {
    try {
      const s = { ...session, log: tlog };
      let input = start.input;
      let attempts = 0;
      for (let round = 0; ; round++) {
        const planText = await planTask(s, { ...input, round });
        let feedback = '';
        let result: AttemptResult | undefined;
        const gates: Gate[] = [];
        for (let i = 0; i <= plan.maxRepairs; i++) {
          result = await attemptTask(s, input, planText, feedback, attempts++);
          gates.push(result.gate);
          if (result.gate === 'passed') break;
          feedback = result.feedback;
        }
        if (result?.gate === 'passed') {
          await completeTask(dir, runId, id, { passed: true, attempts, reviewSummary: result.review?.summary }, store);
          break;
        }
        const decision = await superviseTask(session, dir, runId, id, { requirement: input.requirement, attempts, gates, feedback, reviewSummary: result?.review?.summary }, store);
        if (decision.decision === 'retry') {
          input = { ...input, requirement: input.requirement + guidanceSection([{ from: 'manager', text: decision.guidance! }]) };
          continue;
        }
        if (decision.decision === 'split') {
          await splitTask(dir, runId, id, decision.subtasks!, store).catch(async error => {
            if (!(error instanceof BacklogError)) throw error;
            await completeTask(dir, runId, id, { passed: false, attempts, note: `the manager's split was invalid: ${message(error).slice(0, 300)}` }, store);
          });
        } else if (decision.decision === 'escalate') {
          await escalateTask(dir, runId, id, decision.question!, store, { waitForHuman: false });
        } else {
          await completeTask(dir, runId, id, { passed: false, attempts, reviewSummary: result?.review?.summary, note: `manager: ${decision.rationale}` }, store);
        }
        break;
      }
      const status = (await readProject(dir)).state.tasks[id]?.status ?? 'split';
      span.setAttributes({ 'agentic.task.status': status, 'agentic.attempts': attempts });
      tlog.info({ status, attempts }, `task ${status}`);
    } catch (error) {
      await abandonTask(dir, runId, id, message(error), store);
      throw error;
    }
  });
}

/** Runs the approved backlog in this process (the Temporal workflow drives the same steps durably). */
export async function runProject(opts: RunProjectOptions): Promise<ProjectState> {
  const dir = resolve(opts.projectDir);
  const store = opts.store ?? new FileStore();
  const release = await acquireLock(projectPaths(dir).lock);
  const runId = `run-${randomBytes(4).toString('hex')}`;
  const { state } = await readProject(dir).catch(async e => { await release(); throw e; });
  const log = (opts.logger ?? createLogger()).child({ project_id: state.id, run_id: runId });
  let session: Session | undefined;
  try {
    const plan = await beginRun(dir, runId, store);
    session = await openRunSession(dir, runId, store, { ...opts, logger: log });
    return await withSpan('agentic.project.run', { 'agentic.project_id': state.id, 'agentic.run_id': runId }, async () => {
      let stopped: { status: ProjectStatus; error: string } | undefined;
      try {
        const concurrency = plan.maxConcurrency ?? 1;
        if (concurrency > 1) {
          const limit = pLimit(concurrency);
          for (;;) {
            const readyTasks = await getReadyTasks(dir, runId, store);
            if (!readyTasks.length) {
              const { state: curState } = await readProject(dir);
              const hasPending = Object.values(curState.tasks).some(t => t.status === 'pending');
              if (!hasPending) break;
              const anyRunning = Object.values(curState.tasks).some(t => t.status === 'running');
              if (!anyRunning) break;
            }
            await Promise.all(readyTasks.map(t => limit(() => executeTaskWithLifecycle(dir, runId, t as { kind: 'ready'; input: TaskInput; taskId: string }, session!, plan, log, store))));
          }
        } else {
          for (;;) {
            const start = await startNextTask(dir, runId, store);
            if (start.kind === 'none') break;
            if (start.kind !== 'ready') continue;
            await executeTaskWithLifecycle(dir, runId, start, session!, plan, log, store);
          }
        }
      } catch (error) {
        if (!isStop(error)) {
          await finishRun(dir, runId, session, store, { status: 'failed', error: message(error) }).catch(() => {});
          throw error;
        }
        stopped = { status: stoppedStatus(error), error: message(error) };
        log.warn({ err: stopped.error }, `project stopped: ${stopped.status}`);
      }
      let final = await finishRun(dir, runId, session, store, stopped);
      if (final.status === 'completed') {
        const { deliverProject } = await import('./delivery.js');
        const delivered = await deliverProject(dir, store).catch(error => { log.warn({ err: message(error) }, 'delivery failed; the branch is intact, retry with "project deliver"'); return undefined; });
        if (delivered) log.info({ pr: delivered.prUrl, remote: delivered.remote }, 'delivered');
        final = (await readProject(dir)).state; // includes the delivery outcome, success or failure
      }
      log.info({ status: final.status, branch: final.branch }, `project ${final.status}; report: ${join(dir, 'report.md')}`);
      return final;
    });
  } catch (error) {
    if (!session) await new Tracker(dir, state, store, runId).setStatus('failed', message(error)).catch(() => {});
    throw error;
  } finally {
    await session?.close();
    await release();
  }
}

// ---------------------------------------------------------------- reports

export interface RequirementTrace {
  id: string; title: string; priority: string;
  status: 'implemented' | 'partial' | 'not_implemented' | 'not_planned';
  tasks: { id: string; status: TaskStatus; commit?: string }[];
}

export function traceability(backlog: Backlog, state: ProjectState): RequirementTrace[] {
  return backlog.requirements.map(r => {
    const tasks = backlog.tasks.filter(t => t.requirementIds.includes(r.id)).map(t => ({ id: t.id, status: state.tasks[t.id]?.status ?? 'pending', commit: state.tasks[t.id]?.commit }));
    const doneCount = tasks.filter(t => t.status === 'done').length;
    const status = !tasks.length ? 'not_planned' : doneCount === tasks.length ? 'implemented' : doneCount ? 'partial' : 'not_implemented';
    return { id: r.id, title: r.title, priority: r.priority, status, tasks };
  });
}

async function writeReports(dir: string, state: ProjectState, backlog: Backlog): Promise<void> {
  const trace = traceability(backlog, state);
  await writeJson(join(dir, 'traceability.json'), trace);
  const cost = state.invocations.reduce((sum, i) => sum + (i.costUsd ?? 0), 0);
  const lines = [
    `# ${state.id}: ${state.status}`, '', backlog.summary, '',
    `- Branch: \`${state.branch}\` (base ${state.baseSha.slice(0, 10)})`,
    `- Document: ${state.document.name} (${state.document.format})`,
    `- Integration checks: ${state.integration ? (state.integration.passed ? 'passed' : 'FAILED') : 'not run'}`,
    `- Cost so far: $${cost.toFixed(2)}`, ...(state.error ? [`- Stopped: ${state.error.split('\n')[0].slice(0, 300)}`] : []), '',
    '## Tasks', '', '| Task | Status | Attempts | Commit | Notes |', '|---|---|---|---|---|',
    ...taskOrder(backlog.tasks).map(t => {
      const s = state.tasks[t.id];
      return `| ${t.id}: ${t.title} | ${s?.status ?? 'pending'} | ${s?.attempts ?? 0} | ${s?.commit?.slice(0, 10) ?? ''} | ${(s?.error ?? s?.reviewSummary ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 160)} |`;
    }),
    '', '## Requirement coverage', '', '| Requirement | Priority | Status | Tasks |', '|---|---|---|---|',
    ...trace.map(r => `| ${r.id}: ${r.title} | ${r.priority} | ${r.status} | ${r.tasks.map(t => `${t.id} (${t.status})`).join(', ') || '-'} |`),
  ];
  const answered = backlog.openQuestions.filter(q => q.answer?.trim());
  if (answered.length) lines.push('', '## Clarifications', '', ...answered.map(q => `- **${q.id}** ${q.question} → ${q.answer}`));
  await writeFile(join(dir, 'report.md'), `${lines.join('\n')}\n`);
}
