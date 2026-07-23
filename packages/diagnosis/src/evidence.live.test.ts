import { afterAll, describe, expect, it } from 'vitest';
import { fetchIncidentEvidence } from './evidence.js';
import { SignozMcpClient } from './mcp-client.js';

/**
 * Live smoke test against the real signoz-mcp-server (docs/adr/
 * 007-signoz-mcp-diagnosis.md). Skipped automatically unless
 * FUSE_SIGNOZ_MCP_URL is set. Requires:
 *   docker compose -f infra/docker-compose.yml --profile diagnosis up -d signoz-mcp
 * Run with:
 *   FUSE_SIGNOZ_MCP_URL=http://localhost:8020/mcp pnpm --filter @fuse/diagnosis run test:live
 */
const mcpUrl = process.env['FUSE_SIGNOZ_MCP_URL'];

describe.skipIf(!mcpUrl)('SigNoz MCP live evidence fetch', () => {
  const mcp = new SignozMcpClient({ serverUrl: mcpUrl ?? '' });

  afterAll(async () => {
    await mcp.close();
  });

  it('connects to the real server and returns a well-shaped bundle for a scope with no data', async () => {
    const bundle = await fetchIncidentEvidence(mcp, {
      scope: {
        tenant: 'demo',
        environment: 'local-demo',
        agentId: 'agent-that-almost-certainly-never-ran',
      },
      windowStart: new Date(Date.now() - 60_000),
      windowEnd: new Date(),
    });
    expect(bundle.available).toBe(true);
    expect(bundle.spans).toEqual([]);
  });
});
