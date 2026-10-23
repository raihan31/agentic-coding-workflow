import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { execute, tail } from '../src/process.js';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

test('does not leak host env unless passed explicitly', async () => {
  process.env.AGENTIC_TEST_SECRET = 's3cret';
  const script = ['-e', 'process.stdout.write(process.env.AGENTIC_TEST_SECRET ?? "absent")'];
  assert.equal((await execute('node', script, tmpdir())).stdout, 'absent');
  assert.equal((await execute('node', script, tmpdir(), { passEnv: ['AGENTIC_TEST_SECRET'] })).stdout, 's3cret');
});

test('timeout kills the whole process tree', async () => {
  const started = Date.now();
  const r = await execute('sh', ['-c', 'sleep 30 & echo $!; wait'], tmpdir(), { timeoutMs: 500, killGraceMs: 200 });
  assert.equal(r.timedOut, true);
  assert.equal(r.code, 124);
  assert.ok(Date.now() - started < 5_000);
  await pause(100);
  assert.equal(alive(Number(r.stdout.trim())), false, 'grandchild survived the timeout');
});

test('background processes left behind by a finished command are reaped', async () => {
  const r = await execute('sh', ['-c', 'sleep 30 & echo $!'], tmpdir(), { timeoutMs: 10_000 });
  assert.equal(r.timedOut, false);
  await pause(100);
  assert.equal(alive(Number(r.stdout.trim())), false);
});

test('keeps only the tail of large output', async () => {
  const r = await execute('node', ['-e', 'process.stdout.write("x".repeat(100000) + "END")'], tmpdir(), { maxOutputChars: 1_000 });
  assert.equal(r.truncated, true);
  assert.ok(r.stdout.length < 1_100);
  assert.ok(r.stdout.endsWith('END'));
});

test('missing binary rejects', async () => {
  await assert.rejects(execute('definitely-not-a-binary-xyz', [], tmpdir()), /ENOENT/);
});

test('tail marks omitted text', () => {
  assert.equal(tail('abc', 5), 'abc');
  assert.match(tail('abcdefgh', 3), /omitted[\s\S]*fgh$/);
});

test('aborting a scope kills only the processes started in it', async () => {
  const { withAbortSignal } = await import('../src/process.js');
  const controller = new AbortController();
  const scoped = withAbortSignal(controller.signal, () => execute('sh', ['-c', 'sleep 30 & echo $!; wait'], tmpdir(), { killGraceMs: 200 }));
  const outside = execute('sh', ['-c', 'sleep 1; echo survived'], tmpdir());
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(scoped, /aborted/);
  assert.equal((await outside).stdout.trim(), 'survived');
  await assert.rejects(withAbortSignal(controller.signal, () => execute('true', [], tmpdir())), /aborted/);
});
