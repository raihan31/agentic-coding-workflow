import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Mount } from './container.js';
import type { AgentCredentials } from './credentials.js';
import type { ProcessResult } from './process.js';
import { worktreeMounts, type AgentRuntime } from './runtime.js';

export interface Usage { inputTokens: number; outputTokens: number; }
export interface AgentResult { output: string; costUsd?: number; usage?: Usage; }
export interface Agent { run(prompt: string, cwd: string, outDir: string, phase: string): Promise<AgentResult>; }
/** Where and with what an agent runs. */
export interface AgentContext { runtime: AgentRuntime; creds: AgentCredentials; telemetryEnv?: Record<string, string>; }
export interface AgentOptions { model?: string; timeoutMs: number; passEnv?: readonly string[]; }
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

/** The agent process ran but failed (non-zero exit, timeout, unusable output). Recoverable by the workflow. */
export class AgentError extends Error { constructor(message: string) { super(message); this.name = 'AgentError'; } }
/** The provider refused for quota or rate reasons. Retrying now is pointless; waiting fixes it. */
export class RateLimitedError extends Error { constructor(message: string) { super(message); this.name = 'RateLimitedError'; } }

const RATE_LIMIT = /usage limit|session limit|weekly limit|hit your (?:\w+ )?limit|rate[ _-]?limit|too many requests|\b429\b|quota exceeded|insufficient_quota|overloaded_error|\b529\b/i;
export const isRateLimitMessage = (text: string) => RATE_LIMIT.test(text);

