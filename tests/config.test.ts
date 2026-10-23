import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseConfig, reviewJsonSchema } from '../src/config.js';

test('defaults to a container check runner', () => {
  const c = parseConfig({});
  assert.equal(c.maxRepairs, 2);
  assert.deepEqual(c.checks, []);
  assert.equal(c.checkRunner.type, 'container');
  assert.equal(c.timeouts.checkMs, 600_000);
});

test('host runner must be acknowledged', () => {
  assert.throws(() => parseConfig({ checkRunner: { type: 'host' } }), /Invalid workflow config/);
  assert.equal(parseConfig({ checkRunner: { type: 'host', acknowledgeUnsafe: true } }).checkRunner.type, 'host');
});

test('rejects bad values and unknown keys', () => {
  assert.throws(() => parseConfig({ maxRepairs: 9 }));
  assert.throws(() => parseConfig({ checks: [[]] }));
  assert.throws(() => parseConfig({ maxRepair: 1 }));
  assert.throws(() => parseConfig({ agentEnv: ['NOT VALID'] }));
});

test('schemas/review.schema.json is in sync with the zod schema (run npm run gen:schema)', async () => {
  const file = JSON.parse(await readFile(new URL('../schemas/review.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(file, reviewJsonSchema());
});

test('example workflow config is valid', async () => {
  parseConfig(JSON.parse(await readFile(new URL('../examples/workflow.json', import.meta.url), 'utf8')));
});
