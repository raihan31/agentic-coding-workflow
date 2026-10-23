import { isAdded, type FileChange } from './git.js';

/** Minimal glob matcher over repo-relative paths: `**` spans directories, `*` and `?` do not. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export interface Violation { path: string; reason: string; }

/**
 * Existing files matching a protected glob may not be modified, deleted or renamed away.
 * Adding new files is allowed, so agents can add tests without weakening existing ones.
 */
export function protectedPathViolations(changes: FileChange[], patterns: string[]): Violation[] {
  if (!patterns.length) return [];
  const regexps = patterns.map(globToRegExp);
  const matches = (path: string) => regexps.some(r => r.test(path));
  const violations: Violation[] = [];
  for (const c of changes) {
    if (c.x === 'R' && c.origPath && matches(c.origPath)) violations.push({ path: c.origPath, reason: `renamed to ${c.path}` });
    else if (!isAdded(c) && matches(c.path)) violations.push({ path: c.path, reason: c.x === 'D' || c.y === 'D' ? 'deleted' : 'modified' });
  }
  return violations;
}
