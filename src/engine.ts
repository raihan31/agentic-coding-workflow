import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentError, ClaudePlanner, CodexDeveloper, CodexReviewer, type Agent, type AgentContext, type AgentResult } from './adapters.js';
import { createCheckRunner, type CheckResult, type CheckRunner } from './checks.js';
import { reviewJsonSchema, ReviewSchema, type Config, type Review } from './config.js';
import { createCredentials, type AgentCredentials, type RunCredentials } from './credentials.js';
import { diffAgainst, listChanges, type FileChange } from './git.js';
import type { Logger } from './log.js';
import { protectedPathViolations } from './policy.js';
import { tail } from './process.js';
import { prompts } from './prompts.js';
import { createSecurityScanner, formatFindings, type SecurityScanner } from './security.js';
import { createAgentRuntime, type AgentRuntime } from './runtime.js';
import { claudeTelemetryEnv, instruments, telemetryEnabled, withSpan } from './telemetry.js';

export type Role = 'analyst' | 'planner' | 'developer' | 'reviewer' | 'manager';
export type Gate = 'passed' | 'developer_error' | 'no_changes' | 'protected_paths' | 'checks' | 'security' | 'review';
/** Progress events for live views. Task context is attached by whoever owns the task. */
export type EngineEvent =
  | { type: 'agent.started'; taskId?: string; role: Role; phase: string }
  | { type: 'agent.finished'; taskId?: string; role: Role; phase: string; outcome: string; durationMs: number; tokens?: { input: number; output: number }; costUsd?: number }
  | { type: 'checks.finished'; taskId?: string; attempt: number; results: { command: string; phase: string; code: number; timedOut: boolean; durationMs: number }[] }
  | { type: 'security.finished'; taskId?: string; attempt: number; scanned: number; findings: number; blocking: number; durationMs: number }
  | { type: 'review.finished'; taskId?: string; attempt: number; decision: string; summary: string; findings: number }
  | { type: 'attempt.finished'; taskId?: string; attempt: number; gate: Gate };
export type EventHandler = (event: EngineEvent) => void | Promise<void>;

const MAX_PROMPT_DIFF = 100_000;
const MAX_CHECK_OUTPUT = 4_000;
const COLLECTOR_IN_SANDBOX = 'http://agentic-otel-collector:4318';
const NO_CREDS: AgentCredentials = { env: {}, secretEnv: {}, passEnv: [], mounts: [] };

export class ReviewFormatError extends Error { constructor(message: string) { super(message); this.name = 'ReviewFormatError'; } }
export class BudgetExceeded extends Error {
  constructor(readonly spent: number, readonly budget: number) { super(`Gateway spend $${spent.toFixed(2)} reached the $${budget} budget`); this.name = 'BudgetExceeded'; }
}

export function parseReview(raw: string): Review {
  const text = raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1');
  let data: unknown;
  try { data = JSON.parse(text); } catch (error) { throw new ReviewFormatError(`Review is not JSON: ${String(error)}`); }
  const parsed = ReviewSchema.safeParse(data);
  if (!parsed.success) throw new ReviewFormatError(`Malformed review: ${parsed.error.message}`);
  const review = parsed.data;
  if (review.decision === 'pass' && review.findings.some(f => f.severity === 'critical' || f.severity === 'high')) throw new ReviewFormatError('Reviewer passed critical/high findings');
  return review;
}

export interface SessionOptions {
  config: Config;
  runId: string;
  /** Session directory (created after credentials succeed); holds the review schema. */
  dir: string;
  needClaude: boolean;
  needCodex: boolean;
  /** Extra directories mounted read-only for Claude agents (e.g. the project's source documents). */
  contextDirs?: string[];
  logger: Logger;
  planner?: Agent; developer?: Agent; reviewer?: Agent;
  /** Builds the analyst once the session's runtime and credentials exist. */
  analyst?: Agent | ((ctx: AgentContext) => Agent);
  /** Same for the manager agent, which also gets `managerDirs` (task artifacts) mounted read-only. */
  manager?: Agent | ((ctx: AgentContext) => Agent);
  managerDirs?: string[];
  checkRunner?: CheckRunner; runtime?: AgentRuntime; credentials?: RunCredentials; scanner?: SecurityScanner;
  onEvent?: EventHandler;
}

