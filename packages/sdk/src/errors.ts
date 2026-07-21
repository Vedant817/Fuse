import type { PermitResponse, Scope } from '@fuse/contracts';

/** Thrown by `FuseGuard.guard()` instead of invoking the wrapped dispatch
 * function, whenever the permit check denies the call. Carries only what a
 * caller needs to log/report the incident — scope, reason, and correlation
 * identifiers — never policy internals or control-plane credentials. */
export class BreakerTrippedError extends Error {
  readonly scope: Scope;
  readonly reason: string;
  readonly correlationId: string;
  readonly state: PermitResponse['state'];
  readonly degraded: boolean;

  constructor(decision: PermitResponse, scope: Scope) {
    super(
      `Fuse breaker denied the call for ${scope.tenant}/${scope.environment}/${scope.agentId}: ${decision.reason}`,
    );
    this.name = 'BreakerTrippedError';
    this.scope = scope;
    this.reason = decision.reason;
    this.correlationId = decision.correlationId;
    this.state = decision.state;
    this.degraded = decision.degraded;
  }
}
