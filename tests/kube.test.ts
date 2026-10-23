import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import { KubeClient, podManifest, type PodRun } from '../src/kube.js';

const k8s = parseConfig({ kubernetes: { runtimeClassName: 'gvisor', volume: { claimName: 'agentic-data', mountPath: '/data' }, imagePullSecrets: ['regcred'] } }).kubernetes;
const run: PodRun = {
  kind: 'agent', image: 'registry.example/agentic-agent:1', command: ['codex', 'exec', '--json', '-'], cwd: '/data/runs/p/worktree', timeoutMs: 60_000,
  mounts: [{ path: '/data/runs/p/worktree', readOnly: true }, { path: '/data/repos/app/.git', readOnly: true }, { path: '/data/runs/p/worktree/io' }],
  env: { HOME: '/home/agent' }, secretEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'secret-value' }, memory: '4Gi', cpu: '2',
};

test('pod manifest: sandboxed, non-root, role-based subPath mounts, secrets by reference', () => {
  const pod = podManifest(k8s, run, '/data/.agentic-io/abc', 'agentic-env-1', { uid: 1000, gid: 1000 });
  const spec = pod.spec;
  const c = spec.containers[0];
  assert.equal(spec.runtimeClassName, 'gvisor');
  assert.equal(spec.automountServiceAccountToken, false);
  assert.equal(spec.restartPolicy, 'Never');
  assert.deepEqual(spec.imagePullSecrets, [{ name: 'regcred' }]);
  assert.deepEqual(spec.securityContext, { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } });
  assert.deepEqual(c.securityContext, { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } });
  assert.equal(pod.metadata.labels['agentic.dev/sandbox'], 'agent', 'NetworkPolicies select on this label');
  assert.deepEqual(c.command.slice(3), ['codex', 'exec', '--json', '-'], 'argv passed as positional parameters, never interpolated into the shell');
  assert.match(c.command[2], /^while \[ ! -e "\$AGENTIC_IO\/go" \]/, 'nothing runs before the worker releases it (network policy settle)');
  const mounts = (c.volumeMounts.filter(m => m.name === 'data') as { mountPath: string; subPath: string; readOnly: boolean }[]).map(m => [m.mountPath, m.subPath, m.readOnly]);
  assert.deepEqual(mounts, [
    ['/data/repos/app/.git', 'repos/app/.git', true],
    ['/data/runs/p/worktree', 'runs/p/worktree', true],
    ['/data/.agentic-io/abc', '.agentic-io/abc', false],
    ['/data/runs/p/worktree/io', 'runs/p/worktree/io', false],
  ], 'shallower first, so nested writable dirs override read-only parents');
  assert.deepEqual(c.env.find(e => e.name === 'CLAUDE_CODE_OAUTH_TOKEN'), { name: 'CLAUDE_CODE_OAUTH_TOKEN', valueFrom: { secretKeyRef: { name: 'agentic-env-1', key: 'CLAUDE_CODE_OAUTH_TOKEN' } } });
  assert.doesNotMatch(JSON.stringify(pod), /secret-value/, 'secret values never appear in the pod spec');
  assert.equal(spec.activeDeadlineSeconds, 120);
});

test('paths off the shared volume are refused', () => {
  assert.throws(() => podManifest(k8s, { ...run, mounts: [{ path: '/etc' }] }, '/data/.agentic-io/x', undefined), /not on the shared volume \/data/);
  assert.throws(() => podManifest(k8s, { ...run, mounts: [{ path: '/data-other/x' }] }, '/data/.agentic-io/x', undefined), /not on the shared volume/);
});

test('client configuration: explicit server, or in-cluster only inside a pod', () => {
  const c = KubeClient.fromEnv(undefined, { AGENTIC_K8S_SERVER: 'https://k8s.example:6443', AGENTIC_K8S_TOKEN: 't', AGENTIC_K8S_NAMESPACE: 'agentic' });
  assert.equal(c.ns('pods'), '/api/v1/namespaces/agentic/pods');
  assert.throws(() => KubeClient.fromEnv(undefined, { AGENTIC_K8S_SERVER: 'https://x' }), /without AGENTIC_K8S_TOKEN/);
  assert.throws(() => KubeClient.fromEnv(undefined, {}), /Not running in a Kubernetes pod/);
});

test('kubernetes runtime and check runner configs parse', () => {
  const c = parseConfig({ agentRuntime: { type: 'kubernetes', image: 'r/agent:1' }, checkRunner: { type: 'kubernetes', image: 'node:22', setup: [['npm', 'ci']] } });
  assert.deepEqual([c.agentRuntime.type, c.checkRunner.type, c.kubernetes.volume.mountPath], ['kubernetes', 'kubernetes', '/data']);
  assert.throws(() => parseConfig({ agentRuntime: { type: 'kubernetes' } }), /image/);
});
