import { createServer } from 'node:http';
import { once } from 'node:events';
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

  it('includes MCP connection establishment itself inside the configured timeout', async () => {
    const server = createServer(() => {
      // Deliberately accept the MCP HTTP request without ever responding.
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test port');
    const client = new SignozMcpClient({
      serverUrl: `http://127.0.0.1:${address.port}/mcp`,
      timeoutMs: 100,
      maxRetries: 0,
    });
    const startedAt = Date.now();
    try {
      await expect(client.callTool('signoz_search_traces', {})).rejects.toThrow(
        /timed out after 100ms/,
      );
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('close() is safe to call even if never connected', async () => {
    const client = new SignozMcpClient({ serverUrl: 'http://127.0.0.1:1/mcp' });
    await expect(client.close()).resolves.toBeUndefined();
  });
});
