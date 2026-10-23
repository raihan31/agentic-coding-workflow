import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Agent } from './adapters.js';
import type { CheckRunner } from './checks.js';
import type { Config } from './config.js';
import type { RunCredentials } from './credentials.js';
import { BudgetExceeded, executeTask, openSession } from './engine.js';
import { addWorktree, assertCleanRepoRoot, headSha, removeWorktree } from './git.js';
import { createLogger, type Logger } from './log.js';
import { PROMPT_VERSION } from './prompts.js';
import type { AgentRuntime } from './runtime.js';
import type { SecurityScanner } from './security.js';
import { instruments, withSpan } from './telemetry.js';

export type { Finding, Review } from './config.js';
export { parseReview, ReviewFormatError } from './engine.js';
export type RunStatus = 'awaiting_human_approval' | 'plan_ready' | 'changes_required' | 'budget_exceeded';
export interface RunResult {
  status: RunStatus; runId: string; attempts: number; directory: string; worktree: string; baseSha: string;
  costUsd: number; costSource: 'gateway' | 'agent-reported'; tokens: { input: number; output: number };
}
export interface Options {
  repo: string; requirement: string; runRoot: string; config: Config;
  planner?: Agent; developer?: Agent; reviewer?: Agent; checkRunner?: CheckRunner; runtime?: AgentRuntime; scanner?: SecurityScanner;
  /** Override credential creation (tests, or a custom secrets backend). Disposed at the end of the run. */
  credentials?: RunCredentials;
  /** A human-reviewed plan to use instead of running the planner. */
  plan?: string;
  /** Stop after planning so a human can review plan.md, then rerun with `plan`. */
  planOnly?: boolean;
  logger?: Logger;
}

/** Single-requirement run: one worktree, one task. */
export async function runWorkflow(opts: Options): Promise<RunResult> {
  const { config } = opts;
  const repo = await assertCleanRepoRoot(opts.repo);
  const runId = `run-${randomBytes(4).toString('hex')}`;
  const runDir = join(resolve(opts.runRoot), runId);
  const log = (opts.logger ?? createLogger()).child({ run_id: runId });
  const session = await openSession({
    config, runId, dir: runDir, logger: log,
    needClaude: !opts.plan && !opts.planner, needCodex: !opts.planOnly && (!opts.developer || !opts.reviewer),
    planner: opts.planner, developer: opts.developer, reviewer: opts.reviewer,
    checkRunner: opts.planOnly ? { kind: 'none', prepare: async () => {}, runAll: async () => [] } : opts.checkRunner,
    runtime: opts.runtime, credentials: opts.credentials, scanner: opts.scanner,
  });
  const worktree = join(runDir, 'worktree');
  const baseSha = await headSha(repo);
  const save = (name: string, data: unknown) => writeFile(join(runDir, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));

  let status: RunStatus = 'changes_required';
  let attempts = 0;
  let cost: Awaited<ReturnType<typeof session.close>> = { costUsd: 0, costSource: 'agent-reported' };
  let created = false;
  const result = (): RunResult => ({ status, runId, attempts, directory: runDir, worktree, baseSha, tokens: session.tokens, ...cost });

  return await withSpan('agentic.run', { 'agentic.run_id': runId, 'agentic.base_sha': baseSha, 'agentic.prompt_version': PROMPT_VERSION, 'agentic.runtime': session.runtime.kind }, async runSpan => {
    try {
      await addWorktree(repo, worktree, baseSha);
      created = true;
      await save('metadata.json', { runId, repo, worktree, baseSha, config, promptVersion: PROMPT_VERSION, planProvided: Boolean(opts.plan), traceId: runSpan.spanContext().traceId, created: new Date().toISOString() });
      const outcome = await executeTask(session, { worktree, dir: runDir, requirement: opts.requirement, baseSha, plan: opts.plan, planOnly: opts.planOnly });
      attempts = outcome.attempts;
      status = outcome.status === 'passed' ? 'awaiting_human_approval' : outcome.status;
      if (outcome.status === 'plan_ready') {
        await removeWorktree(repo, worktree);
        created = false;
      }
    } catch (error) {
      if (error instanceof BudgetExceeded) {
        status = 'budget_exceeded';
        log.error(error.message);
      } else {
        await save('error.txt', error instanceof Error ? error.stack ?? error.message : String(error));
        throw error;
      }
    } finally {
      cost = await session.close();
      runSpan.setAttributes({ 'agentic.status': status, 'agentic.attempts': attempts, 'agentic.cost_usd': cost.costUsd });
      instruments().runs.add(1, { status });
      if (attempts) instruments().attempts.record(attempts, { status });
      await save('result.json', result()).catch(() => {});
      log.info({ status, attempts, cost_usd: cost.costUsd, cost_source: cost.costSource }, created ? `worktree preserved: ${worktree}` : 'run finished');
    }
    return result(); // after finally, so gateway spend is included
  });
}
