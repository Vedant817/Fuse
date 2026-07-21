import { OpenAiCompatibleProvider } from './openai-compatible.js';

/** Base URL verified against NVIDIA's current NIM docs
 * (docs.nvidia.com/nim) as of 2026-07-21 — see ADR-003. API keys from
 * build.nvidia.com are formatted `nvapi-...`. */
export const NVIDIA_BUILD_BASE_URL = 'https://integrate.api.nvidia.com/v1';

export interface NvidiaBuildProviderOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createNvidiaBuildProvider(
  options: NvidiaBuildProviderOptions,
): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({
    baseUrl: NVIDIA_BUILD_BASE_URL,
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
}
