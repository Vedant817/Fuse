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
} from '@fuse/detectors';
import { getDetectorFiredGauge, getDetectorScoreGauge } from '@fuse/otel';

const MAX_BUFFER_SIZE = 500;
const MAX_BUFFER_AGE_MS = 60 * 60 * 1000;

/**
 * Evaluates the caller-carried complete trailing window. The runner keeps no
 * process-local history, so any control-plane replica makes the same decision
 * for the same request and policy.
 */
export class DetectorRunner {
  evaluateWindow(
    scope: Scope,
    steps: readonly StepObservationWire[],
    sourceEpoch: number,
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
        {
          ...DEFAULT_LOOP_SIGNATURE_CONFIG,
          ...detectorOverrides?.['loop-signature'],
        },
        now,
      ),
      detectContextBloat(
        scope,
        ordered,
        {
          ...DEFAULT_CONTEXT_BLOAT_CONFIG,
          ...detectorOverrides?.['context-bloat'],
        },
        now,
      ),
      detectCostVelocity(
        scope,
        ordered,
        {
          ...DEFAULT_COST_VELOCITY_CONFIG,
          ...detectorOverrides?.['cost-velocity'],
        },
        now,
      ),
    ];
    for (const result of results) {
      const attrs = {
        'fuse.detector': result.detector,
        'fuse.tenant': scope.tenant,
        'fuse.environment': scope.environment,
        'fuse.agent_id': scope.agentId,
        'fuse.source_epoch': String(sourceEpoch),
      };
      getDetectorScoreGauge().record(result.score, attrs);
      getDetectorFiredGauge().record(result.fired ? 1 : 0, attrs);
    }
    return results;
  }
}
