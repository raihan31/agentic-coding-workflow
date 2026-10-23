import { join, resolve } from 'node:path';
import { ApplicationFailure, Context } from '@temporalio/activity';
import { RateLimitedError } from '../adapters.js';
import { BacklogError } from '../backlog.js';
import { parseConfig } from '../config.js';
import { attemptTask, BudgetExceeded, planTask, type Session, type TaskInput } from '../engine.js';
import type { Logger } from '../log.js';
import { AbortedError, withAbortSignal } from '../process.js';
import type { Subtask } from '../manager.js';
import {
  abandonTask, analyzeProject, applyAnswers, beginRun, completeTask, escalateTask, finishRun, guideTask, openRunSession, ProjectValidationError, recordFailedStart,
  setProjectStatus, splitTask, startNextTask, startTask, superviseTask, type ProjectDeps, type ProjectStatus, type TaskFailure,
} from '../project.js';
import { deliverProject } from '../delivery.js';
import type { ProjectStore } from '../store.js';
import { FailureType, type GuideInput, type ProjectInput, type TaskWorkflowResult } from './shared.js';

export interface ActivityDeps {
  store: ProjectStore;
  logger: Logger;
  /** Agent/runtime overrides (tests). */
  deps?: Omit<ProjectDeps, 'store' | 'logger'>;
  heartbeatMs?: number;
}

const activityContext = (): Context | undefined => { try { return Context.current(); } catch { return undefined; } };

/** Maps domain errors to Temporal failure types the workflows branch on. */
export function toFailure(error: unknown): unknown {
  const nonRetryable = (type: string) => ApplicationFailure.create({ message: (error as Error).message, type, nonRetryable: true });
  if (error instanceof BudgetExceeded) return nonRetryable(FailureType.budget);
  if (error instanceof RateLimitedError) return nonRetryable(FailureType.rateLimited);
  if (error instanceof ProjectValidationError || error instanceof BacklogError) return nonRetryable(FailureType.validation);
  return error;
}

/**
 * Activities are thin wrappers over the project steps. Sessions (sandbox runtime, credentials, usage) are cached
 * per project run in this worker; after a worker restart the next step opens a fresh one.
 */
export function createActivities(d: ActivityDeps) {
  const sessions = new Map<string, Promise<Session>>();
  const key = (dir: string, runId: string) => `${dir}|${runId}`;
  const session = (dir: string, runId: string): Promise<Session> => {
    const k = key(dir, runId);
    if (!sessions.has(k)) {
      const opened = openRunSession(dir, runId, d.store, { ...d.deps, logger: d.logger.child({ run_id: runId }) });
      sessions.set(k, opened.catch(error => { sessions.delete(k); throw error; }));
    }
    return sessions.get(k)!;
  };
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    const ctx = activityContext();
    const beat = ctx ? setInterval(() => ctx.heartbeat(), d.heartbeatMs ?? 20_000) : undefined;
    try {
      // Cancellation (delivered via heartbeats) kills this activity's agent processes and containers.
      return ctx ? await withAbortSignal(ctx.cancellationSignal, fn) : await fn();
    } catch (error) {
      if (error instanceof AbortedError && ctx?.cancellationSignal.aborted) throw ctx.cancellationSignal.reason ?? error;
      throw toFailure(error);
    } finally {
      clearInterval(beat);
    }
  };

  return {
    analyze: (input: ProjectInput) => run(async () => {
      try {
        const state = await analyzeProject({ ...d.deps, id: input.projectId, repo: input.repo, document: input.document, config: parseConfig(input.config), runRoot: input.runRoot, store: d.store, logger: d.logger });
        return { dir: join(resolve(input.runRoot), state.id), status: state.status };
      } catch (error) {
        await recordFailedStart({ id: input.projectId, repo: input.repo, document: input.document, runRoot: input.runRoot }, error, d.store).catch(() => {});
        throw error;
      }
    }),
    applyAnswers: (dir: string, answers: Record<string, string>) => run(() => applyAnswers(dir, answers, d.store)),
    beginRun: (dir: string, runId: string) => run(() => beginRun(dir, runId, d.store)),
    startTask: (dir: string, runId: string, taskId: string) => run(() => startTask(dir, runId, taskId, d.store)),
    startNextTask: (dir: string, runId: string) => run(() => startNextTask(dir, runId, d.store)),
    superviseTask: (dir: string, runId: string, taskId: string, failure: TaskFailure) => run(async () => superviseTask(await session(dir, runId), dir, runId, taskId, failure, d.store)),
    splitTask: (dir: string, runId: string, taskId: string, subtasks: Subtask[]) => run(() => splitTask(dir, runId, taskId, subtasks, d.store)),
    escalateTask: (dir: string, runId: string, taskId: string, question: string) => run(() => escalateTask(dir, runId, taskId, question, d.store, { waitForHuman: true })),
    guideTask: (dir: string, runId: string, guide: GuideInput) => run(() => guideTask(dir, runId, guide, d.store)),
    planTask: (dir: string, runId: string, input: TaskInput) => run(async () => planTask(await session(dir, runId), input)),
    attemptTask: (dir: string, runId: string, input: TaskInput, plan: string, feedback: string, attempt: number) =>
      run(async () => attemptTask(await session(dir, runId), input, plan, feedback, attempt)),
    completeTask: (dir: string, runId: string, taskId: string, result: TaskWorkflowResult, note?: string) =>
      run(() => completeTask(dir, runId, taskId, { passed: result.passed, attempts: result.attempts, reviewSummary: result.reviewSummary, note: note ?? (result.decision && `manager: ${result.decision.rationale}`) }, d.store)),
    abandonTask: (dir: string, runId: string, taskId: string, reason: string) => run(() => abandonTask(dir, runId, taskId, reason, d.store)),
    setStatus: (dir: string, runId: string, status: ProjectStatus, note?: string) => run(() => setProjectStatus(dir, runId, status, d.store, note)),
    /** Push + PR when configured; failures are reported, never thrown (the project result stands). */
    deliver: (dir: string) => run(async () => {
      try { return { delivered: Boolean(await deliverProject(dir, d.store)) }; } catch (error) { return { delivered: false, error: (error as Error).message }; }
    }),
    finishRun: (dir: string, runId: string, stopped?: { status: string; error: string }) => run(async () => {
      const k = key(dir, runId);
      // Integration checks need a session; a stopped run only needs one if this worker already has it.
      const s = sessions.has(k) || !stopped ? await session(dir, runId) : undefined;
      sessions.delete(k);
      const final = await finishRun(dir, runId, s, d.store, stopped && { status: stopped.status as ProjectStatus, error: stopped.error });
      return { status: final.status };
    }),
  };
}
