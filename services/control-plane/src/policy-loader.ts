import { readFile } from 'node:fs/promises';
import {
  MAX_STEP_OBSERVATIONS_PER_REQUEST,
  PolicySchema,
  type DetectorsConfig,
  type OutageMode,
  type Policy,
  type Scope,
} from '@fuse/contracts';

export interface ResolvedDetectorPolicy {
  policyVersion: string;
  cooldownSeconds: number;
  storeOutageMode: OutageMode;
  controlPlaneOutageMode: OutageMode;
  detectors: DetectorsConfig;
  notificationRoutes: readonly 'slack'[];
}

export class PolicyNotFoundError extends Error {
  constructor(scope: Scope) {
    super(
      `no detector policy matches ${scope.tenant}/${scope.environment}/${scope.agentId}`,
    );
    this.name = 'PolicyNotFoundError';
  }
}

function selectorKey(policy: Policy): string {
  return `${policy.scope.tenant}\0${policy.scope.environment}\0${policy.scope.agentId ?? '*'}`;
}

function matches(policy: Policy, scope: Scope): boolean {
  return (
    (policy.scope.tenant === '*' || policy.scope.tenant === scope.tenant) &&
    (policy.scope.environment === '*' ||
      policy.scope.environment === scope.environment) &&
    (policy.scope.agentId === undefined ||
      policy.scope.agentId === '*' ||
      policy.scope.agentId === scope.agentId)
  );
}

function specificity(policy: Policy): number {
  return (
    (policy.scope.tenant === '*' ? 0 : 4) +
    (policy.scope.environment === '*' ? 0 : 2) +
    (policy.scope.agentId === undefined || policy.scope.agentId === '*' ? 0 : 1)
  );
}

/** Immutable, startup-validated policy set. Exact scope selectors outrank
 * wildcard selectors; equal-specificity ambiguity is rejected at startup
 * rather than resolved by file order. */
export class DetectorPolicyResolver {
  constructor(private readonly policies: readonly Policy[]) {
    if (policies.length === 0) throw new Error('detector policy file is empty');
    const selectors = new Set<string>();
    for (const policy of policies) {
      const key = selectorKey(policy);
      if (selectors.has(key)) {
        throw new Error(
          `duplicate detector policy selector for ${key.replaceAll('\0', '/')}`,
        );
      }
      selectors.add(key);
    }
  }

  resolve(scope: Scope): ResolvedDetectorPolicy {
    const matchesForScope = this.policies
      .filter((policy) => matches(policy, scope))
      .sort((a, b) => specificity(b) - specificity(a));
    const policy = matchesForScope[0];
    if (!policy) throw new PolicyNotFoundError(scope);
    return {
      policyVersion: policy.policyVersion,
      cooldownSeconds: policy.cooldownSeconds,
      storeOutageMode: policy.storeOutageMode,
      controlPlaneOutageMode: policy.controlPlaneOutageMode,
      detectors: policy.detectors,
      notificationRoutes: policy.notificationRoutes,
    };
  }
}

export async function loadDetectorPolicyFile(
  filePath: string,
): Promise<DetectorPolicyResolver> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`failed to read detector policy file ${filePath}`, { cause: err });
  }
  const rawPolicies = Array.isArray(decoded) ? decoded : [decoded];
  const policies = rawPolicies.map((raw, index) => {
    const parsed = PolicySchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `invalid detector policy at index ${index}: ${parsed.error.message}`,
      );
    }
    const loopWindow = parsed.data.detectors['loop-signature']?.windowSize;
    const context = parsed.data.detectors['context-bloat'];
    if (
      (loopWindow !== undefined && loopWindow > MAX_STEP_OBSERVATIONS_PER_REQUEST) ||
      (context?.minConsecutiveGrowthSteps !== undefined &&
        context.minConsecutiveGrowthSteps > MAX_STEP_OBSERVATIONS_PER_REQUEST) ||
      (context?.minStepsRequired !== undefined &&
        context.minStepsRequired > MAX_STEP_OBSERVATIONS_PER_REQUEST)
    ) {
      throw new Error(
        `invalid detector policy at index ${index}: detector history requirements exceed the ${MAX_STEP_OBSERVATIONS_PER_REQUEST}-step wire window`,
      );
    }
    return parsed.data;
  });
  return new DetectorPolicyResolver(policies);
}
