import type { CheckRunnerConfig, KubernetesConfig } from './config.js';
import { ensureImage, runContainer } from './container.js';
import { AbortedError, execute, type ProcessResult } from './process.js';

export interface CheckResult { command: string[]; phase: 'setup' | 'check'; code: number; timedOut: boolean; durationMs: number; stdout: string; stderr: string; }
export interface CheckRunner {
  readonly kind: string;
  /** Fail fast (before any LLM spend) if the runner cannot work. */
  prepare(): Promise<void>;
  runAll(worktree: string, checks: string[][], timeoutMs: number): Promise<CheckResult[]>;
}

async function capture(command: string[], phase: CheckResult['phase'], run: () => Promise<ProcessResult>): Promise<CheckResult> {
  try {
    const r = await run();
    return { command, phase, code: r.code, timedOut: r.timedOut, durationMs: r.durationMs, stdout: r.stdout, stderr: r.stderr };
  } catch (error) {
    if (error instanceof AbortedError) throw error;
    // e.g. ENOENT: a missing binary is a failed check, not a crashed run.
    return { command, phase, code: 127, timedOut: false, durationMs: 0, stdout: '', stderr: String(error) };
  }
}

/** Runs checks directly on the host. Only for trusted repos: agent-written code executes with your privileges. */
export class HostCheckRunner implements CheckRunner {
  readonly kind = 'host';
  async prepare(): Promise<void> {}
  async runAll(worktree: string, checks: string[][], timeoutMs: number): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    for (const command of checks) results.push(await capture(command, 'check', () => execute(command[0], command.slice(1), worktree, { timeoutMs })));
    return results;
  }
}

type ContainerConfig = Extract<CheckRunnerConfig, { type: 'container' }>;

/** Runs setup and checks in a throwaway container with the worktree bind-mounted; checks get no network. */
export class ContainerCheckRunner implements CheckRunner {
  readonly kind = 'container';
  constructor(private config: ContainerConfig) {}

  async prepare(): Promise<void> {
    await ensureImage(this.config.engine, this.config.image);
  }

  async runAll(worktree: string, checks: string[][], timeoutMs: number): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    for (const command of this.config.setup) {
      const result = await this.run(command, 'setup', worktree, this.config.setupNetwork, timeoutMs);
      results.push(result);
      if (result.code !== 0) return results; // checks are meaningless without a working setup
    }
    for (const command of checks) results.push(await this.run(command, 'check', worktree, 'none', timeoutMs));
    return results;
  }

  private run(command: string[], phase: CheckResult['phase'], worktree: string, network: string, timeoutMs: number): Promise<CheckResult> {
    const { engine, image, memory, cpus, pidsLimit } = this.config;
    return capture(command, phase, () => runContainer({
      engine, image, command, workdir: worktree, network, memory, cpus, pidsLimit, namePrefix: 'agentic-check',
      mounts: [{ path: worktree }], env: { HOME: '/tmp', CI: '1' },
    }, { timeoutMs }));
  }
}

export async function createCheckRunner(config: CheckRunnerConfig, kubernetes: KubernetesConfig): Promise<CheckRunner> {
  if (config.type === 'host') return new HostCheckRunner();
  if (config.type === 'container') return new ContainerCheckRunner(config);
  const { KubernetesCheckRunner } = await import('./kube.js');
  return new KubernetesCheckRunner(kubernetes, config);
}
