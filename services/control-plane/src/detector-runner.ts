import type { DetectorResult, Scope, StepObservationWire } from '@fuse/contracts';
import {
  DEFAULT_CONTEXT_BLOAT_CONFIG,
  DEFAULT_COST_VELOCITY_CONFIG,
  DEFAULT_LOOP_SIGNATURE_CONFIG,
  detectContextBloat,
  detectCostVelocity,
  detectLoopSignature,
  type StepRecord,
} from '@fuse/detectors';
import { getDetectorFiredGauge, getDetectorScoreGauge } from '@fuse/otel';

/** Bounds per-scope memory: a genuinely long-running agent's buffer is
 * capped at this many steps, and anything older than this age is pruned on
 * the next write. Both are generous relative to every detector's own
 * internal window (loop-signature's default `windowSize` is 40) — the
 * point is bounding an abandoned/dead scope's memory, not shaping
 * detection behavior, which the detectors already handle internally. */
const MAX_BUFFER_SIZE = 500;
const MAX_BUFFER_AGE_MS = 60 * 60 * 1000;

function scopeKey(scope: Scope): string {
  return `${scope.tenant}/${scope.environment}/${scope.agentId}`;
}

/**
 * Evaluates the three `@fuse/detectors` functions against real, in-order
 * step observations reported by an agent (task.md §4 — the previously
 * missing link between the pure detector library and any real telemetry).
 * Deliberately in-memory and per-process, not persisted: this is a live
 * "what does the trailing window look like right now" signal, the same
 * kind of state a SigNoz alert rule's own trailing-window query would hold
 * — not durable state like breaker/audit records. A control-plane restart
 * losing an in-flight run's buffer is an accepted characteristic (the next
 * few steps rebuild it), not a correctness bug, and is documented as such
 * rather than silently assumed away.
 */
export class DetectorRunner {
  private readonly buffers = new Map<string, StepRecord[]>();

  /** Appends one step to its scope's buffer, prunes stale/overflowing
   * entries, evaluates all three detectors against the updated buffer, and
   * emits each result's score as a `fuse.detector.score` gauge data point.
   * Returns the results so callers (the HTTP route, tests) can observe the
   * exact same values without a separate read path. */
  recordStep(
    scope: Scope,
    step: StepObservationWire,
    now: Date = new Date(),
  ): DetectorResult[] {
    const key = scopeKey(scope);
    const cutoffMs = now.getTime() - MAX_BUFFER_AGE_MS;
    const buffer = (this.buffers.get(key) ?? []).filter((s) => s.timestampMs >= cutoffMs);
    buffer.push(step);
    if (buffer.length > MAX_BUFFER_SIZE) {
      buffer.splice(0, buffer.length - MAX_BUFFER_SIZE);
    }
    this.buffers.set(key, buffer);

    const results = [
      detectLoopSignature(scope, buffer, DEFAULT_LOOP_SIGNATURE_CONFIG, now),
      detectContextBloat(scope, buffer, DEFAULT_CONTEXT_BLOAT_CONFIG, now),
      detectCostVelocity(scope, buffer, DEFAULT_COST_VELOCITY_CONFIG, now),
    ];

    for (const result of results) {
      const attrs = {
        'fuse.detector': result.detector,
        'fuse.tenant': scope.tenant,
        'fuse.environment': scope.environment,
        'fuse.agent_id': scope.agentId,
      };
      getDetectorScoreGauge().record(result.score, attrs);
      getDetectorFiredGauge().record(result.fired ? 1 : 0, attrs);
    }
    return results;
  }

  /** Test-only escape hatch: clears every scope's buffer. */
  clear(): void {
    this.buffers.clear();
  }
}
