import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AgentRuntimeConfig, KubernetesConfig } from './config.js';
import { ensureImage, ensureNetwork, runContainer, type Mount } from './container.js';
import { execute, type ProcessResult } from './process.js';

export interface AgentExec {
  command: string;
  args: string[];
  cwd: string;
  input: string;
  timeoutMs: number;
  env?: Record<string, string>;
  secretEnv?: Record<string, string>;
  /** Host env var names to forward (values are looked up on the host). */
  passEnv?: readonly string[];
  /** Ignored by the host runtime. */
  mounts?: Mount[];
}
export interface AgentRuntime {
  readonly kind: 'host' | 'container' | 'kubernetes';
  prepare(): Promise<void>;
  exec(spec: AgentExec): Promise<ProcessResult>;
}

export class HostAgentRuntime implements AgentRuntime {
  readonly kind = 'host';
  async prepare(): Promise<void> {}
  exec(s: AgentExec): Promise<ProcessResult> {
    return execute(s.command, s.args, s.cwd, { input: s.input, timeoutMs: s.timeoutMs, passEnv: s.passEnv, env: { ...s.env, ...s.secretEnv } });
  }
}

type ContainerConfig = Extract<AgentRuntimeConfig, { type: 'container' }>;
export const SANDBOX_HOSTS = ['agentic-litellm', 'agentic-otel-collector'];

/** Each agent invocation is a fresh container: read-only root, tmpfs home, explicit mounts, egress only via the proxy. */
export class ContainerAgentRuntime implements AgentRuntime {
  readonly kind = 'container';
  constructor(private config: ContainerConfig) {}

  async prepare(): Promise<void> {
    await ensureImage(this.config.engine, this.config.image, 'Build it with: npm run sandbox:build');
    await ensureNetwork(this.config.engine, this.config.network, 'Start the stack with: npm run stack:up');
  }

  exec(s: AgentExec): Promise<ProcessResult> {
    const { engine, image, network, proxy, memory, cpus, pidsLimit } = this.config;
    const forwarded = Object.fromEntries((s.passEnv ?? []).flatMap(k => process.env[k] !== undefined ? [[k, process.env[k]!]] : []));
    const noProxy = ['localhost', '127.0.0.1', ...SANDBOX_HOSTS].join(',');
    return runContainer({
      engine, image, network, memory, cpus, pidsLimit, namePrefix: 'agentic-agent',
      command: [s.command, ...s.args], workdir: s.cwd, mounts: s.mounts ?? [],
      readOnlyRoot: true, tmpfs: ['/tmp:rw,exec,mode=1777', '/home/agent:rw,exec,mode=1777'],
      env: {
        HOME: '/home/agent', CI: '1',
        HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: noProxy, no_proxy: noProxy,
        // Mounted files may appear owned by another uid inside the VM; git would refuse them as "dubious ownership".
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*',
        ...s.env,
      },
      secretEnv: { ...forwarded, ...s.secretEnv },
    }, { input: s.input, timeoutMs: s.timeoutMs });
  }
}

export async function createAgentRuntime(config: AgentRuntimeConfig, kubernetes: KubernetesConfig): Promise<AgentRuntime> {
  if (config.type === 'host') return new HostAgentRuntime();
  if (config.type === 'container') return new ContainerAgentRuntime(config);
  const { KubernetesAgentRuntime } = await import('./kube.js');
  return new KubernetesAgentRuntime(kubernetes, config.image, { memory: config.memory, cpu: config.cpu });
}

/**
 * Mounts that expose a git worktree to an agent: the worktree, the repository's git dir (always read-only),
 * and the worktree's own admin dir (index, HEAD), writable only for writers.
 */
export async function worktreeMounts(worktree: string, access: 'ro' | 'rw'): Promise<Mount[]> {
  const readOnly = access === 'ro';
  let dotgit: string;
  try { dotgit = await readFile(join(worktree, '.git'), 'utf8'); } catch { return [{ path: worktree, readOnly }]; }
  const match = /^gitdir:\s*(.+)$/m.exec(dotgit);
  if (!match) return [{ path: worktree, readOnly }];
  const adminDir = resolve(worktree, match[1].trim());
  const commonDir = resolve(adminDir, (await readFile(join(adminDir, 'commondir'), 'utf8')).trim());
  return [{ path: worktree, readOnly }, { path: commonDir, readOnly: true }, { path: adminDir, readOnly }];
}
