import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DetectorPolicyResolver,
  PolicyNotFoundError,
  loadDetectorPolicyFile,
} from './policy-loader.js';

function policy(
  version: string,
  scope: { tenant: string; environment: string; agentId?: string },
  threshold: number,
) {
  return {
    policyVersion: version,
    scope,
    cooldownSeconds: 30,
    storeOutageMode: 'fail-closed' as const,
    controlPlaneOutageMode: 'fail-closed' as const,
    detectors: {
      'cost-velocity': {
        windowMs: 60_000,
        thresholdUsdPerWindow: threshold,
        minCallsForSignal: 3,
        minElapsedMsForSignal: 2_000,
      },
    },
    notificationRoutes: [],
  };
}

describe('DetectorPolicyResolver', () => {
  it('prefers an exact agent policy over tenant and global wildcards', () => {
    const resolver = new DetectorPolicyResolver([
      policy('global', { tenant: '*', environment: '*' }, 1),
      policy('tenant', { tenant: 't1', environment: 'prod' }, 0.5),
      policy('agent', { tenant: 't1', environment: 'prod', agentId: 'agent-1' }, 0.1),
    ]);

    expect(
      resolver.resolve({ tenant: 't1', environment: 'prod', agentId: 'agent-1' })
        .policyVersion,
    ).toBe('agent');
    expect(
      resolver.resolve({ tenant: 't1', environment: 'prod', agentId: 'agent-2' })
        .policyVersion,
    ).toBe('tenant');
  });

  it('returns the effective outage modes with the detector thresholds', () => {
    const configured = {
      ...policy('fail-open-scope', { tenant: 't1', environment: 'prod' }, 0.5),
      storeOutageMode: 'fail-open' as const,
      controlPlaneOutageMode: 'fail-open' as const,
    };
    const resolved = new DetectorPolicyResolver([configured]).resolve({
      tenant: 't1',
      environment: 'prod',
      agentId: 'agent-1',
    });

    expect(resolved.storeOutageMode).toBe('fail-open');
    expect(resolved.controlPlaneOutageMode).toBe('fail-open');
  });

  it('fails closed when no policy matches', () => {
    const resolver = new DetectorPolicyResolver([
      policy('tenant', { tenant: 't1', environment: 'prod' }, 0.5),
    ]);
    expect(() =>
      resolver.resolve({ tenant: 't2', environment: 'prod', agentId: 'agent' }),
    ).toThrow(PolicyNotFoundError);
  });

  it('rejects duplicate selectors instead of depending on file order', () => {
    expect(
      () =>
        new DetectorPolicyResolver([
          policy('one', { tenant: 't1', environment: 'prod' }, 0.5),
          policy('two', { tenant: 't1', environment: 'prod' }, 0.7),
        ]),
    ).toThrow(/duplicate detector policy selector/);
  });

  it('rejects policies whose detector history cannot fit on the wire', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fuse-policy-test-'));
    const file = path.join(directory, 'policy.json');
    try {
      await writeFile(
        file,
        JSON.stringify({
          ...policy('too-wide', { tenant: '*', environment: '*' }, 0.5),
          detectors: {
            'loop-signature': {
              windowSize: 201,
              minRepetitions: 3,
              maxCycleLength: 4,
            },
          },
        }),
      );
      await expect(loadDetectorPolicyFile(file)).rejects.toThrow(
        /exceed the 200-step wire window/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
