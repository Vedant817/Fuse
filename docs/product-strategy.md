# Fuse Product Strategy

Last reviewed: 2026-08-24. This is a hypothesis document, not customer or
market proof. All competitor references are official sources accessed on the
review date; a missing capability in a cited page is not evidence that a
vendor does not offer it elsewhere.

## Narrow Market Wedge

**Initial ICP:** engineering teams operating autonomous or long-running LLM
agents with repeated model/tool steps, meaningful variable model spend, and an
existing OpenTelemetry or SigNoz practice.

**Economic buyer:** VP/Head of Engineering, AI platform lead, or infrastructure
leader accountable for reliability and cloud/LLM spend.

**Primary user:** AI platform or SRE engineer who instruments agents, owns
incident response, and can enforce a provider-call boundary.

**Triggering event:** an agent loop, context-growth incident, unexpected model
bill, or audit request exposes that dashboards and budgets did not prevent the
next call.

**Wedge:** prove one narrow operational outcome: detect a runaway trace shape,
commit a scope-specific breaker trip, and prevent the next guarded provider
dispatch while preserving evidence and an authorized recovery path.

Fuse should not initially compete as a universal gateway, full observability
suite, prompt platform, or model evaluation platform. It should integrate with
those systems and own the stateful agent-behavior circuit breaker.

## Landscape Matrix

