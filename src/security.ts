import { copyFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { SecurityConfig } from './config.js';
import { ensureImage, runContainer } from './container.js';
import { git, type FileChange } from './git.js';

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type ScannerName = 'gitleaks' | 'semgrep' | 'osv';
export interface SecurityFinding { scanner: ScannerName | 'policy'; severity: Severity; rule: string; file: string; line?: number; message: string; }
export interface SecurityReport { scanned: string[]; findings: SecurityFinding[]; blocking: SecurityFinding[]; durationMs: number; }

/** A scanner could not run (image, crash, unparseable output). Not the developer's fault: the task stops instead. */
export class ScannerError extends Error { constructor(message: string) { super(message); this.name = 'ScannerError'; } }

export interface SecurityScanner {
  readonly enabled: boolean;
  prepare(): Promise<void>;
  /** Scans the files changed since `baseSha`; `workDir` receives the scan copy and raw reports. */
  scan(worktree: string, baseSha: string, changes: FileChange[], workDir: string): Promise<SecurityReport>;
}

const RANK: Record<Severity, number> = { critical: 3, high: 2, medium: 1, low: 0 };
export const atLeast = (s: Severity, threshold: Severity) => RANK[s] >= RANK[threshold];

/** Files that configure or silence a scanner; a task must not add or change them. */
const SCANNER_CONFIG = /(^|\/)(\.gitleaks\.toml|\.gitleaksignore|\.semgrepignore|\.semgrep\.ya?ml|\.semgrep\/.+|osv-scanner\.toml)$/;
/** Dependency manifests and lockfiles OSV-Scanner understands. */
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'requirements.txt', 'poetry.lock', 'Pipfile.lock', 'pdm.lock', 'uv.lock',
  'go.mod', 'Cargo.lock', 'Gemfile.lock', 'composer.lock', 'pom.xml', 'gradle.lockfile', 'buildscript-gradle.lockfile', 'mix.lock', 'pubspec.lock', 'packages.lock.json', 'renv.lock']);
const MAX_FILE_BYTES = 5_000_000;

// ---------------------------------------------------------------- report parsers (pure; unit-tested)

export function parseGitleaks(json: string): SecurityFinding[] {
  const rows = JSON.parse(json || '[]') as { RuleID: string; File: string; StartLine?: number; Description?: string }[];
  return rows.map(r => ({ scanner: 'gitleaks', severity: 'critical', rule: r.RuleID, file: r.File, line: r.StartLine, message: `possible secret: ${r.Description ?? r.RuleID}` }));
}

export function parseSemgrep(json: string): SecurityFinding[] {
  const data = JSON.parse(json) as { results?: { check_id: string; path: string; start?: { line?: number }; extra?: { severity?: string; message?: string } }[]; errors?: { level?: string; message?: string }[] };
  const severity = (s?: string): Severity => s === 'ERROR' ? 'high' : s === 'WARNING' ? 'medium' : 'low';
  return (data.results ?? []).map(r => ({ scanner: 'semgrep', severity: severity(r.extra?.severity), rule: r.check_id, file: r.path, line: r.start?.line, message: (r.extra?.message ?? '').trim().slice(0, 500) }));
}

/** Vulnerability IDs with severity per OSV result; CVSS score from the group's max_severity (unknown counts as high). */
export function parseOsv(json: string): { id: string; severity: Severity; pkg: string; summary: string }[] {
  if (!json.trim()) return [];
  const data = JSON.parse(json) as { results?: { packages?: { package: { name: string; version?: string }; vulnerabilities?: { id: string; summary?: string }[]; groups?: { ids: string[]; max_severity?: string }[] }[] }[] };
  const out: { id: string; severity: Severity; pkg: string; summary: string }[] = [];
  for (const result of data.results ?? []) {
    for (const p of result.packages ?? []) {
      for (const v of p.vulnerabilities ?? []) {
        const score = Number(p.groups?.find(g => g.ids.includes(v.id))?.max_severity);
        const severity: Severity = !Number.isFinite(score) || score === 0 ? 'high' : score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : 'low';
        out.push({ id: v.id, severity, pkg: `${p.package.name}@${p.package.version ?? '?'}`, summary: (v.summary ?? '').slice(0, 200) });
      }
    }
  }
  return out;
}

