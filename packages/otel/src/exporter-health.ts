import { randomUUID } from 'node:crypto';
import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
} from '@opentelemetry/semantic-conventions/incubating';
import {
  ATTR_FUSE_AGENT_ID,
  ATTR_FUSE_ENVIRONMENT,
  ATTR_FUSE_TENANT,
} from './attributes.js';

export interface ExportedSpanHealthSample {
  timestampMs: number;
  hasRequestModel: boolean;
  hasInputTokens: boolean;
  hasOutputTokens: boolean;
  hasScopedIdentity: boolean;
  hasValidTimestamps: boolean;
  isRootSpan: boolean;
  hasParent: boolean;
}

export interface ScopeTraceExportResult {
  scope: { tenant: string; environment: string; agentId: string };
  exporterDelivery: {
    status: 'success' | 'failure';
    observedAtMs: number;
    sourceInstanceId: string;
    sequence: number;
  };
  spans: ExportedSpanHealthSample[];
}

export type TraceExportResultObserver = (
  result: ScopeTraceExportResult,
) => void | Promise<void>;

function hrTimeMillis(time: readonly [number, number]): number {
  return time[0] * 1_000 + time[1] / 1_000_000;
}

function finiteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function scopeOf(span: ReadableSpan): ScopeTraceExportResult['scope'] | null {
  const tenant = span.attributes[ATTR_FUSE_TENANT];
  const environment = span.attributes[ATTR_FUSE_ENVIRONMENT];
  const agentId = span.attributes[ATTR_FUSE_AGENT_ID];
  return typeof tenant === 'string' &&
    tenant.length > 0 &&
    typeof environment === 'string' &&
    environment.length > 0 &&
    typeof agentId === 'string' &&
    agentId.length > 0
    ? { tenant, environment, agentId }
    : null;
}

function sampleOf(span: ReadableSpan): ExportedSpanHealthSample {
  const startMs = hrTimeMillis(span.startTime);
  const endMs = hrTimeMillis(span.endTime);
  const parent = span.parentSpanContext;
  return {
    timestampMs: Math.max(0, Math.floor(startMs)),
    hasRequestModel:
      typeof span.attributes[ATTR_GEN_AI_REQUEST_MODEL] === 'string' &&
      span.attributes[ATTR_GEN_AI_REQUEST_MODEL].length > 0,
    hasInputTokens: finiteNumber(span.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS]),
    hasOutputTokens: finiteNumber(span.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]),
    hasScopedIdentity: scopeOf(span) !== null,
    hasValidTimestamps:
      Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs,
    isRootSpan: parent === undefined,
    hasParent: parent !== undefined,
  };
}

/**
 * Wraps the real OTLP span exporter and emits bounded, structural evidence
 * only after its result callback runs. No span names, events, prompt content,
 * or arbitrary attributes leave this helper.
 */
export class ExporterHealthSpanExporter implements SpanExporter {
  private readonly maxSpansPerScope: number;
  private readonly sourceInstanceId: string;
  private sequence = 0;
  private readonly pendingObservers = new Set<Promise<void>>();

  constructor(
    private readonly delegate: SpanExporter,
    private readonly observer: TraceExportResultObserver,
    maxSpansPerScope = 200,
    private readonly clock: () => number = Date.now,
    sourceInstanceId: string = randomUUID(),
  ) {
    this.maxSpansPerScope = Math.max(1, Math.min(2_000, maxSpansPerScope));
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(sourceInstanceId)) {
      throw new Error(
        'trace exporter sourceInstanceId must be 1-128 ASCII letters, digits, dot, underscore, colon, or hyphen',
      );
    }
    this.sourceInstanceId = sourceInstanceId;
  }

  export(
    spans: ReadableSpan[],
    resultCallback: Parameters<SpanExporter['export']>[1],
  ): void {
    if (this.sequence === Number.MAX_SAFE_INTEGER) {
      throw new Error('trace exporter sequence exhausted for this source instance');
    }
    const sequence = ++this.sequence;
    let resolveExport!: () => void;
    const pendingExport = new Promise<void>((resolve) => {
      resolveExport = resolve;
    });
    this.pendingObservers.add(pendingExport);
    try {
      this.delegate.export(spans, (result) => {
        const grouped = new Map<
          string,
          { scope: ScopeTraceExportResult['scope']; spans: ExportedSpanHealthSample[] }
        >();
        for (const span of spans) {
          const scope = scopeOf(span);
          if (!scope) continue;
          const key = `${scope.tenant}\u0000${scope.environment}\u0000${scope.agentId}`;
          const group = grouped.get(key) ?? { scope, spans: [] };
          group.spans.push(sampleOf(span));
          if (group.spans.length > this.maxSpansPerScope) group.spans.shift();
          grouped.set(key, group);
        }

        const observedAtMs = this.clock();
        const observers: Promise<void>[] = [];
        for (const group of grouped.values()) {
          try {
            observers.push(
              Promise.resolve(
                this.observer({
                  scope: group.scope,
                  // OTel's ExportResultCode.SUCCESS is 0. Avoid a runtime import
                  // from @opentelemetry/core solely for this stable enum value.
                  exporterDelivery: {
                    status: result.code === 0 ? 'success' : 'failure',
                    observedAtMs,
                    sourceInstanceId: this.sourceInstanceId,
                    sequence,
                  },
                  spans: group.spans,
                }),
              ).catch(() => {}),
            );
          } catch {
            // Health reporting must not alter the exporter's own result.
          }
        }
        void Promise.all(observers).finally(() => {
          this.pendingObservers.delete(pendingExport);
          resolveExport();
        });
        resultCallback(result);
      });
    } catch (error) {
      this.pendingObservers.delete(pendingExport);
      resolveExport();
      throw error;
    }
  }

  forceFlush(): Promise<void> {
    return this.flushDelegateAndObservers();
  }

  async shutdown(): Promise<void> {
    try {
      await this.delegate.shutdown();
    } finally {
      await this.drainObservers();
    }
  }

  private async flushDelegateAndObservers(): Promise<void> {
    try {
      await (this.delegate.forceFlush?.() ?? Promise.resolve());
    } finally {
      await this.drainObservers();
    }
  }

  private async drainObservers(): Promise<void> {
    while (this.pendingObservers.size > 0) {
      await Promise.all([...this.pendingObservers]);
    }
  }
}
