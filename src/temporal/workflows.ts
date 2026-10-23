import {
  ActivityFailure, ApplicationFailure, CancellationScope, condition, defineQuery, defineSignal, executeChild,
  isCancellation, patched, proxyActivities, setHandler, sleep, workflowInfo,
} from '@temporalio/workflow';
import type { createActivities } from './activities.js';
import type { Gate } from '../engine.js';
import { guidanceSection } from '../guidance.js';
import { FailureType, type ApproveInput, type GuideInput, type ProjectInput, type ProjectView, type TaskWorkflowInput, type TaskWorkflowResult } from './shared.js';

type Activities = ReturnType<typeof createActivities>;
const NON_RETRYABLE = Object.values(FailureType);
// Bookkeeping: quick, safe to retry.
const short = proxyActivities<Activities>({ startToCloseTimeout: '15 minutes', heartbeatTimeout: '2 minutes', retry: { maximumAttempts: 3, nonRetryableErrorTypes: NON_RETRYABLE } });
// Agent work: long; heartbeats detect a dead worker, and one retry covers a crash.
const agentic = proxyActivities<Activities>({ startToCloseTimeout: '3 hours', heartbeatTimeout: '2 minutes', retry: { maximumAttempts: 2, nonRetryableErrorTypes: NON_RETRYABLE } });

export const approveSignal = defineSignal<[ApproveInput]>('approve');
export const pauseSignal = defineSignal('pause');
export const resumeSignal = defineSignal('resume');
export const guideSignal = defineSignal<[GuideInput]>('guide');
export const viewQuery = defineQuery<ProjectView>('view');

const failureType = (error: unknown): string | undefined => {
  const cause = error instanceof ActivityFailure ? error.cause : error;
  if (cause instanceof ApplicationFailure) return cause.type ?? undefined;
  if (error instanceof Error && error.cause) return failureType(error.cause);
  return undefined;
};
const describe = (error: unknown): string => {
  const cause = error instanceof ActivityFailure ? error.cause ?? error : error;
  return cause instanceof Error ? cause.message : String(cause);
};

/** Document → backlog → (human approval) → tasks in dependency order → integration + report. */
export async function projectWorkflow(input: ProjectInput): Promise<ProjectView> {
  const view: ProjectView = { projectId: input.projectId, phase: 'analyzing' };
  let approval: ApproveInput | undefined = input.resume ? {} : undefined;
  let paused = false;
  setHandler(viewQuery, () => view);
  setHandler(approveSignal, a => { approval = a; });
  setHandler(pauseSignal, () => { paused = true; });
  setHandler(resumeSignal, () => { paused = false; });
  const guides = new Map<string, GuideInput>();
  setHandler(guideSignal, g => { guides.set(g.taskId, g); });
  const retryMinutes = input.rateLimitRetryMinutes ?? 30;
  const maxWaitHours = input.rateLimitMaxWaitHours ?? 24;

  const analyzed = input.resume ? { dir: `${input.runRoot.replace(/\/+$/, '')}/${input.projectId}`, status: 'backlog_ready' } : await agentic.analyze(input);
  view.dir = analyzed.dir;
  view.status = analyzed.status;
  if (analyzed.status !== 'backlog_ready' && analyzed.status !== 'needs_answers') return { ...view, phase: 'finished' };

  // Approval gate: the run starts only once a human approves and every blocking question has an answer.
  const runId = `run-${workflowInfo().runId.slice(0, 8)}`;
  let plan: Awaited<ReturnType<Activities['beginRun']>>;
  for (;;) {
    view.phase = 'awaiting_approval';
    await condition(() => approval !== undefined);
    const a = approval!;
    approval = undefined;
    try {
      if (a.answers && Object.keys(a.answers).length) await short.applyAnswers(analyzed.dir, a.answers);
      plan = await short.beginRun(analyzed.dir, runId);
      break;
    } catch (error) {
      if (failureType(error) !== FailureType.validation) throw error;
      view.message = describe(error); // e.g. blocking questions still unanswered; wait for another approval
    }
  }

  view.phase = 'running';
  view.message = undefined;
  const dir = analyzed.dir;
  const waitIfPaused = async () => {
    if (!paused) return;
    view.phase = 'paused';
    await short.setStatus(dir, runId, 'paused');
    await condition(() => !paused);
    await short.setStatus(dir, runId, 'running');
    view.phase = 'running';
  };

  /** Drives one task to a final state: applies the manager's decision, and on escalation waits for a human. */
  const runTask = async (id: string, first: TaskWorkflowInput['input']) => {
    view.currentTask = id;
    let taskInput = first;
    try {
      for (let round = 0; ; round++) {
        const result = await executeChild(taskWorkflow, {
          workflowId: `${input.projectId}-${id}-${runId}${round ? `-h${round}` : ''}`,
          args: [{ dir, runId, taskId: id, input: taskInput, maxRepairs: plan.maxRepairs, rateLimitRetryMinutes: retryMinutes, rateLimitMaxWaitHours: maxWaitHours }],
        });
        const d = result.decision;
        if (result.passed || d?.decision !== 'split' && d?.decision !== 'escalate') return void await short.completeTask(dir, runId, id, result);
        if (d.decision === 'split') {
          try { return void await short.splitTask(dir, runId, id, d.subtasks!); } catch (error) {
            if (failureType(error) !== FailureType.validation) throw error;
            return void await short.completeTask(dir, runId, id, result, `the manager's split was invalid: ${describe(error).slice(0, 300)}`);
          }
        }
        await short.escalateTask(dir, runId, id, d.question!);
        view.phase = 'needs_attention';
        view.question = { taskId: id, question: d.question! };
        await condition(() => guides.has(id));
        const guide = guides.get(id)!;
        guides.delete(id);
        view.phase = 'running';
        view.question = undefined;
        await short.guideTask(dir, runId, guide);
        await short.setStatus(dir, runId, 'running');
        if (guide.action === 'skip') return void await short.completeTask(dir, runId, id, { ...result, decision: undefined }, 'skipped by the product owner');
        const restarted = await short.startTask(dir, runId, id);
        if (restarted.kind !== 'ready') return;
        taskInput = restarted.input; // the brief now carries the human's guidance
      }
    } catch (error) {
      await CancellationScope.nonCancellable(() => short.abandonTask(dir, runId, id, describe(error)));
      throw error;
    }
  };

  let stopped: { status: string; error: string } | undefined;
  try {
    if (patched('dynamic-backlog')) {
      // The backlog can grow while running (manager splits), so ask for the next pending task each time.
      for (;;) {
        await waitIfPaused();
        const start = await short.startNextTask(dir, runId);
        if (start.kind === 'none') break;
        if (start.kind === 'ready') await runTask(start.taskId, start.input);
      }
    } else {
      // Workflows started before dynamic backlogs replay their original fixed order.
      for (const { id } of plan.order) {
        await waitIfPaused();
        const start = await short.startTask(dir, runId, id);
        if (start.kind === 'ready') await runTask(id, start.input);
      }
    }
  } catch (error) {
    const type = failureType(error);
    if (isCancellation(error)) stopped = { status: 'cancelled', error: 'cancelled by user' };
    else if (type === FailureType.budget) stopped = { status: 'budget_exceeded', error: describe(error) };
    else if (type === FailureType.rateLimited) stopped = { status: 'rate_limited', error: describe(error) };
    else stopped = { status: 'failed', error: describe(error) };
  }
  view.currentTask = undefined;
  const final = await CancellationScope.nonCancellable(() => short.finishRun(analyzed.dir, runId, stopped));
  let message = stopped?.error;
  if (final.status === 'completed') {
    const delivered = await short.deliver(analyzed.dir);
    if (delivered.error) message = `Delivery failed (the branch is intact; retry from the UI or CLI): ${delivered.error}`;
  }
  return { ...view, phase: 'finished', status: final.status, message };
}

