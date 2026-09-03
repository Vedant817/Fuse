import type { PermitResponse, Scope } from '@fuse/contracts';

/** Thrown by `FuseGuard.guard()` instead of invoking the wrapped dispatch
 * function whenever either the permit check or the local fail-closed
 * protection latch denies the call. Carries only what a caller needs to
 * handle/report the incident — never policy internals or credentials. */
export class BreakerTrippedError extends Error {
  readonly scope: Scope;
  readonly reason: string;
  readonly correlationId: string;
  readonly state: PermitResponse['state'];
  readonly degraded: boolean;
  readonly code: 'breaker_denied' | 'detector_reporting_unavailable';
  readonly action: string;

  constructor(
    decision: PermitResponse,
    scope: Scope,
    code: 'breaker_denied' | 'detector_reporting_unavailable' = 'breaker_denied',
  ) {
    super(
      `Fuse ${code === 'detector_reporting_unavailable' ? 'protection' : 'breaker'} denied the call for ${scope.tenant}/${scope.environment}/${scope.agentId}: ${decision.reason}`,
    );
    this.name = 'BreakerTrippedError';
    this.scope = scope;
    this.reason = decision.reason;
    this.correlationId = decision.correlationId;
    this.state = decision.state;
    this.degraded = decision.degraded;
    this.code = code;
    this.action =
      code === 'detector_reporting_unavailable'
        ? 'Restore detector reporting to the Fuse control plane, then retry the guarded call.'
        : decision.degraded
          ? 'Restore control-plane connectivity, then retry the guarded call.'
          : 'Inspect the breaker incident and resume the scoped breaker before retrying.';
  }
}
