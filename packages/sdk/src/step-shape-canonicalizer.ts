import { createHmac, randomBytes } from 'node:crypto';

export interface StepShapeInput {
  /** Low-cardinality step kind, such as `analyzer`, `verifier`, or a tool name. */
  kind: string;
  /** Raw text is reduced locally and is never returned by this helper. */
  text: string;
  /** Optional caller-owned structural labels that distinguish real progress. */
  structure?: readonly string[];
}

export interface StepShapeCanonicalizerOptions {
  /** Jaccard similarity required to join an existing local cluster. */
  similarityThreshold?: number;
  /** Bounds retained local clusters and comparison work. Oldest clusters are evicted. */
  maxClusters?: number;
  /** Bounds CPU and memory spent canonicalizing one model result. */
  maxTextLength?: number;
  /** Test/replay key. Omit in production for a random, process-local key. */
  key?: string | Uint8Array;
}

interface Cluster {
  kindHash: string;
  structureHash: string;
  exactHash: string;
  tokenHashes: ReadonlySet<string>;
  tokenCount: number;
  fingerprint: string;
}

const DEFAULT_SIMILARITY_THRESHOLD = 0.65;
const DEFAULT_MAX_CLUSTERS = 256;
const DEFAULT_MAX_TEXT_LENGTH = 32_768;
const MIN_TOKENS_FOR_FUZZY_MATCH = 3;
const MAX_TOKENS_PER_SHAPE = 512;

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'be',
  'before',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'please',
  'that',
  'the',
  'this',
  'to',
  'with',
]);

/**
 * Creates privacy-minimized, bounded step fingerprints for loop detection.
 * Volatile values are normalized first; near-identical text then joins a local
 * token-set cluster. Only a keyed digest leaves this helper. Raw text and raw
 * tokens are neither returned nor retained, although low-entropy fingerprints
 * are still correlation data rather than anonymized data.
 */
export class StepShapeCanonicalizer {
  private readonly clusters: Cluster[] = [];
  private readonly key: string | Uint8Array;
  private readonly similarityThreshold: number;
  private readonly maxClusters: number;
  private readonly maxTextLength: number;

  constructor(options: StepShapeCanonicalizerOptions = {}) {
    this.similarityThreshold =
      options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    this.maxClusters = options.maxClusters ?? DEFAULT_MAX_CLUSTERS;
    this.maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
    this.key = options.key ?? randomBytes(32);

    if (
      !Number.isFinite(this.similarityThreshold) ||
      this.similarityThreshold < 0 ||
      this.similarityThreshold > 1
    ) {
      throw new RangeError('similarityThreshold must be between 0 and 1');
    }
    if (!Number.isInteger(this.maxClusters) || this.maxClusters <= 0) {
      throw new RangeError('maxClusters must be a positive integer');
    }
    if (!Number.isInteger(this.maxTextLength) || this.maxTextLength <= 0) {
      throw new RangeError('maxTextLength must be a positive integer');
    }
  }

  canonicalize(input: StepShapeInput): string {
    const kindHash = this.digest(`kind\0${normalize(input.kind)}`);
    const structureHash = this.digest(
      `structure\0${(input.structure ?? []).map(normalize).join('\0')}`,
    );
    const tokens = tokenize(input.text.slice(0, this.maxTextLength));
    const exactHash = this.digest(`exact\0${tokens.join('\0')}`);
    const tokenHashes = new Set(tokens.map((token) => this.digest(`token\0${token}`)));

    let best: { cluster: Cluster; similarity: number } | undefined;
    for (const cluster of this.clusters) {
      if (cluster.kindHash !== kindHash || cluster.structureHash !== structureHash) {
        continue;
      }
      if (cluster.exactHash === exactHash) return cluster.fingerprint;
      if (
        tokens.length < MIN_TOKENS_FOR_FUZZY_MATCH ||
        cluster.tokenCount < MIN_TOKENS_FOR_FUZZY_MATCH
      ) {
        continue;
      }
      const lengthRatio =
        Math.min(tokens.length, cluster.tokenCount) /
        Math.max(tokens.length, cluster.tokenCount);
      if (lengthRatio < this.similarityThreshold) continue;
      const similarity = jaccard(tokenHashes, cluster.tokenHashes);
      if (
        similarity >= this.similarityThreshold &&
        (best === undefined || similarity > best.similarity)
      ) {
        best = { cluster, similarity };
      }
    }
    if (best) return best.cluster.fingerprint;

    const fingerprint = `shape-v1:${this.digest(
      `cluster\0${kindHash}\0${structureHash}\0${exactHash}`,
    ).slice(0, 24)}`;
    this.clusters.push({
      kindHash,
      structureHash,
      exactHash,
      tokenHashes,
      tokenCount: tokens.length,
      fingerprint,
    });
    if (this.clusters.length > this.maxClusters) this.clusters.shift();
    return fingerprint;
  }

  /** Starts a fresh local clustering window for an execution lifecycle. */
  reset(): void {
    this.clusters.length = 0;
  }

  private digest(value: string): string {
    return createHmac('sha256', this.key).update(value).digest('base64url');
  }
}

function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(
      /\b\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?)?\b/giu,
      ' fusevolatiletime ',
    )
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu, ' fusevolatileid ')
    .replace(/\b[0-9a-hjkmnp-tv-z]{26}\b/giu, ' fusevolatileid ')
    .replace(/\b[0-9a-f]{12,}\b/giu, ' fusevolatileid ')
    .replace(
      /\b(?=[a-z0-9_-]{10,}\b)(?=[a-z0-9_-]*\d)[a-z0-9_-]+\b/giu,
      ' fusevolatileid ',
    )
    .replace(/[+-]?\b\d+(?:[.,]\d+)*(?:e[+-]?\d+)?\b/giu, ' fusevolatilenumber ');
}

function tokenize(value: string): string[] {
  return (normalize(value).match(/[\p{L}\p{N}]+/gu) ?? [])
    .map(stem)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
    .slice(0, MAX_TOKENS_PER_SHAPE);
}

function stem(token: string): string {
  const suffixes = ['ingly', 'edly', 'ing', 'ed', 'ly', 'es', 's'];
  for (const suffix of suffixes) {
    if (token.length - suffix.length >= 4 && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 1 : intersection / union;
}
