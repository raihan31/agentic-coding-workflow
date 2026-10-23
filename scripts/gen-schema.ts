import { writeFile } from 'node:fs/promises';
import { backlogJsonSchema } from '../src/backlog.js';
import { reviewJsonSchema } from '../src/config.js';
import { managerJsonSchema } from '../src/manager.js';

// The JSON Schemas agents are held to, for reference and for external tooling (evals, n8n, ...).
for (const [name, schema] of [['review', reviewJsonSchema()], ['backlog', backlogJsonSchema()], ['manager-decision', managerJsonSchema()]] as const) {
  await writeFile(new URL(`../schemas/${name}.schema.json`, import.meta.url), `${JSON.stringify(schema, null, 2)}\n`);
}
