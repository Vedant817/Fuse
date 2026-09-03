# Fuse Funding and Technical Diligence

Last updated: 2026-08-24. This document separates implemented evidence from
commercial hypotheses. It contains no customer, revenue, savings, TAM, or
production-usage claim because none has been verified.

## Thesis

Agent infrastructure is moving from request/response applications toward
long-running systems whose failures emerge across many model and tool calls.
Existing observability, gateways, and static budgets are necessary but may not
provide a stateful, behavior-aware, pre-dispatch control loop. Fuse's thesis is
that an inspectable OTel-native breaker can become the safety layer between
agent execution and provider spend.

The initial wedge is deliberately narrow: detect loop signature, context
growth, or abnormal estimated-cost velocity; atomically trip one agent scope;
block the next guarded call; explain and recover with audit evidence.

## Implemented Technical Evidence

- Provider callback wrapped by a fresh pre-call permit.
- Direct bounded-window detector evaluation and trip before acknowledgement.
- Atomic PostgreSQL breaker state, epoch CAS, idempotency, and audit.
- Exact-scope production agent credentials and registered-scope cap.
- Shared production rate limiting through Redis.
- Exporter-confirmed Preflight with ordered evidence and recovery hysteresis.
- Epoch-bound SigNoz fallback that rejects delayed old episodes.
- Durable diagnosis queue with leases, renewal, bounded retry/backoff,
  dead-letter, listing, replay, and replay audit.
- Slack resume with signature freshness, actor/workspace authorization,
  tenant-selectable operator credentials, reason, and trip epoch.
- Seven forward-only migrations and schema-aware readiness.
- Publishable tarball consumer tests for `@fuse/contracts`, `@fuse/otel`, and
  `@fuse/sdk`.
- Unit, real-PostgreSQL/Redis integration, failure-injection, release workflow,
  container, SBOM, and local image evidence recorded in `task.md`.

This is repository evidence, not independent third-party validation. Remote CI,
published package adoption, hosted reliability, and customer production
results must be verified separately.

## Expansion Thesis

If the wedge validates, expansion can proceed without becoming a full gateway:

1. More SDK/runtime integrations and gateway adapters.
2. Shadow-mode policy evaluation and workload-specific baselines.
3. Fleet policy, staged rollout, identity/RBAC, and approval workflow.
4. Managed HA control plane and evidence retention.
5. Detector quality analytics segmented by agent architecture.
6. Additional behavioral controls such as tool-call fanout, retry storms, and
   no-progress execution.
7. Integrations into existing observability and incident platforms.

Expansion should remain anchored to pre-dispatch control and auditable recovery.
Building a general LLM observability UI or universal gateway would dilute the
wedge and enter crowded categories.

## Moat and Data Strategy

Potential moat, not yet established:

- a trusted, provider-neutral enforcement protocol adopted at agent call sites;
- high-quality labeled incident outcomes and policy tuning by workload type;
- operational reliability in races, outages, and recovery;
- integrations across OTel, gateways, frameworks, and incident systems;
- buyer trust from transparent open-source safety mechanics.

Data strategy must be consent-first. Prefer derived structural features and
outcome labels over prompts or tool payloads. Customer data remains isolated by
tenant/scope and is not pooled for training or benchmarking without explicit
written opt-in. Publish aggregate detector benchmarks only when sample size,
selection, labeling, and uncertainty are disclosed.

The open-source core limits code secrecy as a moat. The defensible layer would
need to come from operational excellence, distribution/integration, policy
quality, and ethically acquired incident data.

## Key Risks

| Risk                         | Why it matters                                            | Evidence or next test                                   |
| ---------------------------- | --------------------------------------------------------- | ------------------------------------------------------- |
| Problem frequency            | Runaway incidents may be too rare for a standalone budget | Three design-partner baselines and buyer interviews     |
| Static controls win          | Max iterations/budgets may capture most value             | Pilot head-to-head baseline                             |
| False positives              | Fail-closed trips can harm customer availability          | Shadow/canary labels and workload-segmented quality     |
| Bypass risk                  | Unguarded provider calls invalidate protection            | Integration inventory and runtime canary                |
| Control-plane latency/outage | Every guarded call adds a dependency                      | Production latency/SLO and failure-mode evidence        |
| Crowded adjacency            | Gateways/observability vendors can add controls           | Win/loss interviews and integration-first positioning   |
| Counterfactual ROI           | Avoided cost is difficult to prove                        | Provider invoice reconciliation and conservative ranges |
| Data/privacy                 | Agent telemetry can contain sensitive content             | Contractual schema, processors, retention, audits       |
| Static credentials           | No expiry/online revocation                               | Roadmap to workload identity or short-lived tokens      |
| Operational maturity         | No multi-region/SLA evidence                              | Soak, failover, restore, incident history               |
| Open-source monetization     | Self-hosters may not pay                                  | Hosted operations and enterprise workflow interviews    |

## Commercial Evidence Checklist

Required before claiming repeatable demand:

- [ ] At least three real design partners match the ICP.
- [ ] Signed pilot scope, telemetry/privacy terms, and success criteria.
- [ ] Named user, on-call owner, economic buyer, and budget source per partner.
- [ ] Existing substitute and switching reason documented.
- [ ] Baseline static iteration/budget controls measured.
- [ ] Integration and policy-tuning time measured.
- [ ] Controlled enforcement evidence signed by the partner.
- [ ] False positives, misses, and availability impact reported.
- [ ] Provider invoice reconciliation or explicit inability to reconcile.
- [ ] Willingness-to-pay tested with concrete packaging.
- [ ] At least one production canary with rollback evidence.
- [ ] Referenceability or anonymized evidence permission recorded separately.

Required before claiming enterprise readiness:

- [ ] Independent security review and remediation.
- [ ] Workload identity or documented short-lived credential plan.
- [ ] SLOs backed by production history.
- [ ] Multi-zone failover and PostgreSQL restore rehearsal.
- [ ] Capacity and cost model at representative traffic.
- [ ] Support, escalation, privacy, retention, and deletion procedures.
- [ ] Remote CI/release provenance and registry evidence.
- [ ] Detector benchmark methodology and uncertainty review.

## Diligence Data Room Index

- Product and differentiation: `docs/product-strategy.md`
- Pilot protocol: `docs/design-partner-pilot.md`
- Architecture and ADRs: `docs/architecture.md`, `docs/adr/`
- API: `docs/openapi.yaml`
- Security: `docs/threat-model.md`
- Production operations: `docs/runbooks/`
- Package integration: `packages/sdk/README.md`, `packages/sdk/API.md`
- Historical commands and test evidence: `task.md`
- Change history: `CHANGELOG.md`

## Current Diligence Conclusion

Fuse has a coherent technical prototype with a more defensible enforcement
boundary than an alert-only demo. The next de-risking step is not more feature
breadth. It is independent design-partner evidence that the problem is frequent
and valuable, behavioral detection beats static controls, and the added
control-plane dependency is operationally acceptable.