/** What one CLI invocation shares across agent calls: sandbox runtime, credentials, agents, usage and budget. */
export interface Session {
  readonly config: Config;
  readonly runId: string;
  readonly log: Logger;
  readonly runtime: AgentRuntime;
  readonly checkRunner: CheckRunner;
  readonly scanner: SecurityScanner;
  readonly agents: { planner: Agent; developer: Agent; reviewer: Agent; analyst?: Agent; manager?: Agent };
  callAgent(role: Role, agent: Agent, prompt: string, cwd: string, outDir: string, phase: string, taskId?: string): Promise<string>;
  /** Never throws: a broken event sink must not fail the work. */
  emit(event: EngineEvent): Promise<void>;
  readonly tokens: { input: number; output: number };
  /** Collects gateway spend and disposes credentials. Safe to call more than once. */
  close(): Promise<{ costUsd: number; costSource: 'gateway' | 'agent-reported' }>;
}

export async function openSession(opts: SessionOptions): Promise<Session> {
  const { config } = opts;
  const runtime = opts.runtime ?? await createAgentRuntime(config.agentRuntime, config.kubernetes);
  const checkRunner = opts.checkRunner ?? await createCheckRunner(config.checkRunner, config.kubernetes);
  const scanner = opts.scanner ?? createSecurityScanner(config.security);
  // Fail before any LLM spend.
  if (opts.needClaude || opts.needCodex) await runtime.prepare();
  await checkRunner.prepare();
  await scanner.prepare();
  const agentOtel = telemetryEnabled() && config.telemetry.agents
    ? config.telemetry.agentEndpoint ?? (runtime.kind === 'container' ? COLLECTOR_IN_SANDBOX : process.env.OTEL_EXPORTER_OTLP_ENDPOINT) // kubernetes: the in-cluster collector
    : undefined;
  // Credentials before anything touches disk, so a missing token fails without leaving an empty run behind.
  let creds = opts.credentials;
  if (!creds && (opts.needClaude || opts.needCodex)) {
    creds = await createCredentials(config.credentials, { runtime: runtime.kind, runId: opts.runId, needClaude: opts.needClaude, needCodex: opts.needCodex, codexOtelEndpoint: agentOtel });
  }
  await mkdir(opts.dir, { recursive: true });
  const schemaPath = join(opts.dir, 'review.schema.json');
  await writeFile(schemaPath, JSON.stringify(reviewJsonSchema(), null, 2));

  const { models, timeouts, agentEnv } = config;
  const contextMounts = (opts.contextDirs ?? []).map(path => ({ path, readOnly: true }));
  const ctx = (role: Role, c: AgentCredentials | undefined, extraMounts: { path: string; readOnly: boolean }[] = []): AgentContext => ({
    runtime, creds: { ...(c ?? NO_CREDS), mounts: [...(c ?? NO_CREDS).mounts, ...extraMounts] },
    telemetryEnv: agentOtel ? claudeTelemetryEnv(agentOtel, { 'agentic.run_id': opts.runId, 'agentic.role': role }) : undefined,
  });
  // Codex's own Landlock/seccomp sandbox cannot nest inside a container; there the container (read-only mounts,
  // proxy-only network) is the boundary and Codex runs unrestricted within it.
  const inContainer = runtime.kind !== 'host';
  const agents = {
    planner: opts.planner ?? new ClaudePlanner(ctx('planner', creds?.claude, contextMounts), { model: models.planner, timeoutMs: timeouts.planMs, passEnv: agentEnv, maxBudgetUsd: config.plannerBudgetUsd, addDirs: opts.contextDirs }),
    developer: opts.developer ?? new CodexDeveloper(ctx('developer', creds?.codex, contextMounts), { model: models.developer, timeoutMs: timeouts.developerMs, passEnv: agentEnv, sandbox: inContainer ? 'danger-full-access' : 'workspace-write' }),
    reviewer: opts.reviewer ?? new CodexReviewer(ctx('reviewer', creds?.codex, contextMounts), schemaPath, {
      model: models.reviewer, timeoutMs: timeouts.reviewerMs, passEnv: agentEnv,
      sandbox: inContainer ? 'danger-full-access' : 'read-only', // in containers the worktree is mounted read-only
    }),
    analyst: typeof opts.analyst === 'function' ? opts.analyst(ctx('analyst', creds?.claude, contextMounts)) : opts.analyst,
    manager: typeof opts.manager === 'function'
      ? opts.manager(ctx('manager', creds?.claude, [...contextMounts, ...(opts.managerDirs ?? []).map(path => ({ path, readOnly: true }))]))
      : opts.manager,
  };

  const tokens = { input: 0, output: 0 };
  let reportedCost = 0;
  let closed: Awaited<ReturnType<Session['close']>> | undefined;
  const checkBudget = async () => {
    if (!creds?.budgetUsd) return;
    const spent = await creds.spendUsd().catch(() => undefined);
    if (spent !== undefined && spent >= creds.budgetUsd) throw new BudgetExceeded(spent, creds.budgetUsd);
  };

  const emit = async (event: EngineEvent) => {
    try { await opts.onEvent?.(event); } catch (error) { opts.logger.warn({ err: error, event: event.type }, 'event handler failed'); }
  };
  return {
    config, runId: opts.runId, log: opts.logger, runtime, checkRunner, scanner, agents, tokens, emit,
    callAgent: (role, agent, prompt, cwd, outDir, phase, taskId) =>
      withSpan(`agent.${role}`, { 'agentic.role': role, 'agentic.phase': phase }, async span => {
        await checkBudget();
        const started = performance.now();
        let outcome = 'ok';
        let r: AgentResult | undefined;
        await emit({ type: 'agent.started', taskId, role, phase });
        try {
          r = await agent.run(prompt, cwd, outDir, phase);
          reportedCost += r.costUsd ?? 0;
          if (r.usage) {
            tokens.input += r.usage.inputTokens; tokens.output += r.usage.outputTokens;
            instruments().tokens.add(r.usage.inputTokens, { role, direction: 'input' });
            instruments().tokens.add(r.usage.outputTokens, { role, direction: 'output' });
            span.setAttributes({ 'agentic.tokens.input': r.usage.inputTokens, 'agentic.tokens.output': r.usage.outputTokens });
          }
          if (r.costUsd !== undefined) span.setAttribute('agentic.cost_usd', r.costUsd);
          return r.output;
        } catch (error) {
          outcome = error instanceof AgentError ? 'agent_error' : 'error';
          throw error;
        } finally {
          const durationMs = performance.now() - started;
          instruments().agentDuration.record(durationMs / 1000, { role, outcome });
          await emit({ type: 'agent.finished', taskId, role, phase, outcome, durationMs: Math.round(durationMs), tokens: r?.usage && { input: r.usage.inputTokens, output: r.usage.outputTokens }, costUsd: r?.costUsd });
        }
      }),
    close: async () => {
      if (closed) return closed;
      const gateway = creds ? await creds.spendUsd().catch(() => undefined) : undefined;
      if (creds) await creds.dispose().catch(e => opts.logger.warn({ err: e }, 'credential cleanup failed'));
      closed = gateway === undefined ? { costUsd: reportedCost, costSource: 'agent-reported' } : { costUsd: gateway, costSource: 'gateway' };
      instruments().cost.add(closed.costUsd, { source: closed.costSource });
      return closed;
    },
  };
}

