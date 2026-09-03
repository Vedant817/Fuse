# ADR-014: Authoritative Direct Enforcement with Epoch-Bound SigNoz Fallback

- Status: accepted
- Date: 2026-08-24
- Decider: Vedant817
- Supersedes: ADR-006's claim that SigNoz alert delivery is the primary trip
  trigger; ADR-004's production agent-token scope

## Context

The original hackathon design made a SigNoz alert webhook the first automated
trip source. Live alert cadence was appropriate for asynchronous monitoring but
could not support a reliable "before the next call" claim. The implementation
also evolved from tenant-bound agent credentials to exact
tenant/environment/agent credentials, from app-side telemetry-health inference
to real exporter callbacks, and from non-durable post-trip notification to
a durable PostgreSQL queue.

The architecture needs one unambiguous authority for each concern:

- low-latency detector evaluation and trip commitment;
- independent observability and fallback;
- telemetry-delivery honesty;
- post-trip diagnosis delivery;
- human resume authorization.

## Decision

1. `POST /v1/detectors/observe` is the authoritative automated hot path. The
   SDK sends its complete bounded window; the control plane evaluates it and
   commits a firing trip before acknowledging success.
2. `FuseGuard` checks a fresh permit immediately before every protected
   provider dispatch. A committed trip denies the next guarded callback.
3. SigNoz is asynchronous corroboration and fallback. Detector metrics carry
   the breaker epoch from which they were evaluated. Webhook trips use that
   epoch as an optimistic condition, so delayed alerts cannot affect a later
   episode.
4. Production agent credentials must bind exact tenant, environment, and agent
   ID values. Operator and webhook credentials retain tenant-bound and explicit
   wildcard forms for their supported topologies.
5. Preflight `protected` requires a successful callback from the real OTLP
   trace exporter plus fresh structural evidence, submitted with a separate
   exact-scope exporter-evidence credential. Agent credentials cannot submit
   `exporterDelivery`, and exporter credentials cannot call permit, detector,
   webhook, or operator routes. The bearer token authenticates a capability; it
   is not cryptographic proof or remote attestation of exporter execution.
6. Diagnosis jobs are written transactionally with the trip audit and
   processed through leases, retries, dead-letter state, listing, and audited
   replay.
7. Slack resume requires signature freshness, authorized user/workspace,
   tenant-appropriate operator credentials, and the exact trip epoch.
8. Production rate limiting requires shared Redis and fails closed when its
   storage is unavailable.

## Consequences

- Direct enforcement no longer depends on SigNoz scheduling or delivery.
- SigNoz remains load-bearing for OTel retention, dashboards, fallback alerts,
  and MCP evidence, but its latency is reported independently.
- Detector requests are larger because they carry a bounded window, but can be
  handled by any replica without sticky routing or in-memory history.
- The guarantee remains limited to guarded calls after a committed trip;
  already-permitted in-flight calls can complete.
- A reporting failure in the fail-closed step reporter can stop later guarded
  calls even if PostgreSQL never received the trip, preferring cost safety over
  availability.
- Diagnosis is durable and at-least-once, introducing queue and
  dead-letter operations.
- The supported in-process OTel runtime possesses the exporter credential. A
  fully compromised agent process can therefore forge evidence; deployments
  that include that attacker must isolate the exporter and secret in a separate
  protected process.

## Alternatives Considered

- **Keep SigNoz as the primary trigger.** Rejected because asynchronous alert
  cadence cannot reliably enforce before the next rapid model call.
- **Run detectors only inside each agent.** Rejected because policy, audit,
  state transition, and concurrency authority would fragment across clients.
- **Persist server-side detector windows.** Rejected for the current bounded
  model because it adds write amplification and replica coordination without
  improving correctness.
- **Remove SigNoz alerts entirely.** Rejected because independent
  corroboration/fallback and observability are useful when clearly separated
  from the direct latency claim.
- **Make Preflight blindness auto-trip.** Rejected because telemetry trust and
  agent behavior are separate policy decisions; operators may choose an outage
  mode explicitly.

## Migration

Public docs and demos must describe the direct path first. ADR-006 remains a
historical record of the pinned SigNoz provisioning API, but its trigger-order
language is no longer current. ADR-004 remains valid for operator/webhook
tenant binding; production agent credentials use the stricter exact-scope
rule recorded here.
