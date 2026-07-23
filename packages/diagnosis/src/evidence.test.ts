import { describe, expect, it, vi } from 'vitest';
import type { Scope } from '@fuse/contracts';
import { fetchIncidentEvidence } from './evidence.js';
import type { McpToolResult, SignozMcpClient } from './mcp-client.js';

const SCOPE: Scope = { tenant: 't1', environment: 'test', agentId: 'agent-1' };
const WINDOW = {
  windowStart: new Date('2026-07-23T00:00:00.000Z'),
  windowEnd: new Date('2026-07-23T00:05:00.000Z'),
};

function fakeMcp(
  callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolResult>,
): SignozMcpClient {
  return { callTool } as unknown as SignozMcpClient;
}

function successResult(rows: Array<Record<string, unknown>>): McpToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          data: {
            data: {
              results: [
                {
                  queryName: 'A',
                  rows: rows.map((data) => ({ data, timestamp: data['timestamp'] })),
                },
              ],
            },
          },
        }),
      },
    ],
  };
}

describe('fetchIncidentEvidence', () => {
  it('scopes the filter to tenant/environment/agent_id as span attributes', async () => {
    const callTool = vi.fn().mockResolvedValue(successResult([]));
    await fetchIncidentEvidence(fakeMcp(callTool), { scope: SCOPE, ...WINDOW });
    expect(callTool).toHaveBeenCalledWith(
      'signoz_search_traces',
      expect.objectContaining({
        filter:
          "attribute.fuse.tenant = 't1' AND attribute.fuse.environment = 'test' AND attribute.fuse.agent_id = 'agent-1'",
      }),
    );
  });

  it('maps only whitelisted fields from real rows, capped at 5', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      trace_id: `trace-${i}`,
      span_id: `span-${i}`,
      name: 'chat model',
      'service.name': 'svc',
      duration_nano: 1000 + i,
      has_error: i === 0,
      webUrl: `http://signoz/trace/trace-${i}`,
      timestamp: '2026-07-23T00:01:00.000Z',
      'some.future.sensitive.field': 'should never appear',
    }));
    const bundle = await fetchIncidentEvidence(
      fakeMcp(vi.fn().mockResolvedValue(successResult(rows))),
      {
        scope: SCOPE,
        ...WINDOW,
      },
    );
    expect(bundle.available).toBe(true);
    expect(bundle.spans).toHaveLength(5);
    expect(bundle.spans[0]).toEqual({
      traceId: 'trace-0',
      spanId: 'span-0',
      name: 'chat model',
      serviceName: 'svc',
      timestampIso: '2026-07-23T00:01:00.000Z',
      durationNanos: 1000,
      hasError: true,
      webUrl: 'http://signoz/trace/trace-0',
    });
    expect(JSON.stringify(bundle)).not.toContain('should never appear');
  });

  it('degrades to available:false (never throws) when the MCP call fails', async () => {
    const callTool = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const bundle = await fetchIncidentEvidence(fakeMcp(callTool), {
      scope: SCOPE,
      ...WINDOW,
    });
    expect(bundle.available).toBe(false);
    expect(bundle.reason).toContain('ECONNREFUSED');
    expect(bundle.spans).toEqual([]);
  });

  it('degrades to available:false when SigNoz reports a tool error', async () => {
    const callTool = vi.fn().mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'key `fuse.agent_id` not found' }],
    } satisfies McpToolResult);
    const bundle = await fetchIncidentEvidence(fakeMcp(callTool), {
      scope: SCOPE,
      ...WINDOW,
    });
    expect(bundle.available).toBe(false);
    expect(bundle.reason).toContain('fuse.agent_id');
  });

  it('degrades to available:false on malformed (non-JSON) response text', async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'not json' }],
    } satisfies McpToolResult);
    const bundle = await fetchIncidentEvidence(fakeMcp(callTool), {
      scope: SCOPE,
      ...WINDOW,
    });
    expect(bundle.available).toBe(false);
  });

  it('escapes single quotes in scope values defensively', async () => {
    const callTool = vi.fn().mockResolvedValue(successResult([]));
    await fetchIncidentEvidence(fakeMcp(callTool), {
      scope: { tenant: 't1', environment: 'test', agentId: "agent-o'brien" },
      ...WINDOW,
    });
    const [, args] = callTool.mock.calls[0]!;
    expect((args as { filter: string }).filter).toContain("agent-o\\'brien");
  });
});
