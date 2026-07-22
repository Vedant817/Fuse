import { describe, expect, it, vi } from 'vitest';
import { createGroqProvider, GROQ_BASE_URL } from './groq.js';
import { createNvidiaBuildProvider, NVIDIA_BUILD_BASE_URL } from './nvidia-build.js';
import {
  extractUsage,
  ProviderHttpError,
  ProviderResponseValidationError,
} from './openai-compatible.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const VALID_COMPLETION = {
  id: 'chatcmpl-123',
  model: 'test-model',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

describe.each([
  { name: 'Groq', create: createGroqProvider, baseUrl: GROQ_BASE_URL },
  {
    name: 'NVIDIA Build',
    create: createNvidiaBuildProvider,
    baseUrl: NVIDIA_BUILD_BASE_URL,
  },
])('$name provider', ({ create, baseUrl }) => {
  it('POSTs to the correct base URL with a Bearer auth header and JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(VALID_COMPLETION));
    const provider = create({ apiKey: 'test-key-123', fetchImpl });

    const result = await provider.chatCompletion({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}/chat/completions`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer test-key-123',
          'content-type': 'application/json',
        }),
      }),
    );
    expect(result).toEqual(VALID_COMPLETION);
  });

  it('parses usage out of a successful response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(VALID_COMPLETION));
    const provider = create({ apiKey: 'k', fetchImpl });
    const result = await provider.chatCompletion({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(extractUsage(result)).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  });

  it('throws a typed ProviderHttpError on a non-2xx response, including the body', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(
        () => new Response('{"error":"rate limited"}', { status: 429 }),
      );
    const provider = create({ apiKey: 'k', fetchImpl });
    try {
      await provider.chatCompletion({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
      });
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderHttpError);
      const httpErr = err as ProviderHttpError;
      expect(httpErr.httpStatus).toBe(429);
      expect(httpErr.body).toContain('rate limited');
    }
  });

  it('rejects a 2xx JSON response whose runtime shape is not a chat completion', async () => {
    const provider = create({
      apiKey: 'k',
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ garbage: true })),
    });
    await expect(
      provider.chatCompletion({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toBeInstanceOf(ProviderResponseValidationError);
  });

  it('rejects a 2xx response whose body is not valid JSON with the same typed error', async () => {
    const provider = create({
      apiKey: 'k',
      fetchImpl: vi
        .fn()
        .mockResolvedValue(
          new Response('not-json', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    });
    await expect(
      provider.chatCompletion({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toBeInstanceOf(ProviderResponseValidationError);
  });

  it('aborts and rejects on timeout', async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const provider = create({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 10,
    });
    await expect(
      provider.chatCompletion({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow();
  });
});
