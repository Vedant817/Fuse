# Fuse Threat Model

Last reviewed: 2026-08-24. This model covers the current control plane, SDK,
PostgreSQL/Redis state, SigNoz fallback, durable diagnosis, and Slack resume.

## Assets

- Breaker state, epoch, policy version, and immutable transition audit.
- Registered tenant/environment/agent scopes.
- Preflight exporter evidence and protection state.
- Diagnosis jobs, leases, errors, and replay audit.
- Operator, exact-scope agent, exact-scope exporter-evidence, webhook, Slack,
  database, Redis, and OTLP credentials.
- Structural OTel data and estimated cost.

Raw prompts, completions, and tool arguments are intentionally outside Fuse's
supplied telemetry schema. Audit reasons remain caller-supplied persisted text.

## Actors and Capabilities

| Actor                                      | Allowed capability                                                      | Boundary                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| Operator token                             | Register, inspect, trip, resume, disable, enable, list/replay diagnosis | Tenant-bound or explicit wildcard                            |
| Agent token                                | Permit, detector observation, Preflight report/status                   | Exact scope required in production                           |
| Exporter-evidence token                    | Preflight exporter evidence only                                        | Separate exact scope required in production                  |
| Webhook token                              | SigNoz trip fallback                                                    | Tenant-bound or explicit wildcard; never resume              |
| Slack user                                 | Open/submit resume modal                                                | Signed, fresh, allowlisted, optional team-bound, epoch-bound |
| Unauthenticated caller                     | Health/readiness only                                                   | Rate-limited by IP                                           |
| PostgreSQL/Redis/OTLP/MCP/Slack dependency | Service-specific state or side effects                                  | Network and credential boundary                              |

Bearer checks use fixed-size SHA-256 digests and constant-time comparison. A
known credential used on the wrong role or scope receives 403; an unknown
credential receives 401.

## Trust Boundaries

### Agent to control plane

The agent chooses structural observations and can cause self-denial by firing a
detector. Production credentials bind the exact scope, the scope must be
operator-registered, request bodies are bounded, and policy is server-resolved.
This prevents one production agent credential from tripping another scope.

Residual risk: a compromised agent can suppress or falsify its own evidence,
bypass `FuseGuard`, or deliberately trip itself. Fuse is not a sandbox inside
the agent process.

### Exporter evidence to control plane

`POST /v1/preflight/report` is a strict structural-observation contract and
rejects `exporterDelivery`. Only `POST /v1/preflight/exporter-evidence` accepts
that field, using a credential class that cannot call permit, detector,
webhook, or operator routes. Production rejects missing, partial, wildcard, or
raw-token-reused exporter credentials. The request scope must exactly match the
credential. Bodies and sample counts are bounded. The existing token-keyed
global limiter includes exporter credentials and uses shared Redis across
production replicas; limiter keys contain only a SHA-256-derived value, never
the bearer token.

Residual trust assumption: bearer possession authenticates the exporter
capability but does not attest which process or code generated the body. The
supported Node OTel runtime is in the agent process and therefore possesses the
exporter credential. A fully compromised agent process can read it and fabricate
success. Process separation helps only when the exporter and credential are
actually isolated from the agent OS identity/container; it does not protect
against compromise of that exporter process, host, or secret manager. Fuse does
not describe this evidence as cryptographic or server-verified delivery.

### SigNoz to webhook

Payloads are untrusted and bounded to 256 KB/200 alerts. Tenant-bound webhook
tokens require one matching tenant across a grouped delivery. Scope labels are
normalized and must reference a registered scope. Server policy controls
cooldown and version.

Freshness, future-clock skew, idempotency, and source breaker epoch are checked.
Alerts with no epoch cannot enforce; delayed alerts cannot target a newer
episode.

Residual risk: SigNoz does not provide an HMAC signature for this webhook
shape. A valid webhook-token holder can mint a fresh, epoch-matching trip
attempt. Its impact is availability/self-denial, not resume or data access.

### Slack to resume

Slack request signing authenticates the raw body. A bounded freshness window
prevents replay. User allowlisting and optional team binding authorize the
human context. The control plane selects an operator credential for the
incident tenant, and the action includes the expected trip epoch.

