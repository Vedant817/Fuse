import type { SpanTelemetrySample } from './types.js';

function healthySpan(timestampMs: number, isRootSpan = false): SpanTelemetrySample {
  return {
    timestampMs,
    hasRequestModel: true,
    hasInputTokens: true,
    hasOutputTokens: true,
    hasScopedIdentity: true,
    hasValidTimestamps: true,
    isRootSpan,
    hasParent: !isRootSpan,
  };
}

/** A fully healthy window: one root span, several well-formed children. */
export function buildHealthyFixture(nowMs: number, count = 6): SpanTelemetrySample[] {
  const spans = [healthySpan(nowMs - count * 1000, true)];
  for (let i = 1; i < count; i++) {
    spans.push(healthySpan(nowMs - (count - i) * 1000));
  }
  return spans;
}

/** Missing token counts on most spans — the classic "a release silently
 * dropped cost fields" regression from the brief. */
export function buildMissingFieldsFixture(
  nowMs: number,
  count = 6,
): SpanTelemetrySample[] {
  return Array.from({ length: count }, (_, i) => ({
    ...healthySpan(nowMs - (count - i) * 1000),
    hasInputTokens: false,
    hasOutputTokens: false,
  }));
}

/** Parent-chain propagation broken — every step span is an orphan. */
export function buildOrphanSpansFixture(nowMs: number, count = 6): SpanTelemetrySample[] {
  return Array.from({ length: count }, (_, i) => ({
    ...healthySpan(nowMs - (count - i) * 1000),
    hasParent: false,
  }));
}

/** No spans in the window at all. */
export function buildEmptyFixture(): SpanTelemetrySample[] {
  return [];
}

/** Spans exist but are all older than any reasonable staleness limit. */
export function buildStaleFixture(
  nowMs: number,
  ageMs: number,
  count = 6,
): SpanTelemetrySample[] {
  const baseline = nowMs - ageMs;
  return Array.from({ length: count }, (_, i) =>
    healthySpan(baseline - (count - i) * 1000),
  );
}
