import { realpath } from 'node:fs/promises';
import { required, type ExecOptions, type ProcessResult } from './process.js';

// Repo-controlled config such as hooks or core.fsmonitor can execute arbitrary commands on the host.
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat'];

export async function git(args: string[], cwd: string, opts: ExecOptions = {}): Promise<ProcessResult> {
  return await required('git', [...SAFE, ...args], cwd, { timeoutMs: 120_000, ...opts });
}

export interface FileChange { x: string; y: string; path: string; origPath?: string; }
export const isAdded = (c: FileChange) => c.x === '?' || c.x === 'A' || c.y === 'A';

/** Returns the canonical repository root; throws unless `repo` is the root of a clean work tree. */
export async function assertCleanRepoRoot(repo: string): Promise<string> {
  const given = await realpath(repo);
  const top = await realpath((await git(['rev-parse', '--show-toplevel'], given)).stdout.trim());
  if (top !== given) throw new Error(`Pass the Git repository root as --repo (got ${given}, root is ${top})`);
  if ((await git(['status', '--porcelain'], given)).stdout.trim()) throw new Error('Repository must be clean; commit or stash changes first');
  return given;
}

export async function headSha(cwd: string): Promise<string> {
  return (await git(['rev-parse', 'HEAD'], cwd)).stdout.trim();
}

/** Detached by default; with `branch`, creates that branch at `sha` (the project deliverable). */
export async function addWorktree(repo: string, worktree: string, sha: string, branch?: string): Promise<void> {
  await git(['worktree', 'add', ...(branch ? ['-b', branch] : ['--detach']), worktree, sha], repo);
}

/** Stages everything (respecting .gitignore) and commits; returns the new commit SHA. */
export async function commitAll(worktree: string, message: string, author: { name: string; email: string }): Promise<string> {
  await git(['add', '--all'], worktree);
  await git(['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '-m', message], worktree);
  return await headSha(worktree);
}

/** Drops uncommitted changes and untracked files; ignored files (e.g. node_modules) are kept. */
export async function discardChanges(worktree: string): Promise<void> {
  await git(['reset', '--hard', '--quiet', 'HEAD'], worktree);
  await git(['clean', '-fd', '--quiet'], worktree);
}

export async function removeWorktree(repo: string, worktree: string): Promise<void> {
  await git(['worktree', 'remove', '--force', worktree], repo);
  await git(['worktree', 'prune'], repo);
}

export function parsePorcelainZ(output: string): FileChange[] {
  const parts = output.split('\0');
  const changes: FileChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const change: FileChange = { x: entry[0], y: entry[1], path: entry.slice(3) };
    if (change.x === 'R' || change.x === 'C') change.origPath = parts[++i];
    changes.push(change);
  }
  return changes;
}

export async function listChanges(worktree: string): Promise<FileChange[]> {
  return parsePorcelainZ((await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], worktree)).stdout);
}

/** Diff of the work tree (including new files) against `base`. */
export async function diffAgainst(worktree: string, base: string): Promise<string> {
  // Intent-to-add makes untracked files show up in `git diff` without staging their content.
  await git(['add', '--all', '--intent-to-add'], worktree);
  return (await git(['diff', '--no-color', '--no-ext-diff', base], worktree, { maxOutputChars: 5_000_000 })).stdout;
}
