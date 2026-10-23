import { access, chmod, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CredentialsConfig } from './config.js';
import type { Mount } from './container.js';

export interface AgentCredentials { env: Record<string, string>; secretEnv: Record<string, string>; passEnv: string[]; mounts: Mount[]; }
export interface RunCredentials {
  readonly mode: CredentialsConfig['mode'];
  claude: AgentCredentials;
  codex: AgentCredentials;
  budgetUsd?: number;
  /** Authoritative spend for this run, when the gateway can report it. */
  spendUsd(): Promise<number | undefined>;
  dispose(): Promise<void>;
}
export interface CredentialOptions {
  runtime: 'host' | 'container' | 'kubernetes';
  runId: string;
  needClaude: boolean;
  needCodex: boolean;
  /** OTLP/HTTP base endpoint for Codex telemetry (written to its config.toml), if enabled. */
  codexOtelEndpoint?: string;
  fetch?: typeof fetch;
}

/** Host env forwarded to host-run CLIs so their normal auth keeps working. */
export const CLAUDE_HOST_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_REGION', 'AWS_PROFILE', 'CLOUD_ML_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID'];
export const CODEX_HOST_ENV = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME'];

const none = (): AgentCredentials => ({ env: {}, secretEnv: {}, passEnv: [], mounts: [] });
const toml = (s: string) => JSON.stringify(s);

function codexOtelToml(endpoint?: string): string {
  if (!endpoint) return '';
  const e = endpoint.replace(/\/$/, '');
  const exporter = (path: string) => `{ otlp-http = { endpoint = ${toml(`${e}${path}`)}, protocol = "binary" } }`;
  return `\n[otel]\nenvironment = "agentic"\nlog_user_prompt = false\nexporter = ${exporter('/v1/logs')}\ntrace_exporter = ${exporter('/v1/traces')}\nmetrics_exporter = ${exporter('/v1/metrics')}\n`;
}

/** A throwaway CODEX_HOME so runs never touch (or depend on edits to) the user's ~/.codex. */
async function codexHome(configToml: string, auth?: { copyFrom?: string; apiKey?: string }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentic-codex-'));
  await writeFile(join(dir, 'config.toml'), configToml);
  if (auth?.copyFrom) await copyFile(auth.copyFrom, join(dir, 'auth.json'));
  else if (auth?.apiKey) await writeFile(join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: auth.apiKey }));
  if (auth) await chmod(join(dir, 'auth.json'), 0o600);
  return dir;
}
const exists = (p: string) => access(p).then(() => true, () => false);

export async function createCredentials(config: CredentialsConfig, opts: CredentialOptions): Promise<RunCredentials> {
  return config.mode === 'gateway' ? await gatewayCredentials(config, opts) : await subscriptionCredentials(opts);
}

async function subscriptionCredentials(opts: CredentialOptions): Promise<RunCredentials> {
  const cleanup: string[] = [];
  const creds: RunCredentials = {
    mode: 'subscription', claude: none(), codex: none(),
    spendUsd: async () => undefined,
    dispose: async () => { await Promise.all(cleanup.map(d => rm(d, { recursive: true, force: true }))); },
  };
  if (opts.runtime === 'host') {
    // Host CLIs use their normal login (keychain, ~/.codex) unchanged.
    creds.claude.passEnv = CLAUDE_HOST_ENV;
    creds.codex.passEnv = CODEX_HOST_ENV;
    return creds;
  }
  if (opts.needClaude) {
    const key = process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'CLAUDE_CODE_OAUTH_TOKEN' : process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : undefined;
    if (!key) throw new Error('Containerized Claude needs CLAUDE_CODE_OAUTH_TOKEN (create one with `claude setup-token`) or ANTHROPIC_API_KEY in the environment.');
    creds.claude.secretEnv[key] = process.env[key]!;
  }
  if (opts.needCodex) {
    const authFile = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
    const auth = await exists(authFile) ? { copyFrom: authFile } : process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : undefined;
    if (!auth) throw new Error(`Containerized Codex needs ${authFile} (run \`codex login\`) or OPENAI_API_KEY in the environment.`);
    const home = await codexHome(codexOtelToml(opts.codexOtelEndpoint), auth);
    cleanup.push(home);
    creds.codex.env.CODEX_HOME = home;
    creds.codex.mounts.push({ path: home });
  }
  return creds;
}

type GatewayConfig = Extract<CredentialsConfig, { mode: 'gateway' }>;

async function gatewayCredentials(config: GatewayConfig, opts: CredentialOptions): Promise<RunCredentials> {
  const doFetch = opts.fetch ?? fetch;
  const masterKey = process.env[config.masterKeyEnv];
  if (!masterKey) throw new Error(`Gateway mode needs the LiteLLM master key in $${config.masterKeyEnv}.`);
  const api = async (path: string, init: RequestInit = {}) => {
    const res = await doFetch(`${config.url.replace(/\/$/, '')}${path}`, {
      ...init, headers: { authorization: `Bearer ${masterKey}`, 'content-type': 'application/json', ...init.headers },
    });
    if (!res.ok) throw new Error(`LiteLLM ${path} failed: ${res.status} ${(await res.text()).slice(0, 500)}`);
    return await res.json() as Record<string, unknown>;
  };
  const generated = await api('/key/generate', {
    method: 'POST',
    body: JSON.stringify({ max_budget: config.budgetUsd, duration: config.keyTtl, key_alias: `agentic-${opts.runId}`, metadata: { agentic_run_id: opts.runId } }),
  });
  const key = String(generated.key ?? '');
  if (!key) throw new Error('LiteLLM /key/generate returned no key');

  const agentUrl = (opts.runtime === 'host' ? config.url : config.internalUrl).replace(/\/$/, '');
  const cleanup: string[] = [];
  const creds: RunCredentials = {
    mode: 'gateway', claude: none(), codex: none(), budgetUsd: config.budgetUsd,
    spendUsd: async () => {
      const info = await api(`/key/info?key=${encodeURIComponent(key)}`);
      const spend = (info.info as { spend?: unknown } | undefined)?.spend;
      return typeof spend === 'number' ? spend : undefined;
    },
    dispose: async () => {
      await Promise.all(cleanup.map(d => rm(d, { recursive: true, force: true })));
      await api('/key/delete', { method: 'POST', body: JSON.stringify({ keys: [key] }) }).catch(() => {});
    },
  };
  creds.claude.env.ANTHROPIC_BASE_URL = agentUrl;
  creds.claude.secretEnv.ANTHROPIC_AUTH_TOKEN = key;
  if (opts.needCodex) {
    const providerToml = `model_provider = "agentic-gateway"\n\n[model_providers.agentic-gateway]\nname = "agentic gateway"\nbase_url = ${toml(`${agentUrl}/v1`)}\nenv_key = "AGENTIC_GATEWAY_KEY"\nwire_api = "responses"\n`;
    const home = await codexHome(providerToml + codexOtelToml(opts.codexOtelEndpoint));
    cleanup.push(home);
    creds.codex.env.CODEX_HOME = home;
    creds.codex.secretEnv.AGENTIC_GATEWAY_KEY = key;
    creds.codex.mounts.push({ path: home });
  }
  return creds;
}
