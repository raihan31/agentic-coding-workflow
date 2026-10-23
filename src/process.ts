import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, type ChildProcess } from 'node:child_process';

export interface ProcessResult { code: number; stdout: string; stderr: string; timedOut: boolean; truncated: boolean; durationMs: number; }
export interface ExecOptions {
  input?: string;
  timeoutMs?: number;
  /** Extra environment variable names copied from the host env (on top of BASE_ENV). */
  passEnv?: readonly string[];
  /** Explicit environment values; these win over host values. */
  env?: Record<string, string>;
  /** Only the last maxOutputChars of each stream are kept in memory. */
  maxOutputChars?: number;
  /** Time between SIGTERM and SIGKILL when a timeout fires. */
  killGraceMs?: number;
}

/** Never forward the full host environment: secrets in it would reach agents and repo scripts. */
export const BASE_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'TZ'] as const;

export class AbortedError extends Error { constructor() { super('Run aborted'); this.name = 'AbortedError'; } }

export function safeEnv(passEnv: readonly string[] = [], env: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of [...BASE_ENV, ...passEnv]) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  return { ...result, CI: '1', ...env };
}

const active = new Set<ChildProcess>();
let aborted = false;
const abortScope = new AsyncLocalStorage<AbortSignal>();

/** Every process started inside `fn` is killed (tree and all) when `signal` aborts, e.g. a cancelled Temporal activity. */
export function withAbortSignal<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return abortScope.run(signal, fn);
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  // Children are spawned detached (own process group), so -pid reaches grandchildren too.
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
}

/** The abort signal of the enclosing withAbortSignal scope, for work that is not a child process (e.g. Kubernetes pods). */
export const currentAbortSignal = (): AbortSignal | undefined => abortScope.getStore();

const abortHooks = new Set<() => void>();
/** Registers cleanup to run on abortAll (e.g. deleting remote pods); returns an unregister function. */
export function onAbortAll(hook: () => void): () => void { abortHooks.add(hook); return () => abortHooks.delete(hook); }

/** Kill every running child process tree; subsequent execute() calls reject with AbortedError. */
export function abortAll(): void {
  aborted = true;
  for (const hook of abortHooks) { try { hook(); } catch { /* best effort */ } }
  for (const child of active) {
    killTree(child, 'SIGTERM');
    setTimeout(() => killTree(child, 'SIGKILL'), 5_000).unref();
  }
}
export function isAborted(): boolean { return aborted; }

class Tail {
  private text = '';
  truncated = false;
  constructor(private max: number) {}
  push(chunk: string): void {
    this.text += chunk;
    if (this.text.length > this.max * 2) this.trim();
  }
  private trim(): void {
    if (this.text.length > this.max) { this.text = this.text.slice(-this.max); this.truncated = true; }
  }
  toString(): string {
    this.trim();
    return this.truncated ? `[...truncated...]\n${this.text}` : this.text;
  }
}

export async function execute(command: string, args: string[], cwd: string, opts: ExecOptions = {}): Promise<ProcessResult> {
  const signal = abortScope.getStore();
  if (aborted || signal?.aborted) throw new AbortedError();
  const { input = '', timeoutMs = 600_000, maxOutputChars = 1_000_000, killGraceMs = 5_000 } = opts;
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: safeEnv(opts.passEnv, opts.env) });
    active.add(child);
    const stdout = new Tail(maxOutputChars); const stderr = new Tail(maxOutputChars);
    let settled = false; let timedOut = false; let cancelled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      cancelled = true;
      killTree(child, 'SIGTERM');
      killTimer = setTimeout(() => killTree(child, 'SIGKILL'), killGraceMs);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM');
      killTimer = setTimeout(() => killTree(child, 'SIGKILL'), killGraceMs);
    }, timeoutMs);
    const finish = (error?: Error, code?: number) => {
      if (settled) return;
      settled = true;
      active.delete(child);
      clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      if (error) return reject(error);
      if (aborted || cancelled) return reject(new AbortedError());
      resolve({ code: timedOut ? 124 : code ?? 1, stdout: stdout.toString(), stderr: stderr.toString(), timedOut, truncated: stdout.truncated || stderr.truncated, durationMs: Date.now() - started });
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => stdout.push(chunk));
    child.stderr.on('data', (chunk: string) => stderr.push(chunk));
    child.on('error', error => finish(error));
    // Leftover background processes would keep stdio open (and keep mutating the worktree): reap the group.
    child.on('exit', () => killTree(child, 'SIGKILL'));
    child.on('close', code => finish(undefined, code ?? 1));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function required(command: string, args: string[], cwd: string, opts: ExecOptions = {}): Promise<ProcessResult> {
  const result = await execute(command, args, cwd, opts);
  if (result.code !== 0) {
    const reason = result.timedOut ? `timed out after ${opts.timeoutMs ?? 600_000}ms` : `exited ${result.code}`;
    throw new Error(`${command} ${args.join(' ')} ${reason}: ${result.stderr.slice(-3000)}`);
  }
  return result;
}

/** Last n characters of a string, marked when cut. For keeping prompts bounded. */
export function tail(text: string, n: number): string {
  return text.length <= n ? text : `[...${text.length - n} chars omitted...]\n${text.slice(-n)}`;
}
