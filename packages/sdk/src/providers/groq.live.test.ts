import { describe, expect, it } from 'vitest';
import { createGroqProvider } from './groq.js';

/**
 * Live smoke test against the real Groq API — the "one controlled
 * integration test against a real provider" task.md §2.2 asks for.
 * Skipped automatically when GROQ_API_KEY is not set; requires zero code
 * changes to run once a key is exported. Run with:
 * GROQ_API_KEY=... pnpm --filter @fuse/sdk run test:live
 */
const apiKey = process.env['GROQ_API_KEY'];

describe.skipIf(!apiKey)('Groq live API', () => {
  it('completes a minimal real chat request', async () => {
    const provider = createGroqProvider({ apiKey: apiKey! });
    const result = await provider.chatCompletion({
      model: process.env['GROQ_TEST_MODEL'] ?? 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: 'Reply with exactly one word: pong' }],
      max_tokens: 10,
    });
    expect(result.choices[0]?.message.content).toBeTruthy();
    expect(result.usage.total_tokens).toBeGreaterThan(0);
  });
});
