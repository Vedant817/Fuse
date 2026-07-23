import type { EvidenceBundle } from './evidence.js';

/** A deterministic, synthetic evidence bundle — no real trace/span IDs, no
 * network — for tests and for local rehearsal when SigNoz MCP isn't
 * running (task.md §7.1's "mock contract fixtures"). */
export function buildFixtureEvidenceBundle(
  overrides: Partial<EvidenceBundle> = {},
): EvidenceBundle {
  return {
    available: true,
    queryFilter:
      "attribute.fuse.tenant = 'demo' AND attribute.fuse.environment = 'local-demo' AND attribute.fuse.agent_id = 'agent-fixture-0001'",
    windowStart: '2026-07-23T00:00:00.000Z',
    windowEnd: '2026-07-23T00:05:00.000Z',
    spans: [
      {
        traceId: 'fixture-trace-0000000000000001',
        spanId: 'fixture-span-00000001',
        name: 'chat mock-model-v1',
        serviceName: 'fuse-fixture-agent',
        timestampIso: '2026-07-23T00:01:00.000Z',
        durationNanos: 42_000,
        hasError: false,
        webUrl: undefined,
      },
      {
        traceId: 'fixture-trace-0000000000000001',
        spanId: 'fixture-span-00000002',
        name: 'chat mock-model-v1',
        serviceName: 'fuse-fixture-agent',
        timestampIso: '2026-07-23T00:01:05.000Z',
        durationNanos: 39_000,
        hasError: false,
        webUrl: undefined,
      },
    ],
    ...overrides,
  };
}

/** The shape a real unavailable/degraded response takes — used to test
 * that downstream diagnosis logic handles this without throwing. */
export function buildUnavailableEvidenceBundle(reason: string): EvidenceBundle {
  return {
    available: false,
    reason,
    spans: [],
    queryFilter: "attribute.fuse.agent_id = 'agent-fixture-0001'",
    windowStart: '2026-07-23T00:00:00.000Z',
    windowEnd: '2026-07-23T00:05:00.000Z',
  };
}
