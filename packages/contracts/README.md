# `@fuse/contracts`

Runtime-validated, versioned contracts shared by the Fuse control plane and
public SDK. Schemas are Zod schemas; their TypeScript types are inferred from
the same definitions and exported alongside them.

```ts
import { PermitResponseSchema, ScopeSchema } from '@fuse/contracts';

const scope = ScopeSchema.parse({
  tenant: 'acme',
  environment: 'production',
  agentId: 'support-agent',
});

const decision = PermitResponseSchema.parse(await response.json());
```

Detector observations are execution-scoped and pricing-explicit. Every step
must include a bounded `executionId` and one of these truthful pricing shapes:

```ts
import { StepObservationSchema } from '@fuse/contracts';

const step = StepObservationSchema.parse({
  executionId: crypto.randomUUID(),
  timestampMs: Date.now(),
  canonicalShape: 'local-keyed-fingerprint',
  inputTokens: 200,
  outputTokens: 50,
  pricingStatus: 'available',
  estimatedCostUsd: 0.000014,
});
```

Use `pricingStatus: 'unavailable'` with `estimatedCostUsd: null` when no
defensible price exists. Missing execution identity, omitted pricing status,
and the former unscoped detector payload are rejected rather than inferred.

This package is ESM-only and requires Node.js 24 or newer. It is licensed under
Apache-2.0.
