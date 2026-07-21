import { describe, expect, it, vi } from 'vitest';
import { DemoThresholdTrigger } from './demo-threshold-trigger.js';

describe('DemoThresholdTrigger', () => {
  it('does not fire while the call count stays at or below the threshold', async () => {
    const trip = vi.fn().mockResolvedValue(undefined);
    const trigger = new DemoThresholdTrigger({
      maxCallsPerWindow: 3,
      windowMs: 10_000,
      trip,
    });
    let now = 0;
    for (let i = 0; i < 3; i++) {
      expect(await trigger.recordCall(now)).toBe(false);
      now += 10;
    }
    expect(trip).not.toHaveBeenCalled();
  });

  it('fires exactly once the count exceeds the threshold within the window', async () => {
    const trip = vi.fn().mockResolvedValue(undefined);
    const trigger = new DemoThresholdTrigger({
      maxCallsPerWindow: 3,
      windowMs: 10_000,
      trip,
    });
    let now = 0;
    for (let i = 0; i < 3; i++) {
      await trigger.recordCall(now);
      now += 10;
    }
    const fired = await trigger.recordCall(now);
    expect(fired).toBe(true);
    expect(trip).toHaveBeenCalledOnce();
    expect(trip).toHaveBeenCalledWith(
      expect.stringContaining('demo hardcoded threshold'),
    );
  });

  it('does not re-trip on every subsequent call once already over threshold in the caller logic, but the trigger itself has no memory of "already tripped"', async () => {
    // The trigger is a pure counter — it will call trip() again on the next
    // recordCall() if the caller keeps calling it after a trip. Callers are
    // expected to stop dispatching once `recordCall` returns true (as the
    // guard.integration proof does), not rely on the trigger to self-mute.
    const trip = vi.fn().mockResolvedValue(undefined);
    const trigger = new DemoThresholdTrigger({
      maxCallsPerWindow: 1,
      windowMs: 10_000,
      trip,
    });
    await trigger.recordCall(0);
    const secondFired = await trigger.recordCall(10);
    expect(secondFired).toBe(true);
    expect(trip).toHaveBeenCalledTimes(1);
  });

  it('expires old timestamps outside the window, so a slow trickle never trips', async () => {
    const trip = vi.fn().mockResolvedValue(undefined);
    const trigger = new DemoThresholdTrigger({
      maxCallsPerWindow: 2,
      windowMs: 100,
      trip,
    });
    expect(await trigger.recordCall(0)).toBe(false);
    expect(await trigger.recordCall(50)).toBe(false);
    // This call is far outside the 100ms window relative to the first two,
    // so they should have expired and this must not trip either.
    expect(await trigger.recordCall(1000)).toBe(false);
    expect(trip).not.toHaveBeenCalled();
  });
});
