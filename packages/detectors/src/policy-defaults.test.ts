import { describe, expect, it } from 'vitest';
import {
  ContextBloatDetectorConfigSchema,
  CostVelocityDetectorConfigSchema,
  LoopSignatureDetectorConfigSchema,
} from '@fuse/contracts';
import { DEFAULT_CONTEXT_BLOAT_CONFIG } from './context-bloat.js';
import { DEFAULT_COST_VELOCITY_CONFIG } from './cost-velocity.js';
import { DEFAULT_LOOP_SIGNATURE_CONFIG } from './loop-signature.js';

/**
 * `@fuse/contracts`'s `*DetectorConfigSchema` defaults and this package's own
 * `DEFAULT_*_CONFIG` constants are two independently-maintained sources of
 * truth (see the doc comment on `DetectorsConfigSchema` in
 * `packages/contracts/src/policy.ts` for why they aren't unified into one).
 * That independence is only safe if drift between them fails a test instead
 * of failing silently — a policy file's "default" detector config would
 * otherwise quietly stop matching what the detector functions actually use.
 */
describe('detector config defaults stay in sync with @fuse/contracts', () => {
  it('loop-signature', () => {
    const parsed = LoopSignatureDetectorConfigSchema.parse({});
    expect(parsed).toEqual(DEFAULT_LOOP_SIGNATURE_CONFIG);
  });

  it('context-bloat', () => {
    const parsed = ContextBloatDetectorConfigSchema.parse({});
    expect(parsed).toEqual(DEFAULT_CONTEXT_BLOAT_CONFIG);
  });

  it('cost-velocity', () => {
    const parsed = CostVelocityDetectorConfigSchema.parse({});
    expect(parsed).toEqual(DEFAULT_COST_VELOCITY_CONFIG);
  });
});
