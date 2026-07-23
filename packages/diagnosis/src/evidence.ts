import type { Scope } from '@fuse/contracts';
import type { SignozMcpClient } from './mcp-client.js';

/** Whitelisted fields only — never the tool's raw response object. Defends
 * against a future span attribute carrying more than this repo's threat
 * model assumes today (docs/threat-model.md §5), not just against what's
 * actually emitted right now. */
export interface EvidenceSpan {
  traceId: string;
  spanId: string;
  name: string;
  serviceName: string;
  timestampIso: string;
  durationNanos: number;
  hasError: boolean;
  /** Deep link back into the SigNoz UI, from the tool's own response —
   * task.md §7.1's "preserve evidence links/IDs so claims can be checked
   * in SigNoz." */
  webUrl?: string | undefined;
}

export interface EvidenceBundle {
  available: boolean;
  /** Set when `available` is false: why (unreachable, timeout, no data). */
  reason?: string;
  spans: EvidenceSpan[];
  queryFilter: string;
  windowStart: string;
  windowEnd: string;
}

const MAX_SPANS = 5;

/** Single-quote escaping for the filter DSL — scope values are system-
 * generated, not raw end-user input, but an agentId is still ultimately
 * caller-chosen, so this is defensive against filter-injection rather than
 * assumed unnecessary. */
function escapeFilterValue(value: string): string {
  return value.replace(/'/g, "\\'");
}

function buildScopeFilter(scope: Scope): string {
  return [
    `attribute.fuse.tenant = '${escapeFilterValue(scope.tenant)}'`,
    `attribute.fuse.environment = '${escapeFilterValue(scope.environment)}'`,
    `attribute.fuse.agent_id = '${escapeFilterValue(scope.agentId)}'`,
  ].join(' AND ');
}

interface RawSearchTracesRow {
  data: Record<string, unknown>;
  timestamp: string;
}

interface RawSearchTracesResponse {
  data?: { data?: { results?: Array<{ rows?: RawSearchTracesRow[] }> } };
}

function toEvidenceSpan(row: RawSearchTracesRow): EvidenceSpan | undefined {
  const d = row.data;
  const traceId = d['trace_id'];
  const spanId = d['span_id'];
  if (typeof traceId !== 'string' || typeof spanId !== 'string') return undefined;
  return {
    traceId,
    spanId,
    name: typeof d['name'] === 'string' ? d['name'] : 'unknown',
    serviceName: typeof d['service.name'] === 'string' ? d['service.name'] : 'unknown',
    timestampIso: row.timestamp,
    durationNanos: typeof d['duration_nano'] === 'number' ? d['duration_nano'] : 0,
    hasError: d['has_error'] === true,
    webUrl: typeof d['webUrl'] === 'string' ? d['webUrl'] : undefined,
  };
}

/**
 * Fetches a bounded, whitelisted set of spans for one incident scope within
 * a time window, via the real SigNoz MCP server. Never throws: an
 * unreachable MCP server, a timeout, or a malformed response all produce
 * `{ available: false, reason }` rather than propagating — diagnosis
 * evidence is advisory, and the breaker trip it explains has already
 * committed by the time this runs (task.md §7's "diagnosis/Slack outages
 * do not weaken the tripped breaker").
 */
export async function fetchIncidentEvidence(
  mcp: SignozMcpClient,
  params: { scope: Scope; windowStart: Date; windowEnd: Date },
): Promise<EvidenceBundle> {
  const queryFilter = buildScopeFilter(params.scope);
  const base = {
    queryFilter,
    windowStart: params.windowStart.toISOString(),
    windowEnd: params.windowEnd.toISOString(),
  };

  let result;
  try {
    result = await mcp.callTool('signoz_search_traces', {
      filter: queryFilter,
      start: params.windowStart.getTime(),
      end: params.windowEnd.getTime(),
      limit: MAX_SPANS,
    });
  } catch (err) {
    return {
      ...base,
      available: false,
      reason: `MCP call failed: ${err instanceof Error ? err.message : String(err)}`,
      spans: [],
    };
  }

  if (result.isError) {
    const text = result.content.find((c) => c.type === 'text')?.text ?? 'unknown error';
    return {
      ...base,
      available: false,
      reason: `SigNoz reported an error: ${text}`,
      spans: [],
    };
  }

  const text = result.content.find((c) => c.type === 'text')?.text;
  if (!text) {
    return {
      ...base,
      available: false,
      reason: 'MCP response had no text content',
      spans: [],
    };
  }

  let parsed: RawSearchTracesResponse;
  try {
    parsed = JSON.parse(text) as RawSearchTracesResponse;
  } catch {
    return {
      ...base,
      available: false,
      reason: 'MCP response text was not valid JSON',
      spans: [],
    };
  }

  const rows = parsed.data?.data?.results?.flatMap((r) => r.rows ?? []) ?? [];
  const spans = rows
    .slice(0, MAX_SPANS)
    .map(toEvidenceSpan)
    .filter((s): s is EvidenceSpan => s !== undefined);

  return { ...base, available: true, spans };
}