export function formatFindings(findings: SecurityFinding[]): string {
  return findings.map(f => `- [${f.scanner} ${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} ${f.rule}: ${f.message}`).join('\n');
}

// ---------------------------------------------------------------- scanning

/**
 * Copies changed regular files (no symlinks, no scanner config) into `dir`, so scanners judge this task's work
 * rather than pre-existing debt, and links cannot pull in files from outside the worktree.
 */
export async function stageChanges(worktree: string, changes: FileChange[], dir: string): Promise<{ staged: string[]; tampered: string[] }> {
  const staged: string[] = [];
  const tampered: string[] = [];
  for (const c of changes) {
    if (c.x === 'D' || c.y === 'D') continue;
    if (SCANNER_CONFIG.test(c.path)) { tampered.push(c.path); continue; }
    const src = join(worktree, c.path);
    const info = await lstat(src).catch(() => undefined);
    if (!info?.isFile() || info.size > MAX_FILE_BYTES) continue;
    await mkdir(dirname(join(dir, c.path)), { recursive: true });
    await copyFile(src, join(dir, c.path));
    staged.push(c.path);
  }
  return { staged, tampered };
}

export class ContainerSecurityScanner implements SecurityScanner {
  readonly enabled: boolean;
  constructor(private config: SecurityConfig) { this.enabled = config.scanners.length > 0; }

  async prepare(): Promise<void> {
    for (const s of this.config.scanners) await ensureImage(this.config.engine, this.config.images[s]);
  }

  async scan(worktree: string, baseSha: string, changes: FileChange[], workDir: string): Promise<SecurityReport> {
    const started = performance.now();
    await rm(workDir, { recursive: true, force: true });
    const changed = join(workDir, 'changed');
    const out = join(workDir, 'out');
    await mkdir(changed, { recursive: true });
    await mkdir(out, { recursive: true });
    const { staged, tampered } = await stageChanges(worktree, changes, changed);
    const findings: SecurityFinding[] = tampered.map(path => ({
      scanner: 'policy', severity: 'high', rule: 'scanner-config-changed', file: path,
      message: 'tasks may not add or change scanner configuration or ignore files; revert this file and fix the findings instead',
    }));
    if (staged.length) {
      for (const s of this.config.scanners) {
        if (s === 'gitleaks') findings.push(...await this.gitleaks(changed, out));
        if (s === 'semgrep') findings.push(...await this.semgrep(changed, out));
        if (s === 'osv') findings.push(...await this.osv(worktree, baseSha, staged, workDir));
      }
    }
    const blocking = findings.filter(f => atLeast(f.severity, this.config.failOn));
    return { scanned: staged, findings, blocking, durationMs: Math.round(performance.now() - started) };
  }

  private async run(scanner: ScannerName, command: string[], mounts: { path: string; readOnly?: boolean }[], network: string, okCodes: number[]): Promise<string> {
    const { engine, images, timeoutMs } = this.config;
    const r = await runContainer({
      engine, image: images[scanner], command, workdir: '/tmp', network, mounts, memory: '2g', cpus: '2', pidsLimit: 512,
      readOnlyRoot: true, tmpfs: ['/tmp:rw,size=512m'], env: { HOME: '/tmp', SEMGREP_SEND_METRICS: 'off' }, namePrefix: `agentic-${scanner}`,
    }, { timeoutMs, maxOutputChars: 20_000_000 });
    if (r.timedOut) throw new ScannerError(`${scanner} timed out after ${timeoutMs}ms`);
    if (!okCodes.includes(r.code)) throw new ScannerError(`${scanner} exited ${r.code}: ${(r.stderr || r.stdout).slice(-1500)}`);
    return r.stdout;
  }

