import type {
  DetectorResult,
  DetectorsConfig,
  Scope,
  StepObservationWire,
} from '@fuse/contracts';
import {
  DEFAULT_CONTEXT_BLOAT_CONFIG,
  DEFAULT_COST_VELOCITY_CONFIG,
  DEFAULT_LOOP_SIGNATURE_CONFIG,
  detectContextBloat,
  detectCostVelocity,
  detectLoopSignature,
  type ContextBloatConfig,
  type CostVelocityConfig,
  type LoopSignatureConfig,
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

/** Bounds the NUMBER of distinct scopes tracked at once — a separate
 * concern from the per-scope buffer bound above. `scopeKey` is built from
 * caller-controlled strings (`tenant`/`environment`/`agentId` in the
 * request body any agent-tier token may post to `/v1/detectors/observe`),
 * so without this, a caller sending many distinct `agentId`s would grow
 * the `buffers` Map without limit even though each individual buffer stays
 * small — an unbounded-cardinality memory-exhaustion vector distinct from
 * the per-scope bound (task.md §9.2 failure-injection review). Eviction is
 * oldest-inserted-first (`Map` preserves insertion order; re-touching a key
 * via `delete`+`set` below moves it to the end), a simple LRU approximation
 * — this is a defense-in-depth ceiling, not expected to bind in normal
 * operation, since empty buffers are already evicted as soon as they prune
 * to zero (see `recordStep`). */
const MAX_TRACKED_SCOPES = 10_000;

function scopeKey(scope: Scope): string {
  return `${scope.tenant}/${scope.environment}/${scope.agentId}`;
}

/**
 * Evaluates the three `@fuse/detectors` functions against real, in-order
 * step observations reported by an agent. The production HTTP route uses
 * `evaluateWindow` with the SDK-carried complete bounded window, so control
 * plane replicas are stateless for enforcement. The in-memory buffer remains
 * only for direct library users of the compatibility `recordStep` API.
 */
export class DetectorRunner {
  private readonly buffers = new Map<string, StepRecord[]>();
  private readonly maxTrackedScopes: number;
  private readonly loopConfig: LoopSignatureConfig;
  private readonly contextBloatConfig: ContextBloatConfig;
  private readonly costVelocityConfig: CostVelocityConfig;

  /** `maxTrackedScopes` defaults to the real production cap
   * (`MAX_TRACKED_SCOPES`); tests override it to a small number so the
   * cardinality-eviction behavior can be exercised without actually
   * creating thousands of scopes. */
  constructor(
    options:
      | number
      | {
          maxTrackedScopes?: number;
          detectors?: DetectorsConfig;
        } = {},
  ) {
    const normalized =
      typeof options === 'number' ? { maxTrackedScopes: options } : options;
    this.maxTrackedScopes = normalized.maxTrackedScopes ?? MAX_TRACKED_SCOPES;
    this.loopConfig = {
      ...DEFAULT_LOOP_SIGNATURE_CONFIG,
      ...normalized.detectors?.['loop-signature'],
    };
    this.contextBloatConfig = {
      ...DEFAULT_CONTEXT_BLOAT_CONFIG,
      ...normalized.detectors?.['context-bloat'],
    };
    this.costVelocityConfig = {
      ...DEFAULT_COST_VELOCITY_CONFIG,
      ...normalized.detectors?.['cost-velocity'],
    };
  }

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
    // Delete-then-set (rather than a plain `set` on an existing key) so an
    // active scope's key moves to the END of the Map's insertion order —
    // the eviction below removes the FIRST key, i.e. the least-recently-
    // touched scope, making this a real LRU rather than "oldest ever seen".
    this.buffers.delete(key);
    this.buffers.set(key, buffer);
    if (this.buffers.size > this.maxTrackedScopes) {
      const oldestKey = this.buffers.keys().next().value;
      if (oldestKey !== undefined) this.buffers.delete(oldestKey);
    }

    return this.evaluateWindow(scope, buffer, now);
  }

  /**
   * Evaluates a caller-supplied complete trailing window without relying on
   * this process's in-memory buffer. The production HTTP route uses this
   * form: the SDK carries the bounded window with every observation, so two
   * load-balanced control-plane replicas make the same decision instead of
   * splitting one agent's history between process-local Maps.
   */
  evaluateWindow(
    scope: Scope,
    steps: readonly StepObservationWire[],
    now: Date = new Date(),
    detectorOverrides?: DetectorsConfig,
  ): DetectorResult[] {
    const ordered = [...steps]
      .filter((step) => step.timestampMs >= now.getTime() - MAX_BUFFER_AGE_MS)
      .sort((a, b) => a.timestampMs - b.timestampMs)
      .slice(-MAX_BUFFER_SIZE);
    const results = [
      detectLoopSignature(
        scope,
        ordered,
        { ...this.loopConfig, ...detectorOverrides?.['loop-signature'] },
        now,
      ),
      detectContextBloat(
        scope,
        ordered,
        { ...this.contextBloatConfig, ...detectorOverrides?.['context-bloat'] },
        now,
      ),
      detectCostVelocity(
        scope,
        ordered,
        { ...this.costVelocityConfig, ...detectorOverrides?.['cost-velocity'] },
        now,
      ),
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

  /** Test-only introspection: the number of distinct scopes currently
   * tracked, to assert the `MAX_TRACKED_SCOPES` cardinality cap directly
   * rather than inferring it from gauge side effects. */
  get trackedScopeCount(): number {
    return this.buffers.size;
  }

  /** Test-only introspection: whether a given scope still has a tracked
   * buffer, to assert exactly which scope an LRU eviction removed. */
  hasScope(scope: Scope): boolean {
    return this.buffers.has(scopeKey(scope));
  }
}