Residual risk: compromise of the Slack app signing secret plus an authorized
account and usable operator credential can resume. Keep credentials separate,
monitor audit, and prefer tenant-bound operator tokens.

### Control plane to PostgreSQL and Redis

PostgreSQL is authoritative. Breaker transitions use transactions,
idempotency locks, and epoch comparison. The diagnosis job is attached to the
trip audit transaction. Claims use row locks, leases, and ownership checks.
Replay writes a separate immutable audit.

Redis holds shared rate-limit counters only. Production refuses missing or
unreachable Redis at startup; runtime limiter errors fail requests closed.

Residual risk: database administrator compromise can alter all state and audit.
Redis compromise can deny service or weaken rate limiting. Use managed TLS,
least-privilege roles, network isolation, backups, and provider audit logs.

### Control plane to SigNoz MCP and Slack

Diagnosis runs after enforcement. MCP responses are treated as evidence, not
control instructions. Slack blocks and snapshots are deterministically built;
no LLM-generated control action is executed. External failures retry through a
durable queue and can dead-letter.

Residual risk: at-least-once external delivery may duplicate notifications, and
malicious or incorrect SigNoz data can mislead diagnosis. Operators must verify
before resume.

## Data Protection

Supplied spans include provider/model identifiers, scope, correlation IDs,
token counts, outcomes, timing, and estimated cost. Exporter health reports
only field-presence booleans and topology. Detector step shapes should use the
keyed canonicalizer rather than raw text.

Controls:

- no request body logging;
- bounded labels/reasons/identifiers;
- no bearer secrets in rate-limit keys;
- static OTel attribute allowlists;
- incident snapshots on restricted storage;
- explicit retention policy outside this repository.

Audit reasons are the principal free-text persistence surface. Treat them as
non-sensitive operational metadata.

## Abuse Cases and Mitigations

| Abuse case                          | Mitigation                                                       | Residual risk                                          |
| ----------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------ |
| Cross-agent trip/read               | Exact production agent token plus registered scope               | Operator/webhook wildcard credentials have wider scope |
| Old alert re-trips after resume     | Source epoch CAS, freshness, idempotency                         | Fresh forged alert with valid token                    |
| Old Slack card resumes new incident | Expected trip epoch                                              | Authorized current card can still resume incorrectly   |
| Duplicate detector requests         | Deterministic incident identity and store serialization          | Caller may create distinct valid episodes              |
| Scope/metric cardinality attack     | Operator registration and per-tenant cap                         | No public deregistration workflow                      |
| Heavy report DoS                    | Body/sample caps, separate credentials, shared token-keyed limit | Limits are not weighted by endpoint cost               |
| Database outage                     | Readiness, fail-closed default, 503 mutations                    | Agent availability loss                                |
| Diagnosis worker crash              | Durable leases and reclaim                                       | Duplicate external side effect possible                |
| Dead-letter replay abuse            | Operator role, exact scope, manual actor, idempotency and audit  | Compromised operator can replay                        |
| Secret timing/persistence           | Constant-time checks, hashed limiter key, redacted logs          | Static tokens lack expiry                              |

## Security Operations

- Terminate TLS before the control plane; never expose local HTTP publicly.
- Store credentials in a secret manager and rotate with overlap/restart.
- Never inject exporter-evidence credentials into an ordinary agent process if
  the threat model requires protection from full compromise of that process;
  run the exporter under a separate identity and secret boundary.
- Alert on auth failures, unexpected trips/resumes, stale epochs, readiness,
  Redis errors, Preflight blindness, and dead-letter growth.
- Require image digest, provenance/SBOM verification, dependency and container
  scanning, and restore rehearsal before production promotion.
- Review wildcard credentials and `pnpm-workspace.yaml` build-script allowlists
  regularly.

## Open Risks

1. Static bearer credentials have no issuer, expiry, or online revocation.
2. SigNoz webhook delivery lacks payload signing.
3. Global rate limiting is not weighted by endpoint cost.
4. No sustained multi-zone or disaster-recovery evidence exists.
5. Integrator-added OTel attributes can reintroduce sensitive content.
6. Detection quality is not validated on customer workloads.

These risks do not change a committed breaker's transition semantics, but they
affect who can control it, whether detection occurs, and system availability.
See [limitations](./runbooks/limitations.md) and
[incident response](./runbooks/incident-response.md).