  private async gitleaks(changed: string, out: string): Promise<SecurityFinding[]> {
    const report = join(out, 'gitleaks.json');
    // --ignore-gitleaks-allow: inline "gitleaks:allow" comments written by the agent do not count.
    await this.run('gitleaks', ['dir', changed, '--report-format', 'json', '--report-path', report, '--redact', '--no-banner', '--ignore-gitleaks-allow', '--exit-code', '0'],
      [{ path: changed, readOnly: true }, { path: out }], 'none', [0]);
    try { return relativize(parseGitleaks(await readFile(report, 'utf8')), changed); } catch (error) { throw new ScannerError(`gitleaks report unreadable: ${String(error)}`); }
  }

  private async semgrep(changed: string, out: string): Promise<SecurityFinding[]> {
    const configs = this.config.semgrepConfig;
    const local = configs.filter(c => isAbsolute(c));
    // Registry rule packs (p/...) are downloaded; local rule files need no network.
    const network = configs.every(c => isAbsolute(c)) ? 'none' : 'bridge';
    const stdout = await this.run('semgrep', ['semgrep', 'scan', ...configs.flatMap(c => ['--config', c]), '--json', '--metrics=off', '--disable-nosem', '--quiet', '--no-git-ignore', changed],
      [{ path: changed, readOnly: true }, { path: out }, ...local.map(path => ({ path, readOnly: true }))], network, [0, 1]);
    await writeFile(join(out, 'semgrep.json'), stdout);
    try { return relativize(parseSemgrep(stdout), changed); } catch (error) { throw new ScannerError(`semgrep output unreadable: ${String(error)}`); }
  }

  /** Only vulnerabilities this task introduces: each changed lockfile is compared with its version at the base commit. */
  private async osv(worktree: string, baseSha: string, staged: string[], workDir: string): Promise<SecurityFinding[]> {
    const findings: SecurityFinding[] = [];
    for (const path of staged.filter(p => LOCKFILES.has(basename(p)))) {
      const now = await this.osvIds(join(workDir, 'changed', path));
      const base = await git(['show', `${baseSha}:${path}`], worktree, { maxOutputChars: MAX_FILE_BYTES }).catch(() => undefined); // new in this task
      let before = new Set<string>();
      if (base) {
        const basePath = join(workDir, 'base', path);
        await mkdir(dirname(basePath), { recursive: true });
        await writeFile(basePath, base.stdout);
        before = new Set((await this.osvIds(basePath)).map(v => v.id));
      }
      for (const v of now) if (!before.has(v.id)) findings.push({ scanner: 'osv', severity: v.severity, rule: v.id, file: path, message: `${v.pkg}: ${v.summary || 'known vulnerability'}` });
    }
    return findings;
  }

  private async osvIds(lockfile: string) {
    // Exit 1 = vulnerabilities found, 128 = no packages found; anything else is a failure.
    const stdout = await this.run('osv', ['scan', 'source', '--format', 'json', '--lockfile', lockfile], [{ path: dirname(lockfile), readOnly: true }], 'bridge', [0, 1, 128]);
    try { return parseOsv(stdout); } catch (error) { throw new ScannerError(`osv-scanner output unreadable: ${String(error)}`); }
  }
}

const relativize = (findings: SecurityFinding[], root: string) => findings.map(f => ({ ...f, file: f.file.startsWith(`${root}/`) ? f.file.slice(root.length + 1) : f.file }));

export const NO_SCANNER: SecurityScanner = { enabled: false, prepare: async () => {}, scan: async () => ({ scanned: [], findings: [], blocking: [], durationMs: 0 }) };

export function createSecurityScanner(config: SecurityConfig): SecurityScanner {
  return config.scanners.length ? new ContainerSecurityScanner(config) : NO_SCANNER;
}
