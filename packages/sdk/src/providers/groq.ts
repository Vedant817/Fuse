import { OpenAiCompatibleProvider } from './openai-compatible.js';

/** Base URL verified against Groq's current docs (console.groq.com/docs/
 * openai) as of 2026-07-21 — see ADR-003. */
export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

export interface GroqProviderOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createGroqProvider(
  options: GroqProviderOptions,
): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({
    baseUrl: GROQ_BASE_URL,
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
}
