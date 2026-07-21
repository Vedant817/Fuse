import { describe, expect, it } from 'vitest';
import { createNvidiaBuildProvider } from './nvidia-build.js';

/**
 * Live smoke test against the real NVIDIA Build (NIM) API. Skipped
 * automatically when NVIDIA_API_KEY is not set; requires zero code
 * changes to run once a key (format `nvapi-...`) is exported. Run with:
 * NVIDIA_API_KEY=... pnpm --filter @fuse/sdk run test:live
 */
const apiKey = process.env['NVIDIA_API_KEY'];

describe.skipIf(!apiKey)('NVIDIA Build live API', () => {
  it('completes a minimal real chat request', async () => {
    const provider = createNvidiaBuildProvider({ apiKey: apiKey! });
    const result = await provider.chatCompletion({
      model: process.env['NVIDIA_TEST_MODEL'] ?? 'meta/llama-3.1-8b-instruct',
      messages: [{ role: 'user', content: 'Reply with exactly one word: pong' }],
      max_tokens: 10,
    });
    expect(result.choices[0]?.message.content).toBeTruthy();
    expect(result.usage.total_tokens).toBeGreaterThan(0);
  });
});
