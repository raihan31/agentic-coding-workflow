import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenAICompatibleAgent } from '../src/adapters.js';

test('OpenAICompatibleAgent sends completion request and writes artifact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentic-adapter-'));
  
  // Mock OpenAI-compatible server (like LiteLLM)
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: Date.now(),
        model: 'gemini/gemini-2.5-pro',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '# Plan\n1. Add slugify function' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 },
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const agent = createOpenAICompatibleAgent({
      model: 'gemini/gemini-2.5-pro',
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: 'test-key',
    });

    const result = await agent.run('Implement slugify', dir, dir, 'planner');
    assert.equal(result.output, '# Plan\n1. Add slugify function');
    assert.equal(result.usage?.inputTokens, 15);
    assert.equal(result.usage?.outputTokens, 10);

    const saved = await readFile(join(dir, 'planner.md'), 'utf8');
    assert.equal(saved, '# Plan\n1. Add slugify function');
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
