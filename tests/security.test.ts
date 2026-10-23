import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.js';
import { execute } from '../src/process.js';
import { atLeast, ContainerSecurityScanner, parseGitleaks, parseOsv, parseSemgrep, stageChanges } from '../src/security.js';

test('parses gitleaks, semgrep and osv reports into ranked findings', () => {
  assert.deepEqual(parseGitleaks(JSON.stringify([{ RuleID: 'github-pat', File: '/s/a.ts', StartLine: 3, Description: 'GitHub token' }])),
    [{ scanner: 'gitleaks', severity: 'critical', rule: 'github-pat', file: '/s/a.ts', line: 3, message: 'possible secret: GitHub token' }]);
  assert.deepEqual(parseGitleaks(''), []);
  const semgrep = parseSemgrep(JSON.stringify({ results: [
    { check_id: 'js.eval', path: 'a.js', start: { line: 2 }, extra: { severity: 'ERROR', message: ' eval is dangerous ' } },
    { check_id: 'js.style', path: 'b.js', start: { line: 1 }, extra: { severity: 'WARNING', message: 'meh' } },
  ] }));
  assert.deepEqual(semgrep.map(f => [f.rule, f.severity, f.message]), [['js.eval', 'high', 'eval is dangerous'], ['js.style', 'medium', 'meh']]);
  const osv = parseOsv(JSON.stringify({ results: [{ packages: [{ package: { name: 'lodash', version: '4.17.15' },
    vulnerabilities: [{ id: 'GHSA-1', summary: 'proto pollution' }, { id: 'GHSA-2' }], groups: [{ ids: ['GHSA-1'], max_severity: '9.8' }] }] }] }));
  assert.deepEqual(osv.map(v => [v.id, v.severity, v.pkg]), [['GHSA-1', 'critical', 'lodash@4.17.15'], ['GHSA-2', 'high', 'lodash@4.17.15']], 'unknown severity counts as high');
  assert.ok(atLeast('critical', 'high') && atLeast('high', 'high') && !atLeast('medium', 'high'));
});

test('only changed regular files are staged; scanner config changes are flagged, symlinks are not followed', async () => {
  const wt = await mkdtemp(join(tmpdir(), 'agentic-sec-wt-'));
  const out = await mkdtemp(join(tmpdir(), 'agentic-sec-out-'));
  await mkdir(join(wt, 'src'));
  await writeFile(join(wt, 'src/a.ts'), 'x');
  await writeFile(join(wt, '.gitleaks.toml'), '[allowlist]\npaths = [".*"]');
  await symlink('/etc/hosts', join(wt, 'link'));
  const { staged, tampered } = await stageChanges(wt, [
    { x: '?', y: '?', path: 'src/a.ts' }, { x: '?', y: '?', path: '.gitleaks.toml' }, { x: '?', y: '?', path: 'link' }, { x: ' ', y: 'D', path: 'gone.ts' },
  ], out);
  assert.deepEqual(staged, ['src/a.ts']);
  assert.deepEqual(tampered, ['.gitleaks.toml']);
  assert.equal(await readFile(join(out, 'src/a.ts'), 'utf8'), 'x');
});

// ---- real scanners in containers (skipped without docker or the pinned images) ----

const config = parseConfig({}).security;
const haveImage = async (image: string) => { try { return (await execute('docker', ['image', 'inspect', image], process.cwd())).code === 0; } catch { return false; } };
const skipGitleaks = await haveImage(config.images.gitleaks) ? false : `needs docker and ${config.images.gitleaks}`;
const skipSemgrep = await haveImage(config.images.semgrep) ? false : `needs docker and ${config.images.semgrep}`;

async function repoWith(files: Record<string, string>) {
  const repo = await mkdtemp(join(tmpdir(), 'agentic-sec-repo-'));
  await execute('git', ['init', '-q', '-b', 'main'], repo);
  await execute('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], repo);
  for (const [path, content] of Object.entries(files)) { await mkdir(join(repo, path, '..'), { recursive: true }); await writeFile(join(repo, path), content); }
  const base = (await execute('git', ['rev-parse', 'HEAD'], repo)).stdout.trim();
  return { repo, base, changes: Object.keys(files).map(path => ({ x: '?', y: '?', path })) };
}
// Assembled at runtime so this file itself does not look like a leaked token.
const fakeToken = ['ghp', '_', 'R7nKq2LmV9xT4bWc8YzP3sJd6FhA1eUo0iNg'].join('');

test('gitleaks blocks a committed secret, even with an inline allow comment and a planted config', { skip: skipGitleaks, timeout: 120_000 }, async () => {
  const { repo, base, changes } = await repoWith({
    'src/client.ts': `export const token = "${fakeToken}"; // gitleaks:allow\n`,
    '.gitleaks.toml': '[allowlist]\npaths = [".*"]\n',
  });
  const scanner = new ContainerSecurityScanner({ ...config, scanners: ['gitleaks'] });
  const report = await scanner.scan(repo, base, changes, await mkdtemp(join(tmpdir(), 'agentic-sec-work-')));
  assert.deepEqual(report.blocking.map(f => [f.scanner, f.file]).sort(), [['gitleaks', 'src/client.ts'], ['policy', '.gitleaks.toml']]);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(fakeToken), 'secrets are redacted in reports');
});

test('semgrep runs offline with local rules and ignores nosemgrep comments', { skip: skipSemgrep, timeout: 300_000 }, async () => {
  const rules = join(await mkdtemp(join(tmpdir(), 'agentic-sec-rules-')), 'rules.yml');
  await writeFile(rules, 'rules:\n  - id: no-eval\n    languages: [javascript]\n    severity: ERROR\n    message: eval of dynamic input\n    pattern: eval(...)\n');
  const { repo, base, changes } = await repoWith({ 'src/run.js': 'export function run(code) { return eval(code); } // nosemgrep\n', 'src/ok.js': 'export const ok = 1;\n' });
  const scanner = new ContainerSecurityScanner({ ...config, scanners: ['semgrep'], semgrepConfig: [rules] });
  const report = await scanner.scan(repo, base, changes, await mkdtemp(join(tmpdir(), 'agentic-sec-work-')));
  assert.deepEqual(report.blocking.map(f => [f.rule.split('.').pop(), f.file, f.line]), [['no-eval', 'src/run.js', 1]]);
});
