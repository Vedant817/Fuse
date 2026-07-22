/**
 * A thin client for the OpenAI-compatible `/chat/completions` shape shared
 * by several inference platforms (Groq, NVIDIA Build/NIM, and others).
 * Deliberately provider-agnostic: `createGroqProvider`/
 * `createNvidiaBuildProvider` are just this class pinned to a base URL.
 * Never imported by `@fuse/breaker-core` or `@fuse/breaker-store` — these
 * types stay entirely within the SDK's provider layer (ADR-002/ADR-003).
 */
import { z } from 'zod';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  /** Required, never defaulted — see ADR-003 on why this adapter does not
   * pin a default model name. */
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: ChatCompletionUsage;
}

const ChatCompletionResponseSchema: z.ZodType<ChatCompletionResponse> = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  choices: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        message: z.object({ role: z.string().min(1), content: z.string() }),
        finish_reason: z.string().min(1),
      }),
    )
    .min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  }),
});

export interface OpenAiCompatibleProviderOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

export class ProviderResponseValidationError extends Error {
  constructor(
    message: string,
    readonly issues: readonly string[],
  ) {
    super(message);
    this.name = 'ProviderResponseValidationError';
  }
}

export class OpenAiCompatibleProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenAiCompatibleProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async chatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(req),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ProviderHttpError(
          `provider returned HTTP ${res.status}`,
          res.status,
          body.slice(0, 2000),
        );
      }
      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        throw new ProviderResponseValidationError(
          'provider returned a successful response that was not valid JSON',
          ['response: invalid JSON'],
        );
      }
      const parsed = ChatCompletionResponseSchema.safeParse(payload);
      if (!parsed.success) {
        const issues = parsed.error.issues.map(
          (issue) => `${issue.path.join('.') || 'response'}: ${issue.message}`,
        );
        throw new ProviderResponseValidationError(
          'provider returned a successful response with an invalid chat-completion shape',
          issues,
        );
      }
      return parsed.data;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Convenience accessor for the token counts callers need for cost
 * estimation/telemetry (task.md §3.2) — kept minimal here; the versioned
 * price table and cost calculation belong to that later slice. */
export function extractUsage(response: ChatCompletionResponse): ChatCompletionUsage {
  return response.usage;
}
