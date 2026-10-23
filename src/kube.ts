import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { request as httpRequest } from 'node:http';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { CheckResult, CheckRunner } from './checks.js';
import type { KubernetesConfig } from './config.js';
import type { Mount } from './container.js';
import { AbortedError, currentAbortSignal, onAbortAll, type ProcessResult } from './process.js';
import type { AgentExec, AgentRuntime } from './runtime.js';

// ---------------------------------------------------------------- API client

/** Minimal Kubernetes REST client: in-cluster service-account credentials, or AGENTIC_K8S_SERVER/TOKEN/CA_FILE. */
export class KubeClient {
  constructor(readonly server: string, private token: string, private ca: Buffer | undefined, readonly namespace: string) {}

  static fromEnv(namespace?: string, env: NodeJS.ProcessEnv = process.env): KubeClient {
    const sa = '/var/run/secrets/kubernetes.io/serviceaccount';
    const read = (path: string) => { try { return readFileSync(path); } catch { return undefined; } };
    if (env.AGENTIC_K8S_SERVER) {
      if (!env.AGENTIC_K8S_TOKEN) throw new Error('AGENTIC_K8S_SERVER is set without AGENTIC_K8S_TOKEN');
      return new KubeClient(env.AGENTIC_K8S_SERVER, env.AGENTIC_K8S_TOKEN, env.AGENTIC_K8S_CA_FILE ? read(env.AGENTIC_K8S_CA_FILE) : undefined, namespace ?? env.AGENTIC_K8S_NAMESPACE ?? 'default');
    }
    const token = read(`${sa}/token`)?.toString().trim();
    if (!token || !env.KUBERNETES_SERVICE_HOST) throw new Error('Not running in a Kubernetes pod and AGENTIC_K8S_SERVER is not set');
    return new KubeClient(`https://${env.KUBERNETES_SERVICE_HOST}:${env.KUBERNETES_SERVICE_PORT ?? 443}`, token, read(`${sa}/ca.crt`),
      namespace ?? read(`${sa}/namespace`)?.toString().trim() ?? 'default');
  }

