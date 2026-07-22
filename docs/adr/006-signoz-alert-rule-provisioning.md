# ADR-006: SigNoz alert-rule provisioning (closing the §4.5 "Detect" gap)

- Status: accepted
- Date: 2026-07-22
- Deciders: Vedant817 (explicit choice, via delegated senior-engineer agent)

## Context

A prior gap review found that `packages/detectors` (loop-signature, context-bloat,
cost-velocity) existed as a well-tested pure-function library, but nothing in
`services/control-plane` ever called it, and no real SigNoz alert rule had
ever been created — task.md §4.5 was entirely unchecked. The brief's stated
architecture is explicit: *"SigNoz alerting is the trigger — wire alert rules
to the enforcement webhook."* The webhook itself (§5.1) was already built and
tested, but only ever driven by synthetic, hand-crafted Alertmanager-shaped
HTTP payloads — never by a real SigNoz alert rule evaluating real ingested
telemetry.

A previous session's open-blockers note recorded this as stuck: *"the SigNoz
UI's session-based auth API was not reverse-engineered (tried `/api/v1/login`
and `/api/v2/sessions`, both fell through to the SPA route)."* That blocker is
now resolved — see below — which unblocks rule-as-code provisioning.

There is also a known, real upstream bug worth naming explicitly:
[SigNoz/signoz#10823](https://github.com/SigNoz/signoz/issues/10823) reports
that alert rules created via the API using the legacy `builderQueries` (v4,
map-shaped) field silently never fire, because the ruler's v5 evaluation path
only reads the `queries` (array-shaped) field. Any rule this repository
provisions must use the `queries` array field, never `builderQueries`.

## Decision

### 1. Non-interactive auth (reverse-engineered against the real running instance, v0.133.0)

The actual login flow, confirmed by watching the real browser network traffic
(not guessed from stale/generic docs):

1. `GET /api/v2/sessions/context?email=<email>&ref=<any-url>` → `{data:{orgs:[{id, authNSupport}]}}`.
   Resolves the org ID an email belongs to; required before login.
2. `POST /api/v2/sessions/email_password` with
   `{email, password, orgID}` → `{data:{accessToken, refreshToken, expiresIn}}`
   (a bearer JWT, `expiresIn` ~1799s).
3. Use `Authorization: Bearer <accessToken>` on all subsequent `/api/v1/*` and
   `/api/v2/*` calls.

`/api/v1/login`, `/api/v2/login`, and several other guessed paths all return
HTTP 200 with the SPA's `index.html` (not a 404/405) — a trap: they look
plausible but are simply unmatched routes falling through to the frontend
catch-all. The only reliable way to find the real route was to drive the
actual login form once and read the network log, not to guess REST-ish paths
or trust generic web search summaries of SigNoz's docs (several 404'd or gave
subtly wrong/incomplete field names when fetched through a summarizing tool
rather than read as raw source).

### 2. Alert-rule payload shape (`POST /api/v2/rules`)

Confirmed by reading the actual pinned-version (`v0.133.0`) Go source
(`pkg/types/ruletypes/*.go`, `pkg/types/querybuildertypes/querybuildertypesv5/*.go`)
fetched as raw files — not through an AI-summarizing fetch, which was tried
first and produced subtly incomplete/wrong generic-shaped structs for the
generic `QueryBuilderQuery[T]` type. A minimal working `threshold_rule`,
schema version `v1` (the default — legacy top-level `condition.op`/`target`/
`matchType`, not the newer per-threshold `condition.thresholds` shape, which
requires `schemaVersion: v2alpha1` and is not needed here):

```json
{
  "alert": "<name>",
  "alertType": "METRIC_BASED_ALERT",
  "ruleType": "threshold_rule",
  "evalWindow": "1m",
  "frequency": "1m",
  "condition": {
    "compositeQuery": {
      "queryType": "builder_query",
      "panelType": "graph",
      "queries": [
        {
          "type": "builder_query",
          "spec": {
            "name": "A",
            "signal": "metrics",
            "stepInterval": "60s",
            "aggregations": [
              {
                "metricName": "<metric>",
                "temporality": "unspecified",
                "timeAggregation": "latest",
                "spaceAggregation": "max"
              }
            ]
          }
        }
      ]
    },
    "selectedQueryName": "A",
    "op": "above",
    "target": <number>,
    "matchType": "at_least_once"
  },
  "labels": { "severity": "warning" },
  "annotations": { "summary": "..." },
  "disabled": false,
  "preferredChannels": ["<channel-name>"]
}
```

Verified live end-to-end: this exact shape (with `queries` as an array,
per the #10823 warning above) round-trips through `POST /api/v2/rules` (201,
echoes back the stored `queries` array intact) and is queryable via
`POST /api/v5/query_range` using the same `compositeQuery` shape.

**Metric type decision:** the detector-runner (§4, separate slice) emits
**gauge** metrics (`temporality: "unspecified"`), not counters, specifically
so the alert condition can use `timeAggregation: "latest"` /
`spaceAggregation: "max"` — a trivially-correct "is the most recent reported
score above threshold" check. A monotonic counter (like the pre-existing
`fuse.breaker.permit.decisions`) needs `timeAggregation: "increase"` or
`"rate"`, which returns 0 for a brand-new series until it has at least two
samples to diff against — correct behavior, but an unnecessary source of
demo-timing flakiness for a value we control the shape of.

### 3. Notification channel payload shape (`POST /api/v1/channels`)

```json
{
  "name": "<channel-name>",
  "type": "webhook",
  "webhook_configs": [
    {
      "url": "<control-plane-webhook-url>",
      "send_resolved": true,
      "http_config": {
        "authorization": { "credentials": "<webhook-bearer-token>" }
      }
    }
  ]
}
```

Note the top-level `webhook_configs` key (not nested under a `data` string
field, which the UI's own request happens to also send as a JSON string —
either shape is accepted; top-level is simpler to construct). `http_config.
authorization.credentials` becomes a real `Authorization: Bearer <token>`
header on delivery — verified against control-plane's `requireBearerAuth`,
which only accepts `Bearer`, not HTTP Basic Auth (SigNoz supports both; this
repo's webhook route only implements Bearer, so `authorization`, not
`basic_auth`, must be used).

### 4. Idempotent provisioning approach

Following the existing `infra/signoz-up.sh` convention (fixed local-dev
identity, safe to re-run), alert-rule and channel provisioning is scripted
rather than clicked, checked into `infra/`, and treated as declarative
config applied against a running instance — not stored as SigNoz's own
generated/exported artifacts (which are runtime state, analogous to
`infra/signoz/pours/`, not hand-edited or committed).

## Consequences

- Alert-rule creation no longer depends on reverse-engineering the UI's
  session auth per-session; the login flow above is stable and scriptable.
- The detector-runner's metrics must be gauges to keep alert conditions
  simple and immediately-correct; this constrains §4's implementation but
  was already the natural design (a detector's `score` is a point-in-time
  evaluation result, not a monotonically accumulating count).
- This ADR's exact JSON shapes are pinned to SigNoz `v0.133.0`
  (`signoz/signoz:v0.133.0` per ADR-005) and may need re-verification against
  a future SigNoz upgrade — the same discipline ADR-005 already applies to
  image versions.
