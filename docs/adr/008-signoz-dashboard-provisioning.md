# ADR-008: SigNoz dashboard-as-code provisioning (task.md §8)

- Status: accepted
- Date: 2026-07-23
- Deciders: Vedant817 (explicit choice, via delegated senior-engineer agent)

## Context

task.md §8 asks for a real "agent cost health" SigNoz dashboard — panels for
breaker/Preflight status, spend/tokens, cost velocity, detector activity,
and trip history — checked in as reviewable, repeatable rule-as-code, the
same discipline ADR-006 already established for alert rules.

Two new gaps were closed to make the panels this section asks for
representable at all: `fuse.estimated_cost.usd` (task.md §8's "spend by
agent/model") existed only as a **span attribute**
(`packages/otel/src/gen-ai-span.ts`), never aggregated into a metric a
dashboard could query, and Preflight's committed state had no metric at
all. Both are now emitted (`fuse.estimated_cost.usd.total` counter,
`fuse.preflight.state` gauge — see `packages/otel/src/metrics.ts`),
recorded at the same "authoritative decision point" already established
for `fuse.breaker.permit.decisions` (server-side, not per-SDK-instance).

## Decision

### 1. The dashboard payload shape is genuinely different from the alert-rule shape

Alert rules (ADR-006) use the ruler's v5 `RuleCondition.compositeQuery`
envelope (`{type: "builder_query", spec: {...}}`). Dashboards do **not** —
the frontend's own `Widgets.query: Query` type
(`frontend/src/types/api/dashboard/getAll.ts`,
`frontend/src/types/api/queryBuilder/queryBuilderData.ts`, read as raw
source, not guessed) is the older, flatter `IBuilderQuery` shape:

```json
{
  "queryType": "builder",
  "id": "<uuid>",
  "promql": [],
  "clickhouse_sql": [],
  "builder": {
    "queryData": [
      {
        "queryName": "A",
        "dataSource": "metrics",
        "aggregations": [
          {
            "metricName": "...",
            "temporality": "...",
            "timeAggregation": "...",
            "spaceAggregation": "..."
          }
        ],
        "functions": [],
        "filter": { "expression": "..." },
        "groupBy": [{ "key": "..." }],
        "expression": "A",
        "disabled": false,
        "having": [],
        "limit": null,
        "stepInterval": 60,
        "orderBy": [],
        "legend": ""
      }
    ],
    "queryFormulas": [],
    "queryTraceOperator": []
  }
}
```

Two genuinely wrong first attempts, both accepted by the API with a plain
`200`/no validation error yet silently unrendered by the frontend (the
dashboard kept showing its empty "Welcome to your new dashboard" state) —
the exact same trap ADR-006 documents for alert rules, confirmed twice
independently now:

1. The legacy flat shape (`aggregateAttribute`/`aggregateOperator`
   directly on the query, no `functions`/`groupBy`/`having`/`limit`/
   `orderBy` arrays) — missing required array fields the frontend needs
   even though `IBuilderQuery` marks some optional.
2. The **alert-rule's own v5 envelope** (`queries: [{type: "builder_query",
spec: {...}}]`) — a reasonable-looking guess since it's the _correct_
   shape one call site over, but dashboards and alert rules are validated
   by different code paths in this codebase and do not share a query
   schema.

Only reading the actual frontend TypeScript source (not an
AI-summarizing fetch of it, and not the UI clicked through blind) revealed
the real `IBuilderQuery` shape above, which was confirmed by rendering
successfully (a widget that actually shows "No Data" instead of the
dashboard-level "no panels yet" welcome screen).

### 2. A second, entirely separate trap: `PUT` body double-nesting

`PUT /api/v1/dashboards/{id}` accepted a `{"data": <DashboardData>}` body
with `200` and even echoed the submitted widget back in its response —
but a subsequent `GET` on the same dashboard showed `widgets: undefined`.
The real bug: the endpoint stores whatever body it receives verbatim as
`Dashboard.data`, so sending `{"data": dashboardData}` produces
`Dashboard.data.data.title`/`.widgets` — one nesting level too deep. The
correct body is `dashboardData` directly, not wrapped. Found only by
comparing a `PUT` response against an immediate follow-up `GET` in the
same request chain, not by trusting either response in isolation.

### 3. Histogram metrics are stored as separate sub-metric names, not the bare name

`gen_ai.client.token.usage` and `gen_ai.client.operation.duration`
(`packages/otel`'s two histograms) are never queryable under their own
bare metric name — SigNoz's ClickHouse metrics pipeline splits a histogram
into independent `.sum`/`.count`/`.min`/`.max`/`.bucket` metric names.
Querying the bare name renders with an explicit warning ("metric ... has
never been received"), distinct from a genuinely-empty-but-valid query —
useful in hindsight for telling the two failure modes apart quickly.
`infra/signoz/dashboards/fuse-agent-cost-health.json`'s token-usage and
operation-duration panels query `.sum` directly; a true p95/p99 would need
bucket-level histogram math, deliberately deferred (see Consequences).

### 4. Provisioning approach: idempotent update-by-title, not create-if-missing

Like the current `infra/signoz-alerts-up.sh` (update-by-name with round-trip
verification), `infra/signoz-dashboard-up.sh` looks up a dashboard by title and
**always applies** the current
`fuse-agent-cost-health.json` contents to it via `PUT` — panels are
expected to be iterated on, and there is no meaningful "don't touch it,
it might have manual edits" concern for a dashboard whose whole point is
to be rule-as-code.

## Consequences

- Two new OTel instruments exist purely to make dashboard panels
  representable (`fuse.estimated_cost.usd.total`,
  `fuse.preflight.state`) — both recorded server-side in control-plane at
  the same authoritative point their non-metric counterparts already are.
- The dashboard's token/duration panels show totals, not percentiles — an
  honest simplification, not silently presented as p95/p99.
- Live-verified: 4 of 7 panels showed real non-empty data from an actual
  demo run (breaker decisions, Preflight state, detector fired, detector
  score); the remaining 3 (spend, token usage, operation duration) render
  correctly (no schema/"never received" errors) but were empty at
  verification time — the same "needs at least two samples" characteristic
  already documented for cumulative counters elsewhere in this repo, not a
  new defect.
- **Re-verified 2026-07-23** (task.md §11.1's demo rehearsal, via the
  Browser tool against the live dashboard, not just an API check): after
  more real traffic accumulated, 6 of 7 panels now show real data —
  including "Token usage" and "gen_ai operation duration", which were
  empty at initial verification. Only "Estimated spend" still shows an
  honest "No Data" state (no `mock-model-v1` call in this session's runs
  carried a non-zero cost through `packages/otel/src/pricing.ts`) — still
  the correct, non-misleading rendering for a genuinely-absent metric, not
  a regression.
- Not built: dashboard variables (tenant/agent/model dropdowns), a
  projected-monthly-burn formula panel, instrumentation-coverage/orphan-
  rate/drop-rate panels (Preflight's percentages aren't exported as their
  own metrics yet), and trace/log drill-down context links — real, scoped-
  out gaps, tracked in task.md §8, not silently assumed complete.
