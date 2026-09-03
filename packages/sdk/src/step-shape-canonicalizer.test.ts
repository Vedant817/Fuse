import { describe, expect, it } from 'vitest';
import { StepShapeCanonicalizer } from './step-shape-canonicalizer.js';

const OPTIONS = { key: 'deterministic-test-key' } as const;

describe('StepShapeCanonicalizer', () => {
  it('normalizes volatile IDs, numbers, and timestamps', () => {
    const canonicalizer = new StepShapeCanonicalizer(OPTIONS);
    const first = canonicalizer.canonicalize({
      kind: 'analyzer',
      structure: ['draft', 'no-progress'],
      text: 'Draft 17 at 2026-08-24T10:11:12Z for 550e8400-e29b-41d4-a716-446655440000: unchanged answer.',
    });
    const second = canonicalizer.canonicalize({
      kind: 'analyzer',
      structure: ['draft', 'no-progress'],
      text: 'Draft 928 at 2026-09-01T22:03:04Z for 018f3f9a-92c7-7e15-a8d0-3f51e51f423a: unchanged answer.',
    });
    expect(second).toBe(first);
  });

  it('clusters modest wording and ordering changes within the same step structure', () => {
    const canonicalizer = new StepShapeCanonicalizer(OPTIONS);
    const first = canonicalizer.canonicalize({
      kind: 'verifier',
      structure: ['review', 'revision-request'],
      text: 'Needs revision: please reconsider the proposed approach carefully.',
    });
    const second = canonicalizer.canonicalize({
      kind: 'verifier',
      structure: ['review', 'revision-request'],
      text: 'Please reconsider proposed approach; it still needs revision.',
    });
    expect(second).toBe(first);
  });

  it('does not merge genuinely different progress or unrelated noise', () => {
    const canonicalizer = new StepShapeCanonicalizer(OPTIONS);
    const revision = canonicalizer.canonicalize({
      kind: 'verifier',
      structure: ['review', 'revision-request'],
      text: 'Needs revision: reconsider the proposed retry approach.',
    });
    const approval = canonicalizer.canonicalize({
      kind: 'verifier',
      structure: ['review', 'approved'],
      text: 'Approved after bounded retries and cache validation passed.',
    });
    const unrelated = canonicalizer.canonicalize({
      kind: 'verifier',
      structure: ['review', 'revision-request'],
      text: 'Database migration failed because the replica schema is stale.',
    });
    expect(approval).not.toBe(revision);
    expect(unrelated).not.toBe(revision);
  });

  it('keeps low-information collisions scoped by kind and structure', () => {
    const canonicalizer = new StepShapeCanonicalizer(OPTIONS);
    const analyzer = canonicalizer.canonicalize({
      kind: 'analyzer',
      structure: ['draft'],
      text: 'request 123 at 2026-08-24T10:11:12Z',
    });
    const verifier = canonicalizer.canonicalize({
      kind: 'verifier',
      structure: ['review'],
      text: 'request 999 at 2026-09-01T22:03:04Z',
    });
    expect(verifier).not.toBe(analyzer);
  });

  it('returns only a fixed-size keyed fingerprint, never source content', () => {
    const canonicalizer = new StepShapeCanonicalizer(OPTIONS);
    const shape = canonicalizer.canonicalize({
      kind: 'private-customer-review',
      text: 'Customer secret project Apollo request 550e8400-e29b-41d4-a716-446655440000.',
    });
    expect(shape).toMatch(/^shape-v1:[A-Za-z0-9_-]{24}$/u);
    expect(shape).not.toContain('Apollo');
    expect(shape).not.toContain('customer');
    expect(shape).not.toContain('550e8400');
  });

  it('evicts old fuzzy clusters and validates unsafe options', () => {
    const canonicalizer = new StepShapeCanonicalizer({ ...OPTIONS, maxClusters: 1 });
    const first = canonicalizer.canonicalize({
      kind: 'tool',
      text: 'carefully read the source file contents',
    });
    canonicalizer.canonicalize({ kind: 'tool', text: 'execute database migration' });
    expect(
      canonicalizer.canonicalize({
        kind: 'tool',
        text: 'read source file contents carefully',
      }),
    ).not.toBe(first);

    expect(() => new StepShapeCanonicalizer({ similarityThreshold: 1.1 })).toThrow(
      RangeError,
    );
    expect(() => new StepShapeCanonicalizer({ maxClusters: 0 })).toThrow(RangeError);
  });

  it('explicitly resets execution-local clusters', () => {
    const canonicalizer = new StepShapeCanonicalizer(OPTIONS);
    const first = canonicalizer.canonicalize({
      kind: 'analyzer',
      text: 'carefully inspect the current retry response',
    });
    canonicalizer.reset();
    const afterReset = canonicalizer.canonicalize({
      kind: 'analyzer',
      text: 'inspect current retry response carefully',
    });
    expect(afterReset).not.toBe(first);
  });
});