export interface TaskInput {
  worktree: string;
  /** Artifact directory for this task. */
  dir: string;
  /** Full task brief given to every agent. */
  requirement: string;
  /** Commit the diff is measured against. */
  baseSha: string;
  /** Attached to emitted events. */
  taskId?: string;
  /** A human-reviewed plan to use instead of running the planner. */
  plan?: string;
  /** Re-plan round after a manager retry (0 for the first plan); keeps each round's planner artifacts. */
  round?: number;
  planOnly?: boolean;
}
export interface TaskOutcome { status: 'passed' | 'changes_required' | 'plan_ready'; attempts: number; plan: string; lastReview?: Review; }
export interface AttemptResult { gate: Gate; /** Repair instructions for the next attempt (empty when passed). */ feedback: string; review?: Review; }

const formatStatus = (changes: FileChange[]) => changes.map(c => `${c.x}${c.y} ${c.origPath ? `${c.origPath} -> ` : ''}${c.path}`).join('\n');
const formatCheck = (c: CheckResult) => `$ ${c.command.join(' ')}  (${c.phase}, exit ${c.code}${c.timedOut ? ', timed out' : ''})\n${tail(`${c.stdout}\n${c.stderr}`.trim(), MAX_CHECK_OUTPUT)}`;
const head = (text: string, n: number) => text.length <= n ? text : `${text.slice(0, n)}\n[...diff truncated: ${text.length - n} more chars; inspect files directly...]`;
const saver = (dir: string) => (name: string, data: unknown) => writeFile(join(dir, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));

