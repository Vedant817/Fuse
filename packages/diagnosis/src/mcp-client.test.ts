import { describe, expect, it } from 'vitest';
import { SignozMcpClient } from './mcp-client.js';

describe('SignozMcpClient', () => {
  it('throws (does not hang) when the server is unreachable, within the configured timeout', async () => {
    const client = new SignozMcpClient({
      serverUrl: 'http://127.0.0.1:1/mcp', // nothing listens here
      timeoutMs: 200,
      maxRetries: 0,
    });
    const start = Date.now();
    await expect(client.callTool('signoz_search_traces', {})).rejects.toThrow();
    // Bounded: must fail fast, not hang indefinitely.
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it('close() is safe to call even if never connected', async () => {
    const client = new SignozMcpClient({ serverUrl: 'http://127.0.0.1:1/mcp' });
    await expect(client.close()).resolves.toBeUndefined();
  });
});