| Product     | Official positioning relevant to Fuse                                               | Likely overlap/substitute                                                                                | Fuse differentiation hypothesis                                                                                       | Official source                                                               |
| ----------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Portkey     | AI gateway with guardrails and operational controls                                 | Gateway-enforced policy and guardrails may satisfy teams already routing all calls through Portkey       | Provider-neutral OTel trace-shape detection and explicit pre-call breaker state outside a required commercial gateway | [Guardrails](https://portkey.ai/docs/product/guardrails)                      |
| LiteLLM     | OpenAI-compatible proxy with virtual keys, budgets, spend tracking, and rate limits | Strong substitute for teams whose failure is solved by static budget/rate policy at a central proxy      | Multi-call behavioral shape and telemetry-confidence state, not only key/user/model budget                            | [Users, budgets and rate limits](https://docs.litellm.ai/docs/proxy/users)    |
| Helicone    | LLM observability with request and user metrics                                     | Analytics and monitoring may identify spend anomalies; customers may build their own response automation | A tested permit/trip/resume control loop with explicit post-trip enforcement proof                                    | [User metrics](https://docs.helicone.ai/features/advanced-usage/user-metrics) |
| Bifrost     | Open-source AI gateway focused on provider access and governance                    | Central gateway policy, routing, and observability can be a deployment substitute                        | OTel-native sidecar/control-plane model aimed at agent execution shape and honest telemetry status                    | [Bifrost](https://www.getmaxim.ai/bifrost/)                                   |
| Langfuse    | Open-source LLM observability for traces, sessions, users, and evaluations          | Existing trace/evaluation platform; teams may alert or automate from its data                            | Enforcement before provider dispatch and durable breaker episodes; potential integration rather than replacement      | [Observability overview](https://langfuse.com/docs/observability/overview)    |
| Braintrust  | Observability for tracing and analyzing AI application behavior                     | Trace inspection and evaluation can support incident diagnosis and regression analysis                   | Runtime circuit breaking and operator recovery, rather than primarily observe/evaluate workflows                      | [Observe](https://www.braintrust.dev/docs/observe)                            |
| Datadog     | LLM Observability integrated into a broad production monitoring platform            | Enterprise monitoring, alerting, and incident workflows are a strong substitute for detection/diagnosis  | Small focused enforcement component that exports to existing observability and proves call prevention                 | [LLM Observability](https://docs.datadoghq.com/llm_observability/)            |
| SigNoz      | Open-source OTel-native LLM observability                                           | Native storage, dashboards, and alerts cover the observability layer                                     | Fuse uses SigNoz as evidence/fallback while adding epoch-safe breaker state and synchronous SDK enforcement           | [LLM Observability](https://signoz.io/docs/llm-observability/)                |
| OpenLLMetry | Open-source OpenTelemetry instrumentation for LLM applications                      | Can solve instrumentation and export without an enforcement product                                      | Fuse consumes structural OTel evidence and adds detection, control state, and recovery                                | [Repository](https://github.com/traceloop/openllmetry)                        |

## Status Quo Alternatives

- Provider hard spend limits or prepaid credit.
- Static maximum iterations, token ceilings, and wall-clock timeouts.
- Gateway per-key budgets and rate limits.
- Application-specific loop counters and kill switches.
- Observability alerts followed by manual shutdown.
- Kubernetes/process termination.
- Human review before high-cost steps.

The pilot must compare against the strongest feasible baseline, especially a
static maximum-iteration limit plus a scoped spend budget. Fuse wins only if
behavioral detection prevents meaningful waste with acceptable false positives
and operational burden.

## Product Principles

1. Enforcement evidence before dashboard breadth.
2. Never report `protected` without telemetry reported through the separate
   exact-scope exporter-evidence capability.
3. Fit existing OTel and gateway stacks rather than require replacement.
4. Keep prompt/tool content out of the default data plane.
5. Make every trip/resume scoped, epoch-bound, and auditable.
6. Separate direct enforcement latency from asynchronous alert latency.
7. Prefer deterministic recommendations before adding an LLM to control flow.

## Pricing Hypotheses

These are interview and pilot hypotheses, not published prices:

| Model                | Hypothesis                                                                                         | Risk to validate                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Open-source core     | SDK, contracts, direct detectors, and self-hosted control plane under Apache-2.0                   | Services may capture value unless operations are meaningfully hard |
| Hosted control plane | Charge by protected agent scope plus included decision/observation volume                          | Scope count may not correlate with value for bursty fleets         |
| Usage tier           | Charge for protected model-call decisions above a base allowance                                   | Can punish customers for adopting protection broadly               |
| Enterprise           | Annual platform fee for SSO/RBAC, policy workflow, retention, HA, support, and compliance evidence | Requires capabilities and support maturity not present today       |
| Outcome anchor       | Price below a conservative fraction of measured avoided spend and operator time                    | Avoided cost is counterfactual and easy to overstate               |

Pilot interviews should test a simple annual platform fee against per-scope and
per-million-decision packaging. Do not price from estimated token savings until
provider invoices and baseline counterfactuals are reconciled.

## Open-Source and Hosted Model

Keep the enforcement protocol, SDK, local control plane, policies, and core
detectors open so teams can inspect the safety boundary and self-host. A hosted
offering could sell operational value: HA state, upgrades, fleet policy,
identity/RBAC, evidence retention, managed connectors, support, and aggregate
quality analytics based only on explicitly agreed data.

Avoid an open-core split that hides the breaker correctness mechanism. Hosted
differentiation should be operation and fleet management, not unverifiable
safety claims.

## Unit-Economics Assumptions

Track these per design partner:

- permit requests and detector reports per protected call;
- PostgreSQL reads/writes, retained audit bytes, and diagnosis-job volume;
- Redis commands;
- OTel egress and SigNoz storage paid by Fuse versus the customer;
- MCP/Slack delivery attempts;
- support and policy-tuning hours;
- gross margin at peak, not only average, traffic;
- avoided provider cost confirmed from invoices, not local price tables.

Hosted gross margin is likely dominated by always-on control-plane/state costs
for small customers and telemetry/evidence operations for large customers. A
credible model needs real pilot distributions for calls per scope, active
scope ratio, incident rate, retention, and support load.

## Validation Milestones

1. Three design partners complete the 30-day pilot with agreed privacy terms.
2. Each provides a baseline and at least one replayed or controlled runaway
   fixture; real incidents are not required or induced.
3. Measure blocked dispatches, false trips, missed fixtures, latency,
   availability impact, and operator time.
4. At least two partners state a buyer, budget source, and acceptable pricing
   unit.
5. One partner runs a production canary with rollback, without claiming broad
   production protection.

Until then, Fuse has a technical wedge and a testable thesis, not proven
product-market fit.
