import { randomUUID } from 'node:crypto';
import {
  PermitResponseSchema,
  type OutageMode,
  type PermitResponse,
  type Scope,
} from '@fuse/contracts';
import { BreakerTrippedError } from './errors.js';

export interface PermitDecisionTelemetry {
  scope: Scope;
  correlationId: string;
  allowed: boolean;
  state: PermitResponse['state'];
  degraded: boolean;
  latencyMs: number;
  reason: string;
}

export interface FuseGuardOptions {
  scope: Scope;
  controlPlaneUrl: string;
  apiToken: string;
  /** Deadline for the permit check itself, not for the wrapped call. */
  timeoutMs?: number;
  /** Behavior when the control plane cannot be reached at all (network
   * error, timeout, non-2xx, malformed response) within `timeoutMs`. This
   * is the SDK-side fallback and is distinct from the control plane's own
   * `storeOutageMode`, which governs what happens when the control plane
   * itself can reach the SDK but not its store. */
  outageMode?: OutageMode;
  fetchImpl?: typeof fetch;
  onDecision?: (event: PermitDecisionTelemetry) => void;
}

const DEFAULT_TIMEOUT_MS = 300;

export class FuseGuard {
  private readonly options: Required<Omit<FuseGuardOptions, 'onDecision'>> & {
    onDecision: FuseGuardOptions['onDecision'];
  };

  constructor(options: FuseGuardOptions) {
    this.options = {
      scope: options.scope,
      controlPlaneUrl: options.controlPlaneUrl.replace(/\/+$/, ''),
      apiToken: options.apiToken,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      outageMode: options.outageMode ?? 'fail-closed',
      fetchImpl: options.fetchImpl ?? fetch,
      onDecision: options.onDecision,
    };
  }

  /**
   * Checks a permit immediately before invoking `dispatch`. If the permit
   * is denied, `dispatch` is never called and a `BreakerTrippedError` is
   * thrown instead. There is no local caching or pre-check optimization
   * that could let a call skip this step — every guarded call performs a
   * fresh permit check against the control plane.
   */
  async guard<T>(
    dispatch: () => Promise<T>,
    correlationId: string = randomUUID(),
  ): Promise<T> {
    const start = performance.now();
    const decision = await this.checkPermit(correlationId);
    const latencyMs = performance.now() - start;
    this.options.onDecision?.({
      scope: this.options.scope,
      correlationId,
      allowed: decision.allowed,
      state: decision.state,
      degraded: decision.degraded,
      latencyMs,
      reason: decision.reason,
    });
    if (!decision.allowed) {
      throw new BreakerTrippedError(decision, this.options.scope);
    }
    return dispatch();
  }

  private async checkPermit(correlationId: string): Promise<PermitResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const res = await this.options.fetchImpl(
        `${this.options.controlPlaneUrl}/v1/permit`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.options.apiToken}`,
          },
          body: JSON.stringify({ scope: this.options.scope, correlationId }),
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        return this.degradedDecision(
          correlationId,
          `control plane returned HTTP ${res.status}`,
        );
      }
      const parsed = PermitResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        return this.degradedDecision(
          correlationId,
          'control plane returned a malformed permit response',
        );
      }
      return parsed.data;
    } catch (err) {
      return this.degradedDecision(
        correlationId,
        `control plane unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private degradedDecision(correlationId: string, reason: string): PermitResponse {
    return {
      allowed: this.options.outageMode === 'fail-open',
      state: 'unknown',
      reason: `${reason}; applying configured SDK outage mode (${this.options.outageMode})`,
      epoch: -1,
      degraded: true,
      correlationId,
    };
  }
}