/** Planning step: returns the plan (provided or produced by the planner). */
export async function planTask(session: Session, t: TaskInput): Promise<string> {
  await mkdir(t.dir, { recursive: true });
  const save = saver(t.dir);
  await save(t.round ? `requirement-r${t.round}.md` : 'requirement.md', t.requirement);
  let plan: string;
  if (t.plan) {
    session.log.info('using provided plan');
    plan = t.plan;
  } else {
    session.log.info({ phase: 'plan' }, 'planning');
    plan = await session.callAgent('planner', session.agents.planner, prompts.plan(t.requirement), t.worktree, t.dir, t.round ? `planner-r${t.round}` : 'planner', t.taskId);
  }
  await save(t.round ? `plan-r${t.round}.md` : 'plan.md', plan);
  return plan;
}

/** One attempt: implement (or repair), then gates in cost order, then LLM review. */
export async function attemptTask(session: Session, t: TaskInput, plan: string, feedback: string, attempt: number): Promise<AttemptResult> {
  const { config, log, checkRunner, scanner, agents } = session;
  const attempts = attempt + 1;
  await mkdir(t.dir, { recursive: true });
  const save = saver(t.dir);
  const reject = (gate: string) => instruments().rejections.add(1, { gate });
  const call = (role: Role, agent: Agent, prompt: string, phase: string) => session.callAgent(role, agent, prompt, t.worktree, t.dir, phase, t.taskId);

  const result = await withSpan('agentic.attempt', { 'agentic.attempt': attempts }, async (): Promise<AttemptResult> => {
    const problems: string[] = [];
    let gate: Gate = 'passed';
    let review: Review | undefined;
    const fail = (g: Gate, problem: string) => { if (gate === 'passed') gate = g; reject(g); problems.push(problem); };
    log.info({ phase: 'implement', attempt: attempts }, 'implementing');
    try {
      await call('developer', agents.developer, prompts.develop({ requirement: t.requirement, plan, feedback }), `developer-${attempt}`);
    } catch (error) {
      if (!(error instanceof AgentError)) throw error;
      fail('developer_error', `The developer process failed: ${tail(error.message, 2_000)}`);
    }
    const changes = await listChanges(t.worktree);
    await save(`status-${attempt}.txt`, formatStatus(changes));
    const violations = protectedPathViolations(changes, config.protectedPaths);

    // Cheapest gates first; the LLM reviewer only sees changes that pass every deterministic gate.
    if (!changes.length) {
      fail('no_changes', 'No changes were made to the worktree. Implement the requirement.');
    } else if (violations.length) {
      fail('protected_paths', `Protected files were changed. Revert them and meet the requirement without touching them:\n${violations.map(v => `- ${v.path} (${v.reason})`).join('\n')}`);
    } else {
      log.info({ phase: 'check', attempt: attempts, runner: checkRunner.kind }, 'running checks');
      const checks = await withSpan('agentic.checks', { 'agentic.runner': checkRunner.kind }, () => checkRunner.runAll(t.worktree, config.checks, config.timeouts.checkMs));
      await save(`checks-${attempt}.json`, checks);
      await session.emit({ type: 'checks.finished', taskId: t.taskId, attempt: attempts, results: checks.map(c => ({ command: c.command.join(' '), phase: c.phase, code: c.code, timedOut: c.timedOut, durationMs: c.durationMs })) });
      const failing = checks.filter(c => c.code !== 0);
      const security = failing.length || !scanner.enabled ? undefined : await withSpan('agentic.security', {}, async () => {
        log.info({ phase: 'security', attempt: attempts }, 'scanning');
        const report = await scanner.scan(t.worktree, t.baseSha, changes, join(t.dir, `security-${attempt}`));
        await save(`security-${attempt}.json`, report);
        await session.emit({ type: 'security.finished', taskId: t.taskId, attempt: attempts, scanned: report.scanned.length, findings: report.findings.length, blocking: report.blocking.length, durationMs: report.durationMs });
        return report;
      });
      if (failing.length) {
        fail('checks', `Deterministic checks failed:\n${failing.map(formatCheck).join('\n\n')}`);
      } else if (security?.blocking.length) {
        fail('security', `Security scanners flagged the changes:\n${formatFindings(security.blocking)}\n\nFix the code: remove secrets (read them from configuration or the environment), fix the flagged patterns, or use a dependency version without the vulnerability. Do not add ignore files or suppression comments; they are not honoured.`);
      } else {
        log.info({ phase: 'review', attempt: attempts }, 'reviewing');
        const diff = await diffAgainst(t.worktree, t.baseSha);
        await save(`diff-${attempt}.patch`, diff);
        const prompt = prompts.review({
          requirement: t.requirement, plan, status: formatStatus(changes), diff: head(diff, MAX_PROMPT_DIFF),
          checks: (checks.map(c => `$ ${c.command.join(' ')} (exit ${c.code})`).join('\n') || '(none configured)')
            + (security?.findings.length ? `\nSecurity scanner findings below the blocking threshold (judge whether they matter):\n${formatFindings(security.findings.slice(0, 30))}` : ''),
        });
        review = await runReview(prompt);
        await save(`review-parsed-${attempt}.json`, review);
        await session.emit({ type: 'review.finished', taskId: t.taskId, attempt: attempts, decision: review.decision, summary: review.summary, findings: review.findings.length });
        if (review.decision !== 'pass') fail('review', `Code review requested changes:\n${JSON.stringify(review, null, 2)}`);
      }
    }
    return { gate, review, feedback: problems.length ? `${problems.join('\n\n')}\n\nFix these problems, then rerun the checks yourself.` : '' };
  });
  await session.emit({ type: 'attempt.finished', taskId: t.taskId, attempt: attempts, gate: result.gate });
  if (result.gate !== 'passed') {
    await save(`feedback-${attempt}.md`, result.feedback);
    log.warn({ attempt: attempts, gate: result.gate }, 'attempt rejected');
  }
  return result;

  async function runReview(prompt: string): Promise<Review> {
    let lastError = '';
    for (let i = 0; i < 2; i++) {
      const phase = i === 0 ? `review-${attempt}` : `review-${attempt}-retry`;
      const fullPrompt = lastError ? `${prompt}\n\nYour previous output was rejected (${lastError}). Output only valid JSON matching the schema.` : prompt;
      try {
        return parseReview(await call('reviewer', agents.reviewer, fullPrompt, phase));
      } catch (error) {
        if (!(error instanceof AgentError || error instanceof ReviewFormatError)) throw error;
        lastError = error.message.slice(0, 1_000);
      }
    }
    throw new Error(`Reviewer failed to produce a valid review twice: ${lastError}`);
  }
}

/** Plan → (implement → gates → review → repair) loop for one unit of work in an existing worktree. */
export async function executeTask(session: Session, t: TaskInput): Promise<TaskOutcome> {
  const plan = await planTask(session, t);
  if (t.planOnly) return { status: 'plan_ready', attempts: 0, plan };
  let feedback = '';
  let lastReview: Review | undefined;
  for (let attempt = 0; attempt <= session.config.maxRepairs; attempt++) {
    const r = await attemptTask(session, t, plan, feedback, attempt);
    lastReview = r.review ?? lastReview;
    if (r.gate === 'passed') return { status: 'passed', attempts: attempt + 1, plan, lastReview };
    feedback = r.feedback;
  }
  return { status: 'changes_required', attempts: session.config.maxRepairs + 1, plan, lastReview };
}
