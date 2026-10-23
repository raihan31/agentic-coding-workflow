/** Shared between workflow code (deterministic sandbox) and the client/worker. No Node imports here (type imports are erased). */
import type { ManagerDecision } from '../manager.js';

export const TASK_QUEUE = 'agentic';

export interface ProjectInput {
  projectId: string;
  repo: string;
  /** Absolute path readable by the worker. */
  document: string;
  runRoot: string;
  /** Parsed workflow config (no secrets; it is stored in workflow history). */
  config: unknown;
  /** How long to wait before retrying after a provider rate limit, and for how long in total. */
  rateLimitRetryMinutes?: number;
  rateLimitMaxWaitHours?: number;
  /**
   * Run an already-analyzed project again (after failed, partial, rate_limited, ...): skips analysis, and the request
   * itself is the approval. Done tasks are kept; the others are retried.
   */
  resume?: boolean;
}

export type Phase = 'analyzing' | 'awaiting_approval' | 'running' | 'paused' | 'waiting_rate_limit' | 'needs_attention' | 'finished';
export interface ProjectView {
  projectId: string;
  dir?: string;
  phase: Phase;
  status?: string;
  currentTask?: string;
  message?: string;
  /** An escalated task waiting for a `guide` signal. */
  question?: { taskId: string; question: string };
}
export interface ApproveInput { answers?: Record<string, string>; }
/** A human's answer to an escalated task: retry it with guidance, or give up on it. */
export interface GuideInput { taskId: string; action: 'retry' | 'skip'; guidance?: string; }
export interface TaskWorkflowInput {
  dir: string;
  runId: string;
  taskId: string;
  input: { worktree: string; dir: string; requirement: string; baseSha: string; taskId?: string };
  maxRepairs: number;
  rateLimitRetryMinutes: number;
  rateLimitMaxWaitHours: number;
}
export interface TaskWorkflowResult {
  passed: boolean; attempts: number; reviewSummary?: string;
  /** For a failed task: the manager's final (non-retry) decision, applied by the project workflow. */
  decision?: ManagerDecision;
}

/** Failure types activities raise as non-retryable ApplicationFailures. */
export const FailureType = {
  budget: 'BudgetExceeded',
  rateLimited: 'RateLimited',
  validation: 'ValidationError',
} as const;