/** One backlog task: plan, then implement → gates → review attempts. Rate limits wait durably and retry the step. */
export async function taskWorkflow(t: TaskWorkflowInput): Promise<TaskWorkflowResult> {
  let waitedMs = 0;
  const withRateLimitRetry = async <T>(step: () => Promise<T>): Promise<T> => {
    for (;;) {
      try {
        return await step();
      } catch (error) {
        if (failureType(error) !== FailureType.rateLimited || waitedMs >= t.rateLimitMaxWaitHours * 3_600_000) throw error;
        await short.setStatus(t.dir, t.runId, 'rate_limited', `${describe(error).slice(0, 300)} (retrying in ${t.rateLimitRetryMinutes} min)`);
        await sleep(`${t.rateLimitRetryMinutes} minutes`);
        waitedMs += t.rateLimitRetryMinutes * 60_000;
        await short.setStatus(t.dir, t.runId, 'running');
      }
    }
  };
  // Rounds: the manager's retry guidance extends the brief and the task is re-planned from a clean tree.
  let input = t.input;
  let attempts = 0;
  let reviewSummary: string | undefined;
  for (let round = 0; ; round++) {
    const plan = await withRateLimitRetry(() => agentic.planTask(t.dir, t.runId, { ...input, round }));
    let feedback = '';
    const gates: Gate[] = [];
    for (let i = 0; i <= t.maxRepairs; i++) {
      const n = attempts++; // outside the closure: a rate-limit retry repeats the same attempt
      const r = await withRateLimitRetry(() => agentic.attemptTask(t.dir, t.runId, input, plan, feedback, n));
      gates.push(r.gate);
      reviewSummary = r.review?.summary ?? reviewSummary;
      if (r.gate === 'passed') return { passed: true, attempts, reviewSummary };
      feedback = r.feedback;
    }
    const decision = await withRateLimitRetry(() => agentic.superviseTask(t.dir, t.runId, t.taskId, { requirement: input.requirement, attempts, gates, feedback, reviewSummary }));
    if (decision.decision !== 'retry') return { passed: false, attempts, reviewSummary, decision };
    input = { ...input, requirement: input.requirement + guidanceSection([{ from: 'manager', text: decision.guidance! }]) };
  }
}
