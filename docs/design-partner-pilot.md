# Fuse 30-Day Design-Partner Pilot

This pilot validates technical safety and buyer value without claiming that
Fuse is already proven in production. It uses a canary scope first and never
introduces synthetic runaway behavior into customer production traffic.

## Entry Criteria

- A named engineering owner, SRE/on-call owner, security/privacy reviewer, and
  economic buyer.
- A Node.js agent with a clearly identified provider-dispatch boundary.
- OTel export available or permission to deploy it.
- A non-production replay fixture for loop, context growth, or cost velocity.
- Agreement on outage mode, rollback, data fields, retention, and incident
  contacts.
- A baseline period or historical data sufficient to compare static controls.

## Data and Privacy Agreement

Before installation, sign off on:

- exact tenant/environment/agent scope identifiers;
- structural fields collected: provider/model, timestamps, token counts,
  estimated cost, canonical step shape, detector measurements, decisions;
- explicit exclusion of raw prompts, completions, tool arguments, secrets, and
  personal data from Fuse-managed telemetry;
- customer-added OTel processors/attributes outside Fuse's control;
- where PostgreSQL, Redis, SigNoz, snapshots, and Slack data reside;
- retention and deletion periods for audit, diagnosis, and telemetry;
- authorized users and incident escalation;
- whether aggregate, de-identified detector outcomes may be used for product
  improvement; default is no reuse without written opt-in.

Audit reasons must be operational metadata and must not quote customer content.

## Day 0-5: Baseline and Design

1. Map every model-provider dispatch and identify bypass risks.
2. Record existing maximum iterations, wall-clock timeout, spend budget, rate
   limit, and manual kill-switch behavior.
3. Select one canary agent scope and issue an exact-scope credential.
4. Choose fail-open or fail-closed separately for SDK and store outages, with
   an approved availability rationale.
5. Define detector policy and notification routes.
6. Record baseline metrics for at least the available historical window.
7. Run threat-model and rollback review.

Baseline minimum: implement or document a static maximum-iteration cap plus a
maximum estimated-spend/token budget. Fuse must be compared to this practical
alternative, not to having no controls.

## Day 6-10: Non-Production Integration

1. Wrap the provider callback with `FuseGuard`.
2. Register the canary scope and verify wrong-scope credentials receive 403.
3. Install `bootstrapFuseOtel`; verify exporter-reported Preflight state through
   its separate exact-scope credential.
4. Run the three deterministic fixtures.
5. Prove the next guarded callback remains at zero after each committed trip.
6. Inject control-plane, PostgreSQL, Redis, OTLP, MCP, and Slack failures.
7. Exercise diagnosis dead-letter listing/replay and stale-epoch rejection.
8. Rehearse rollback to the unguarded baseline only in non-production.

Exit gate: no unknown provider bypass, all safety tests pass, and customer
owners approve the policy and outage behavior.

## Day 11-20: Production Canary

1. Deploy to one low-risk scope with conservative policy.
2. Keep existing static iteration/budget controls active.
3. Monitor permit latency/errors, Preflight, detector scores, breaker events,
   Redis/PostgreSQL health, diagnosis backlog, and provider call counts.
4. Require human resume; no automatic alert-resolution resume.
5. Review every trip within one business day and label true positive, false
   positive, indeterminate, or test.
6. Hold a midpoint review with engineering, on-call, and buyer.

Do not intentionally trigger a costly production runaway. Use controlled
replay, shadow evaluation, or a capped canary fixture.

## Day 21-30: Expansion Decision

1. Compare Fuse with the static baseline.
2. Review misses, false positives, availability impact, and operator load.
3. Reconcile estimated avoided spend against provider billing where possible.
4. Test one additional scope only if the canary exit gates remain green.
5. Conduct buyer interview and pricing-unit test.
6. Produce a signed pilot report with evidence and limitations.

## Metrics

| Dimension    | Metric                                                                            |
| ------------ | --------------------------------------------------------------------------------- |
| Enforcement  | Guarded dispatches attempted after trip; provider callbacks invoked after trip    |
| Detection    | Fixture true positives, fixture misses, production true/false/indeterminate trips |
| Latency      | Observation-to-commit, permit p50/p95/p99, SigNoz fallback latency separately     |
| Availability | Calls denied due to dependency outage, 429s, readiness downtime                   |
| Telemetry    | Time protected/degraded/blind, exporter failures, last-good age                   |
| Operations   | Mean time to diagnose/resume, dead letters, replay count, duplicate notifications |
| Cost         | Provider spend before/after, estimated prevented calls, reconciled avoided cost   |
| Adoption     | Integration hours, policy-tuning hours, scopes retained/expanded                  |

## ROI Formula

Use a range, not a single invented number:

```text
monthly benefit =
  reconciled avoided provider cost
  + (operator hours avoided * fully loaded hourly cost)
  - availability cost caused by false trips or fail-closed outages

monthly net value = monthly benefit - Fuse software and operating cost
ROI = monthly net value / Fuse software and operating cost
```

For counterfactual avoided cost, report conservative/expected/high cases. Count
a prevented call only when a guarded provider callback was attempted after a
committed trip and remained uninvoked. Do not extrapolate controlled fixtures
to annual savings without observed incident frequency.

## Exit Criteria

Technical pass:

- zero provider callbacks after committed trip in all controlled guarded tests;
- no unidentified provider bypasses in the pilot scope;
- documented in-flight exposure accepted;
- exporter-role-reported Preflight and alerting work;
- no unresolved high-severity security finding;
- rollback and credential rotation rehearsed;
- diagnosis dead letters are visible and replayable.

Product pass:

- customer rates the problem as recurring or materially risky;
- Fuse adds measurable value beyond static maximum iterations/budgets;
- false-positive and availability burden is acceptable to on-call;
- named buyer identifies a budget source and plausible paid next step;
- customer permits a factual reference or anonymized evidence, if separately
  agreed.

Stop or redesign if provider paths cannot be guarded, telemetry cannot be kept
free of prohibited content, false trips create unacceptable availability risk,
or the static baseline captures nearly all value at much lower complexity.

## Final Report

The partner and Fuse owner sign a report containing topology, versions,
policies, commands/tests, incidents, metrics, invoice reconciliation method,
security/privacy exceptions, open risks, rollback evidence, and a go/no-go
decision. Marketing use requires separate written approval.