async function invoke(ctx: AgentContext, opts: AgentOptions, command: string, args: string[], cwd: string, prompt: string, mounts: Mount[], log: string): Promise<ProcessResult> {
  const result = await ctx.runtime.exec({
    command, args, cwd, input: prompt, timeoutMs: opts.timeoutMs,
    env: { ...ctx.creds.env, ...ctx.telemetryEnv }, secretEnv: ctx.creds.secretEnv,
    passEnv: [...ctx.creds.passEnv, ...(opts.passEnv ?? [])], mounts: [...mounts, ...ctx.creds.mounts],
  });
  await writeFile(log, `${result.stdout}\n--- stderr ---\n${result.stderr}`);
  return result;
}
function failure(command: string, result: ProcessResult, timeoutMs: number): AgentError | RateLimitedError {
  const reason = result.timedOut ? `timed out after ${timeoutMs}ms` : `exited ${result.code}`;
  const output = (result.stderr || result.stdout).slice(-2000);
  // Only error channels: stdout also carries the agent's own work, which may legitimately mention rate limits.
  const errorEvents = result.stdout.split('\n').filter(l => /^\{"type":"(error|turn\.failed)"/.test(l)).join('\n');
  if (!result.timedOut && isRateLimitMessage(`${errorEvents}\n${result.stderr.slice(-4000)}`)) return new RateLimitedError(`${command} was rate limited: ${errorMessages(errorEvents) || output}`);
  return new AgentError(`${command} ${reason}: ${output}`);
}
/** Human-readable messages from Codex JSONL error events (deduplicated). */
function errorMessages(jsonl: string): string {
  const messages = new Set<string>();
  for (const line of jsonl.split('\n')) {
    try {
      const e = JSON.parse(line) as { message?: string; error?: { message?: string } };
      const m = e.message ?? e.error?.message;
      if (m) messages.add(m);
    } catch { /* not JSON */ }
  }
  return [...messages].join(' ');
}
async function readOptional(path: string): Promise<string> {
  try { return await readFile(path, 'utf8'); } catch { return ''; }
}
/** Private, writable directory for one agent phase (the rest of the run directory is not mounted). */
async function ioDir(outDir: string, phase: string): Promise<string> {
  const dir = join(outDir, 'io', phase);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Sums token usage from `codex exec --json` events. */
export function codexUsage(jsonl: string): Usage | undefined {
  let usage: Usage | undefined;
  for (const line of jsonl.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const event = JSON.parse(line) as { type?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      if (event.type !== 'turn.completed' || !event.usage) continue;
      usage ??= { inputTokens: 0, outputTokens: 0 };
      usage.inputTokens += event.usage.input_tokens ?? 0;
      usage.outputTokens += event.usage.output_tokens ?? 0;
    } catch { /* non-JSON line */ }
  }
  return usage;
}

const ClaudeJson = z.looseObject({
  subtype: z.string().optional(), is_error: z.boolean().optional(), result: z.string().optional(), total_cost_usd: z.number().optional(),
  structured_output: z.unknown().optional(),
  usage: z.looseObject({ input_tokens: z.number().optional(), output_tokens: z.number().optional(), cache_read_input_tokens: z.number().optional(), cache_creation_input_tokens: z.number().optional() }).optional(),
});
type ClaudeOptions = AgentOptions & {
  maxBudgetUsd?: number;
  /** Directories outside the working directory Claude may read (its permission layer otherwise denies them, mounted or not). */
  addDirs?: string[];
};

/** Runs `claude -p` with read-only tools and returns its parsed JSON result. */
async function runClaude(ctx: AgentContext, opts: ClaudeOptions, extraArgs: string[], prompt: string, cwd: string, outDir: string, phase: string) {
  const args = ['-p', '--tools', 'Read,Glob,Grep', '--output-format', 'json', ...(opts.addDirs ?? []).flatMap(d => ['--add-dir', d]), ...extraArgs];
  if (opts.model) args.push('--model', opts.model);
  if (opts.maxBudgetUsd) args.push('--max-budget-usd', String(opts.maxBudgetUsd));
  const result = await invoke(ctx, opts, 'claude', args, cwd, prompt, await worktreeMounts(cwd, 'ro'), join(outDir, `${phase}.log`));
  let parsed: z.infer<typeof ClaudeJson> | undefined;
  try { parsed = ClaudeJson.parse(JSON.parse(result.stdout)); } catch { /* fall through */ }
  if (result.code !== 0 && !parsed) throw failure('claude', result, opts.timeoutMs);
  if (!parsed) throw new AgentError('claude returned non-JSON output');
  if (parsed.is_error || (parsed.subtype && parsed.subtype !== 'success')) {
    const message = `claude failed (${parsed.subtype ?? 'error'}): ${(parsed.result ?? '').slice(0, 2000)}`;
    throw isRateLimitMessage(message) ? new RateLimitedError(message) : new AgentError(message);
  }
  const u = parsed.usage;
  const usage = u && { inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), outputTokens: u.output_tokens ?? 0 };
  return { parsed, usage, costUsd: parsed.total_cost_usd };
}

export class ClaudePlanner implements Agent {
  constructor(private ctx: AgentContext, private opts: ClaudeOptions) {}
  async run(prompt: string, cwd: string, outDir: string, phase: string): Promise<AgentResult> {
    const { parsed, usage, costUsd } = await runClaude(this.ctx, this.opts, [], prompt, cwd, outDir, phase);
    const output = parsed.result ?? '';
    if (!output.trim()) throw new AgentError('Claude returned an empty plan');
    await writeFile(join(outDir, `${phase}.md`), output);
    return { output, costUsd, usage };
  }
}

/** Claude with a JSON schema enforced on its output (analyst: document → backlog; manager: failure → decision). */
export class ClaudeStructured implements Agent {
  constructor(private ctx: AgentContext, private opts: ClaudeOptions & { jsonSchema: Record<string, unknown> }) {}
  async run(prompt: string, cwd: string, outDir: string, phase: string): Promise<AgentResult> {
    const { parsed, usage, costUsd } = await runClaude(this.ctx, this.opts, ['--json-schema', JSON.stringify(this.opts.jsonSchema)], prompt, cwd, outDir, phase);
    if (parsed.structured_output === undefined) throw new AgentError('claude returned no structured output');
    const output = JSON.stringify(parsed.structured_output, null, 2);
    await writeFile(join(outDir, `${phase}.json`), output);
    return { output, costUsd, usage };
  }
}

export class CodexDeveloper implements Agent {
  constructor(private ctx: AgentContext, private opts: AgentOptions & { sandbox: CodexSandbox }) {}
  async run(prompt: string, cwd: string, outDir: string, phase: string): Promise<AgentResult> {
    const io = await ioDir(outDir, phase);
    const last = join(io, 'last-message.md');
    const args = ['exec', '--json', '--sandbox', this.opts.sandbox, ...(this.opts.model ? ['-m', this.opts.model] : []), '--output-last-message', last, '-'];
    const mounts = [...await worktreeMounts(cwd, 'rw'), { path: io }];
    const result = await invoke(this.ctx, this.opts, 'codex', args, cwd, prompt, mounts, join(outDir, `${phase}.log`));
    if (result.code !== 0) throw failure('codex', result, this.opts.timeoutMs);
    const output = await readOptional(last);
    await writeFile(join(outDir, `${phase}.md`), output);
    return { output, usage: codexUsage(result.stdout) };
  }
}

export class CodexReviewer implements Agent {
  constructor(private ctx: AgentContext, private schemaPath: string, private opts: AgentOptions & { sandbox: CodexSandbox }) {}
  async run(prompt: string, cwd: string, outDir: string, phase: string): Promise<AgentResult> {
    const io = await ioDir(outDir, phase);
    const last = join(io, 'review.json');
    const args = ['exec', '--json', '--sandbox', this.opts.sandbox, ...(this.opts.model ? ['-m', this.opts.model] : []), '--output-schema', this.schemaPath, '--output-last-message', last, '-'];
    const mounts = [...await worktreeMounts(cwd, 'ro'), { path: io }, { path: this.schemaPath, readOnly: true }];
    const result = await invoke(this.ctx, this.opts, 'codex', args, cwd, prompt, mounts, join(outDir, `${phase}.log`));
    if (result.code !== 0) throw failure('codex', result, this.opts.timeoutMs);
    const output = await readOptional(last);
    if (!output.trim()) throw new AgentError('codex reviewer produced no output');
    await writeFile(join(outDir, `${phase}.json`), output);
    return { output, usage: codexUsage(result.stdout) };
  }
}