  async call<T>(method: string, path: string, body?: unknown, contentType = 'application/json'): Promise<{ status: number; data: T }> {
    const url = new URL(path, this.server);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return await new Promise((resolve, reject) => {
      const req = (url.protocol === 'http:' ? httpRequest : request)(url, {
        method, ca: this.ca, timeout: 30_000,
        headers: { authorization: `Bearer ${this.token}`, accept: 'application/json', ...(payload ? { 'content-type': contentType, 'content-length': Buffer.byteLength(payload) } : {}) },
      }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', c => { text += c; });
        res.on('end', () => { try { resolve({ status: res.statusCode ?? 0, data: (text ? JSON.parse(text) : undefined) as T }); } catch { resolve({ status: res.statusCode ?? 0, data: text as T }); } });
      });
      req.on('timeout', () => req.destroy(new Error(`Kubernetes API ${method} ${url.pathname} timed out`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async ok<T>(method: string, path: string, body?: unknown, contentType?: string): Promise<T> {
    const r = await this.call<T & { message?: string }>(method, path, body, contentType);
    if (r.status < 200 || r.status >= 300) throw new Error(`Kubernetes API ${method} ${path}: ${r.status} ${typeof r.data === 'string' ? r.data : r.data?.message ?? ''}`.slice(0, 600));
    return r.data;
  }

  ns(path: string) { return `/api/v1/namespaces/${encodeURIComponent(this.namespace)}/${path}`; }
}

// ---------------------------------------------------------------- pod runner

export type SandboxKind = 'agent' | 'check' | 'check-setup';
export interface PodRun {
  kind: SandboxKind; image: string; command: string[]; cwd: string; input?: string; timeoutMs: number;
  mounts: Mount[]; env: Record<string, string>; secretEnv: Record<string, string>; memory: string; cpu: string;
}
interface Pod { metadata: { name: string; uid: string }; status?: { phase?: string; containerStatuses?: { state?: { running?: object; waiting?: { reason?: string; message?: string }; terminated?: { exitCode: number; reason?: string } } }[] }; }

/**
 * Waits for the worker's go-ahead, then runs the command with stdin/stdout/stderr redirected to files on the shared
 * volume (pod logs would merge the streams). The go-ahead comes once the container runs plus `networkSettleMs`:
 * many CNIs program NetworkPolicy for a new pod a few seconds after it starts, and nothing may run before that.
 */
const WRAP = 'while [ ! -e "$AGENTIC_IO/go" ]; do sleep 0.2; done; exec "$0" "$@" < "$AGENTIC_IO/stdin" > "$AGENTIC_IO/stdout" 2> "$AGENTIC_IO/stderr"';
const FATAL_WAITING = new Set(['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName', 'CreateContainerConfigError', 'CreateContainerError']);
const MAX_OUTPUT = 4_000_000;

/** Pure pod manifest builder (unit-tested): every mount must live on the shared volume and becomes a subPath mount. */
export function podManifest(config: KubernetesConfig, run: PodRun, io: string, secretName: string | undefined, ids = { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 }) {
  const root = config.volume.mountPath;
  const sub = (path: string) => {
    const rel = relative(root, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${path} is not on the shared volume ${root}; Kubernetes sandboxes can only mount paths under it`);
    return rel;
  };
  const mounts = [...run.mounts, { path: io }].sort((a, b) => a.path.length - b.path.length)
    .map(m => ({ name: 'data', mountPath: m.path, subPath: sub(m.path), readOnly: Boolean(m.readOnly) }));
  return {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { generateName: `agentic-${run.kind}-`, labels: { 'app.kubernetes.io/part-of': 'agentic-orchestrator', 'agentic.dev/sandbox': run.kind } },
    spec: {
      restartPolicy: 'Never', activeDeadlineSeconds: Math.ceil(run.timeoutMs / 1000) + 60,
      automountServiceAccountToken: false, enableServiceLinks: false,
      ...(config.serviceAccountName ? { serviceAccountName: config.serviceAccountName } : {}),
      ...(config.runtimeClassName ? { runtimeClassName: config.runtimeClassName } : {}),
      ...(config.imagePullSecrets.length ? { imagePullSecrets: config.imagePullSecrets.map(name => ({ name })) } : {}),
      ...(Object.keys(config.nodeSelector).length ? { nodeSelector: config.nodeSelector } : {}),
      securityContext: { runAsNonRoot: true, runAsUser: ids.uid, runAsGroup: ids.gid, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [{
        name: 'main', image: run.image, workingDir: run.cwd, command: ['/bin/sh', '-c', WRAP, ...run.command],
        env: [
          ...Object.entries({ ...run.env, AGENTIC_IO: io }).map(([name, value]) => ({ name, value })),
          ...Object.keys(run.secretEnv).map(name => ({ name, valueFrom: { secretKeyRef: { name: secretName!, key: name } } })),
        ],
        resources: { requests: { memory: run.memory, cpu: run.cpu }, limits: { memory: run.memory, cpu: run.cpu } },
        securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
        volumeMounts: [...mounts, { name: 'tmp', mountPath: '/tmp' }, { name: 'home', mountPath: '/home/agent' }],
      }],
      volumes: [
        { name: 'data', persistentVolumeClaim: { claimName: config.volume.claimName } },
        { name: 'tmp', emptyDir: { sizeLimit: '2Gi' } }, { name: 'home', emptyDir: { sizeLimit: '1Gi' } },
      ],
    },
  };
}

const live = new Map<string, KubeClient>(); // pod name -> client, for abortAll
onAbortAll(() => { for (const [name, kube] of live) void kube.call('DELETE', kube.ns(`pods/${name}?gracePeriodSeconds=0`)).catch(() => {}); live.clear(); });

/** One sandboxed command as a pod; resolves like execute(): exit code, captured output, timeout flag. */
export async function runPod(kube: KubeClient, config: KubernetesConfig, run: PodRun): Promise<ProcessResult> {
  const started = performance.now();
  const io = join(config.volume.mountPath, '.agentic-io', randomBytes(8).toString('hex'));
  await mkdir(io, { recursive: true, mode: 0o700 });
  await writeFile(join(io, 'stdin'), run.input ?? '');
  const signal = currentAbortSignal();
  let secretName: string | undefined;
  let pod: Pod | undefined;
  try {
    if (Object.keys(run.secretEnv).length) {
      secretName = `agentic-env-${randomBytes(6).toString('hex')}`;
      await kube.ok('POST', kube.ns('secrets'), { apiVersion: 'v1', kind: 'Secret', metadata: { name: secretName, labels: { 'app.kubernetes.io/part-of': 'agentic-orchestrator' } }, type: 'Opaque', stringData: run.secretEnv });
    }
    pod = await kube.ok<Pod>('POST', kube.ns('pods'), podManifest(config, run, io, secretName));
    live.set(pod.metadata.name, kube);
    // If this process dies, the pod's deletion garbage-collects the secret.
    if (secretName) await kube.ok('PATCH', kube.ns(`secrets/${secretName}`), { metadata: { ownerReferences: [{ apiVersion: 'v1', kind: 'Pod', name: pod.metadata.name, uid: pod.metadata.uid }] } }, 'application/merge-patch+json');

    const deadline = Date.now() + run.timeoutMs;
    let released = false;
    for (;;) {
      if (signal?.aborted) throw new AbortedError();
      const current = await kube.ok<Pod>('GET', kube.ns(`pods/${pod.metadata.name}`));
      const state = current.status?.containerStatuses?.[0]?.state;
      if (state?.running && !released) {
        await new Promise(r => setTimeout(r, config.networkSettleMs));
        await writeFile(join(io, 'go'), '');
        released = true;
      }
      if (state?.terminated) {
        const read = async (n: string) => { const t = await readFile(join(io, n), 'utf8').catch(() => ''); return t.length > MAX_OUTPUT ? `[...truncated...]\n${t.slice(-MAX_OUTPUT)}` : t; };
        return { code: state.terminated.exitCode, stdout: await read('stdout'), stderr: await read('stderr'), timedOut: false, truncated: false, durationMs: Math.round(performance.now() - started) };
      }
      if (state?.waiting?.reason && FATAL_WAITING.has(state.waiting.reason)) throw new Error(`sandbox pod ${pod.metadata.name}: ${state.waiting.reason}: ${state.waiting.message ?? ''}`.slice(0, 600));
      if (current.status?.phase === 'Failed' && !state) throw new Error(`sandbox pod ${pod.metadata.name} failed before starting`);
      if (Date.now() > deadline) return { code: 124, stdout: '', stderr: `timed out after ${run.timeoutMs}ms`, timedOut: true, truncated: false, durationMs: Math.round(performance.now() - started) };
      await new Promise(r => setTimeout(r, 1_000));
    }
  } finally {
    if (pod) { live.delete(pod.metadata.name); await kube.call('DELETE', kube.ns(`pods/${pod.metadata.name}?gracePeriodSeconds=0`)).catch(() => {}); }
    if (secretName) await kube.call('DELETE', kube.ns(`secrets/${secretName}`)).catch(() => {});
    await rm(io, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------- runtime + check runner

const NO_PROXY = 'localhost,127.0.0.1,.svc,.cluster.local';
const proxyEnv = (proxy: string) => ({ HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY, no_proxy: NO_PROXY });

/** Agents as pods: gVisor (runtimeClassName), non-root, read-only root, subPath mounts per role, egress only via the proxy (NetworkPolicy). */
export class KubernetesAgentRuntime implements AgentRuntime {
  readonly kind = 'kubernetes';
  private kube?: KubeClient;
  constructor(private config: KubernetesConfig, private image: string, private resources: { memory: string; cpu: string }) {}
  private client() { return this.kube ??= KubeClient.fromEnv(this.config.namespace); }

  async prepare(): Promise<void> {
    // Fail before any spend: credentials work and pods may be created in the namespace.
    const kube = this.client();
    const review = await kube.ok<{ status?: { allowed?: boolean } }>('POST', '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews',
      { apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectAccessReview', spec: { resourceAttributes: { namespace: kube.namespace, verb: 'create', resource: 'pods' } } });
    if (!review.status?.allowed) throw new Error(`This service account may not create pods in namespace ${kube.namespace}`);
    await mkdir(this.config.volume.mountPath, { recursive: true });
  }

  exec(s: AgentExec): Promise<ProcessResult> {
    const forwarded = Object.fromEntries((s.passEnv ?? []).flatMap(k => process.env[k] !== undefined ? [[k, process.env[k]!]] : []));
    return runPod(this.client(), this.config, {
      kind: 'agent', image: this.image, command: [s.command, ...s.args], cwd: s.cwd, input: s.input, timeoutMs: s.timeoutMs, mounts: s.mounts ?? [],
      env: { HOME: '/home/agent', CI: '1', ...proxyEnv(this.config.proxy), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*', ...s.env },
      secretEnv: { ...forwarded, ...s.secretEnv }, ...this.resources,
    });
  }
}

/** Checks as pods: setup pods may reach the network through the proxy; check pods get none (NetworkPolicy). */
export class KubernetesCheckRunner implements CheckRunner {
  readonly kind = 'kubernetes';
  private kube?: KubeClient;
  constructor(private config: KubernetesConfig, private opts: { image: string; setup: string[][]; setupNetwork: 'none' | 'bridge'; memory: string; cpu: string }) {}
  async prepare(): Promise<void> { this.kube = KubeClient.fromEnv(this.config.namespace); }

  async runAll(worktree: string, checks: string[][], timeoutMs: number): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    for (const command of this.opts.setup) {
      const r = await this.run(command, 'setup', worktree, timeoutMs);
      results.push(r);
      if (r.code !== 0) return results;
    }
    for (const command of checks) results.push(await this.run(command, 'check', worktree, timeoutMs));
    return results;
  }

  private async run(command: string[], phase: CheckResult['phase'], worktree: string, timeoutMs: number): Promise<CheckResult> {
    const online = phase === 'setup' && this.opts.setupNetwork !== 'none';
    try {
      const r = await runPod(this.kube ?? KubeClient.fromEnv(this.config.namespace), this.config, {
        kind: online ? 'check-setup' : 'check', image: this.opts.image, command, cwd: worktree, timeoutMs, mounts: [{ path: worktree }],
        env: { HOME: '/tmp', CI: '1', ...(online ? proxyEnv(this.config.proxy) : {}) }, secretEnv: {}, memory: this.opts.memory, cpu: this.opts.cpu,
      });
      return { command, phase, code: r.code, timedOut: r.timedOut, durationMs: r.durationMs, stdout: r.stdout, stderr: r.stderr };
    } catch (error) {
      if (error instanceof AbortedError) throw error;
      throw new Error(`check sandbox failed: ${(error as Error).message}`);
    }
  }
}
