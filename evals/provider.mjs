// promptfoo custom provider: runs one eval case (evals/cases.ts) with the real agents and returns its parsed result.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export default class AgenticCaseProvider {
  constructor(options = {}) { this.providerId = options.id ?? 'agentic-case'; this.timeoutMs = options.config?.timeoutMs ?? 1_800_000; }
  id() { return this.providerId; }

  async callApi(_prompt, context) {
    const name = context?.vars?.case;
    if (!name) return { error: 'test is missing vars.case' };
    const started = Date.now();
    const { code, stdout, stderr } = await new Promise(resolve => {
      const child = spawn(join(here, '..', 'node_modules', '.bin', 'tsx'), [join(here, 'cases.ts'), name], { cwd: join(here, '..'), env: process.env });
      let out = '', err = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), this.timeoutMs);
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('close', c => { clearTimeout(timer); resolve({ code: c, stdout: out, stderr: err }); });
    });
    const line = stdout.trim().split('\n').pop() ?? '';
    try {
      const parsed = JSON.parse(line);
      return { output: JSON.stringify(parsed), metadata: { durationMs: Date.now() - started } };
    } catch {
      return { error: `case ${name} exited ${code}: ${stderr.slice(-1500) || stdout.slice(-1500)}` };
    }
  }
}
