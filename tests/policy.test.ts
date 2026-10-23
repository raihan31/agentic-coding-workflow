import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePorcelainZ } from '../src/git.js';
import { globToRegExp, protectedPathViolations } from '../src/policy.js';

test('glob matching', () => {
  const m = (g: string, p: string) => globToRegExp(g).test(p);
  assert.ok(m('package.json', 'package.json'));
  assert.ok(!m('package.json', 'sub/package.json'));
  assert.ok(m('**/package.json', 'sub/package.json'));
  assert.ok(m('**/package.json', 'package.json'));
  assert.ok(m('tests/**', 'tests/a/b.test.ts'));
  assert.ok(m('src/*.ts', 'src/a.ts'));
  assert.ok(!m('src/*.ts', 'src/x/a.ts'));
  assert.ok(m('file?.txt', 'file1.txt'));
  assert.ok(!m('a.b', 'aXb'));
});

test('parses porcelain -z output including renames', () => {
  const changes = parsePorcelainZ(' M src/a.ts\0?? new file.ts\0R  b.ts\0old.ts\0 D tests/x.test.ts\0');
  assert.deepEqual(changes, [
    { x: ' ', y: 'M', path: 'src/a.ts' },
    { x: '?', y: '?', path: 'new file.ts' },
    { x: 'R', y: ' ', path: 'b.ts', origPath: 'old.ts' },
    { x: ' ', y: 'D', path: 'tests/x.test.ts' },
  ]);
});

test('protected paths: modifying, deleting or renaming is a violation, adding is not', () => {
  const changes = parsePorcelainZ(' M tests/a.test.ts\0?? tests/new.test.ts\0 D tests/b.test.ts\0R  moved.ts\0tests/c.test.ts\0 M src/x.ts\0');
  assert.deepEqual(protectedPathViolations(changes, ['tests/**']), [
    { path: 'tests/a.test.ts', reason: 'modified' },
    { path: 'tests/b.test.ts', reason: 'deleted' },
    { path: 'tests/c.test.ts', reason: 'renamed to moved.ts' },
  ]);
  assert.deepEqual(protectedPathViolations(changes, []), []);
});
