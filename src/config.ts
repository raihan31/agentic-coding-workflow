import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const argv = z.array(z.string().min(1)).min(1);
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const ContainerRunnerSchema = z.object({
  type: z.literal('container'),
  engine: z.enum(['docker', 'podman']).default('docker'),
  image: z.string().min(1),
  /** Runs before the checks of every attempt, e.g. ["npm","ci","--ignore-scripts"]. */
  setup: z.array(argv).default([]),
  /** Network for setup commands (dependency install). Checks always run with --network none. */
  setupNetwork: z.enum(['none', 'bridge']).default('bridge'),
  memory: z.string().default('2g'),
  cpus: z.string().default('2'),
  pidsLimit: z.number().int().positive().default(512),
}).strict();

export const HostRunnerSchema = z.object({
  type: z.literal('host'),
  /** Host checks execute agent-modified code with your user's privileges. Must be acknowledged. */
  acknowledgeUnsafe: z.literal(true),
}).strict();

/** Pod sandboxes (agentRuntime/checkRunner type "kubernetes") share one volume with the worker, mounted at the same path everywhere. */
export const KubernetesSchema = z.object({
  /** Defaults to the worker pod's namespace. */
  namespace: z.string().min(1).optional(),
  volume: z.object({ claimName: z.string().min(1).default('agentic-data'), mountPath: z.string().startsWith('/').default('/data') }).strict().prefault({}),
  /** "gvisor" on GKE Sandbox, or your cluster's gVisor/Kata RuntimeClass. Unset = the cluster default runtime. */
  runtimeClassName: z.string().min(1).optional(),
  /** Egress proxy Service (the chart deploys one); agent pods have no other way out. */
  proxy: z.string().url().default('http://agentic-egress:3128'),
  /** Service account for sandbox pods (its token is never mounted). */
  serviceAccountName: z.string().min(1).optional(),
  imagePullSecrets: z.array(z.string().min(1)).default([]),
  nodeSelector: z.record(z.string(), z.string()).default({}),
  /**
   * Delay between a sandbox container starting and its command running. Many CNIs apply NetworkPolicy to a new pod
   * a few seconds after it starts; without this, agent code could briefly reach the network. 0 only with a CNI that
   * enforces policy before the container starts.
   */
  networkSettleMs: z.number().int().min(0).max(60_000).default(5_000),
}).strict();

export const KubernetesRunnerSchema = z.object({
  type: z.literal('kubernetes'),
  image: z.string().min(1),
  setup: z.array(argv).default([]),
  /** "bridge" = setup pods reach the network through the egress proxy; check pods never do. */
  setupNetwork: z.enum(['none', 'bridge']).default('bridge'),
  memory: z.string().default('2Gi'),
  cpu: z.string().default('2'),
}).strict();

export const CheckRunnerSchema = z.discriminatedUnion('type', [ContainerRunnerSchema, HostRunnerSchema, KubernetesRunnerSchema]);

export const AgentRuntimeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('container'),
    engine: z.enum(['docker', 'podman']).default('docker'),
    /** Built by `npm run sandbox:build`. */
    image: z.string().min(1).default('agentic-agent:local'),
    /** Internal network created by `npm run stack:up`; its only way out is the egress proxy. */
    network: z.string().min(1).default('agentic-sandbox'),
    proxy: z.string().url().default('http://agentic-egress:3128'),
    memory: z.string().default('4g'),
    cpus: z.string().default('2'),
    pidsLimit: z.number().int().positive().default(1024),
  }).strict(),
  z.object({
    type: z.literal('host'),
    /** Agents run on the host, protected only by their own CLI sandboxes. */
    acknowledgeUnsafe: z.literal(true),
  }).strict(),
  z.object({
    type: z.literal('kubernetes'),
    /** The agent image (deploy/agent.Dockerfile) in a registry the cluster can pull from. */
    image: z.string().min(1),
    memory: z.string().default('4Gi'),
    cpu: z.string().default('2'),
  }).strict(),
]);

export const CredentialsSchema = z.discriminatedUnion('mode', [
  /** Your CLI logins: CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) and a per-run copy of ~/.codex/auth.json. */
  z.object({ mode: z.literal('subscription') }).strict(),
  /** LiteLLM gateway: each run gets a short-lived virtual key with a hard budget; provider keys stay in the gateway. */
  z.object({
    mode: z.literal('gateway'),
    /** Gateway URL as seen from the orchestrator (key management, host-runtime agents). */
    url: z.string().url().default('http://localhost:4000'),
    /** Gateway URL as seen from containerized agents. */
    internalUrl: z.string().url().default('http://agentic-litellm:4000'),
    masterKeyEnv: envName.default('LITELLM_MASTER_KEY'),
    budgetUsd: z.number().positive().default(10),
    keyTtl: z.string().default('24h'),
  }).strict(),
]);

/** Security scanners: a deterministic gate after the checks, judging only the files a task changed. */
export const SecuritySchema = z.object({
  /** gitleaks (secrets, offline), semgrep (SAST; registry packs need network), osv (new vulnerable dependencies; queries osv.dev). */
  scanners: z.array(z.enum(['gitleaks', 'semgrep', 'osv'])).default([]),
  engine: z.enum(['docker', 'podman']).default('docker'),
  /** Findings at or above this severity reject the attempt (secrets are critical; semgrep ERROR is high). */
  failOn: z.enum(['critical', 'high', 'medium', 'low']).default('high'),
  /** Semgrep rule sources: registry packs or absolute paths to local rule files (mounted read-only). */
  semgrepConfig: z.array(z.string().min(1)).min(1).default(['p/default']),
  images: z.object({
    gitleaks: z.string().min(1).default('zricethezav/gitleaks:v8.30.1'),
    semgrep: z.string().min(1).default('semgrep/semgrep:1.178.0'),
    osv: z.string().min(1).default('ghcr.io/google/osv-scanner:v2.6.0'),
  }).strict().prefault({}),
  timeoutMs: z.number().int().positive().default(600_000),
}).strict();

