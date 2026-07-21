/**
 * DEMO-ONLY, NOT THE PRODUCTION PATH (task.md §2.3 / §3 build-plan Day 1).
 *
 * A crude, deterministic "count calls in a sliding window, trip past N"
 * watcher — the temporary hardcoded trigger used to prove the enforcement
 * path end-to-end before real SigNoz-driven detectors (loop-signature,
 * context-bloat, cost-velocity) exist. Production trips are decided by
 * SigNoz alert rules and the authenticated webhook (task.md §4/§5), never
 * by this in-process counter. Keep this out of the default `@fuse/sdk`
 * import path — it is exported only from `@fuse/sdk/demo`.
 */
export interface DemoThresholdTriggerOptions {
  maxCallsPerWindow: number;
  windowMs: number;
  /** Invokes the real trip operation (e.g. POST /v1/breaker/trip) with a
   * human-readable reason. The trigger itself never touches breaker state
   * directly — it only decides *when* to call this. */
  trip: (reason: string) => Promise<void>;
}

export class DemoThresholdTrigger {
  private readonly timestamps: number[] = [];

  constructor(private readonly options: DemoThresholdTriggerOptions) {}

  /** Call once per completed dispatch. Returns true iff this call caused a
   * trip to be fired (the caller can use this to stop issuing further
   * calls immediately rather than waiting for the next permit check). */
  async recordCall(now: number = Date.now()): Promise<boolean> {
    this.timestamps.push(now);
    const cutoff = now - this.options.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0]! <= cutoff) {
      this.timestamps.shift();
    }
    if (this.timestamps.length > this.options.maxCallsPerWindow) {
      await this.options.trip(
        `demo hardcoded threshold: ${this.timestamps.length} calls within ${this.options.windowMs}ms ` +
          `(limit ${this.options.maxCallsPerWindow})`,
      );
      return true;
    }
    return false;
  }
}
