import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { execute, type ExecOptions, type ProcessResult } from './process.js';

export type Engine = 'docker' | 'podman';
/** Bind mount. Paths are mounted at the same absolute path inside the container so argv stays identical to host mode. */
export interface Mount { path: string; readOnly?: boolean; }
export interface ContainerSpec {
  engine: Engine;
  image: string;
  command: string[];
  workdir: string;
  network: string;
  mounts: Mount[];
  /** Non-secret variables, passed inline as `-e KEY=value`. */
  env?: Record<string, string>;
  /** Secrets: handed to the engine CLI via its own environment and referenced by name (`-e KEY`), so they never appear in argv. */
  secretEnv?: Record<string, string>;
  memory: string;
  cpus: string;
  pidsLimit: number;
  readOnlyRoot?: boolean;
  tmpfs?: string[];
  namePrefix?: string;
}

export const ENGINE_ENV = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'CONTAINER_HOST', 'XDG_RUNTIME_DIR'];
const running = new Map<string, Engine>(); // container name -> engine

/** Force-remove containers still running (used on abort; synchronous so it works during shutdown). */
export function stopContainers(): void {
  for (const [name, engine] of running) spawnSync(engine, ['rm', '-f', name], { stdio: 'ignore', timeout: 30_000 });
  running.clear();
}

export function containerArgs(spec: ContainerSpec, name: string): string[] {
  const user = typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid!()}`] : [];
  // Shallower mounts first so a nested read-only/read-write override wins.
  const mounts = [...spec.mounts].sort((a, b) => a.path.length - b.path.length)
    .flatMap(m => ['--mount', `type=bind,src=${m.path},dst=${m.path}${m.readOnly ? ',readonly' : ''}`]);
  return ['run', '--rm', '-i', '--init', '--name', name, '--network', spec.network,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', String(spec.pidsLimit),
    '--memory', spec.memory, '--cpus', spec.cpus, ...user,
    ...(spec.readOnlyRoot ? ['--read-only'] : []),
    ...(spec.tmpfs ?? []).flatMap(t => ['--tmpfs', t]),
    ...Object.entries(spec.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ...Object.keys(spec.secretEnv ?? {}).flatMap(k => ['-e', k]),
    ...mounts, '-w', spec.workdir, spec.image, ...spec.command];
}

export async function runContainer(spec: ContainerSpec, opts: Pick<ExecOptions, 'input' | 'timeoutMs' | 'maxOutputChars'> = {}): Promise<ProcessResult> {
  const name = `${spec.namePrefix ?? 'agentic'}-${randomBytes(6).toString('hex')}`;
  running.set(name, spec.engine);
  // Killing the engine CLI (timeout, cancellation) does not stop the container itself.
  const remove = () => spawnSync(spec.engine, ['rm', '-f', name], { stdio: 'ignore', timeout: 30_000 });
  try {
    const result = await execute(spec.engine, containerArgs(spec, name), process.cwd(), { ...opts, env: spec.secretEnv, passEnv: ENGINE_ENV });
    if (result.timedOut) remove();
    return result;
  } catch (error) {
    remove();
    throw error;
  } finally {
    running.delete(name);
  }
}

async function engineOk(engine: Engine, args: string[]): Promise<boolean> {
  try {
    return (await execute(engine, args, process.cwd(), { passEnv: ENGINE_ENV, timeoutMs: 60_000 })).code === 0;
  } catch (error) {
    throw new Error(`Container engine "${engine}" is not available: ${String(error)}`);
  }
}

export async function ensureImage(engine: Engine, image: string, missingHint?: string): Promise<void> {
  if (await engineOk(engine, ['image', 'inspect', image])) return;
  if (missingHint) throw new Error(`Image ${image} not found. ${missingHint}`);
  const pull = await execute(engine, ['pull', image], process.cwd(), { passEnv: ENGINE_ENV, timeoutMs: 900_000 });
  if (pull.code !== 0) throw new Error(`Could not pull ${image}: ${pull.stderr.slice(-2000)}`);
}

export async function ensureNetwork(engine: Engine, network: string, missingHint: string): Promise<void> {
  if (['none', 'bridge', 'host'].includes(network)) return;
  if (!await engineOk(engine, ['network', 'inspect', network])) throw new Error(`Container network "${network}" not found. ${missingHint}`);
}