export const ConfigSchema = z.object({
  maxRepairs: z.number().int().min(0).max(5).default(2),
  checks: z.array(argv).default([]),
  checkRunner: CheckRunnerSchema.prefault({ type: 'container', image: 'node:22-bookworm-slim' }),
  agentRuntime: AgentRuntimeSchema.prefault({ type: 'container' }),
  credentials: CredentialsSchema.prefault({ mode: 'subscription' }),
  security: SecuritySchema.prefault({}),
  kubernetes: KubernetesSchema.prefault({}),
  /** Pushing the project branch and opening a pull request are outward-facing, so both are opt-in. */
  delivery: z.object({
    push: z.boolean().default(false),
    remote: z.string().min(1).default('origin'),
    pullRequest: z.object({
      enabled: z.boolean().default(false),
      draft: z.boolean().default(true),
      /** Base branch; defaults to the repository's default branch. */
      base: z.string().min(1).optional(),
      /** "owner/name"; defaults to parsing the remote URL. */
      repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
      apiUrl: z.string().url().default('https://api.github.com'),
      tokenEnv: envName.default('GITHUB_TOKEN'),
    }).strict().prefault({}),
  }).strict().prefault({}),
  telemetry: z.object({
    /** Also export agent CLI telemetry (Claude Code metrics/logs, Codex otel) when OTEL_EXPORTER_OTLP_ENDPOINT is set. */
    agents: z.boolean().default(true),
    /** OTLP/HTTP endpoint reachable from agents; defaults to the compose collector (container) or the orchestrator's endpoint (host). */
    agentEndpoint: z.string().url().optional(),
  }).strict().prefault({}),
  /** Globs (repo-relative) of existing files the developer must not modify, delete or rename. New files are allowed. */
  protectedPaths: z.array(z.string().min(1)).default([]),
  models: z.object({ analyst: z.string().optional(), planner: z.string().optional(), developer: z.string().optional(), reviewer: z.string().optional(), manager: z.string().optional() }).strict().default({}),
  /** When a task exhausts its repairs, a manager agent decides: retry with guidance, split it, escalate to a human, or skip it. */
  manager: z.object({
    enabled: z.boolean().default(true),
    /** Manager decisions per task per run; once used up the task fails as before. */
    maxInterventions: z.number().int().min(1).max(5).default(2),
    allowSplit: z.boolean().default(true),
    /** Ask a human (UI / API) instead of guessing; under the local driver the task fails with the question recorded. */
    allowEscalate: z.boolean().default(true),
    budgetUsd: z.number().positive().optional(),
  }).strict().prefault({}),
  /** Hard USD cap for each Claude planner call (passed as --max-budget-usd). */
  plannerBudgetUsd: z.number().positive().optional(),
  /** Hard USD cap for the Claude analyst call that turns a document into a backlog. */
  analystBudgetUsd: z.number().positive().optional(),
  project: z.object({
    /** Upper bound on backlog size; larger documents should be split. */
    maxTasks: z.number().int().min(1).max(200).default(40),
    /** Identity for the per-task commits on the project branch. */
    gitAuthor: z.object({ name: z.string().min(1), email: z.string().min(3) }).strict().default({ name: 'Agentic Orchestrator', email: 'agentic@localhost' }),
    branchPrefix: z.string().regex(/^[A-Za-z0-9._/-]+$/).default('agentic/'),
  }).strict().prefault({}),
  timeouts: z.object({
    analyzeMs: z.number().int().positive().default(1_800_000),
    planMs: z.number().int().positive().default(900_000),
    developerMs: z.number().int().positive().default(1_800_000),
    reviewerMs: z.number().int().positive().default(1_800_000),
    managerMs: z.number().int().positive().default(600_000),
    checkMs: z.number().int().positive().default(600_000),
  }).strict().prefault({}),
  /** Additional host env vars forwarded to agent CLIs (never to checks). */
  agentEnv: z.array(envName).default([]),
}).strict();

export type Config = z.infer<typeof ConfigSchema>;
export type CheckRunnerConfig = z.infer<typeof CheckRunnerSchema>;
export type AgentRuntimeConfig = z.infer<typeof AgentRuntimeSchema>;
export type CredentialsConfig = z.infer<typeof CredentialsSchema>;
export type SecurityConfig = z.infer<typeof SecuritySchema>;
export type KubernetesConfig = z.infer<typeof KubernetesSchema>;

export function parseConfig(data: unknown): Config {
  const result = ConfigSchema.safeParse(data);
  if (!result.success) throw new Error(`Invalid workflow config:\n${z.prettifyError(result.error)}`);
  return result.data;
}

export async function loadConfig(path?: string): Promise<Config> {
  return parseConfig(path ? JSON.parse(await readFile(path, 'utf8')) : {});
}

export const FindingSchema = z.object({
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  file: z.string(),
  explanation: z.string(),
  recommendation: z.string(),
});
export const ReviewSchema = z.object({
  decision: z.enum(['pass', 'changes_required']),
  summary: z.string(),
  findings: z.array(FindingSchema),
});
export type Finding = z.infer<typeof FindingSchema>;
export type Review = z.infer<typeof ReviewSchema>;

/** JSON Schema handed to `codex exec --output-schema`; schemas/review.schema.json is generated from this. */
export function reviewJsonSchema(): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(ReviewSchema) as Record<string, unknown>;
  return schema;
}
