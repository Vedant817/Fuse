# Fuse — a cost circuit breaker for AI agents, powered by SigNoz

**SigNoz Hackathon · Track 01 (AI & Agent Observability) · Jul 20–26, 2026**

> Every agent observability tool tells you what an agent *already* spent.
> **Fuse** reads SigNoz telemetry to catch a runaway agent by its trace shape,
> trips a breaker that pauses it **before** the next expensive call, then
> diagnoses why and suggests the fix — and it won't promise protection it
> can't actually deliver.

---

## 1. The problem worth betting on

The dominant operational failure of production agents in 2026 is not
hallucination — it is **runaway cost**, and the industry only just woke up to it.
Reported cases circulate widely: a multi-agent loop that burned tens of
thousands of dollars over days before anyone noticed; companies blowing through
annual AI budgets in a quarter; the FinOps Foundation reporting that the vast
majority of practices now manage AI spend, up sharply in two years.

> **Credibility note:** use these figures for narrative energy, but attribute
> them loosely ("reported cases like…"). Several circulate in blog posts and may
> be exaggerated. Don't let a skeptical judge nuke your credibility over one
> number — the *pattern* is what's real and defensible.

Two facts make this an **observability** play, not just a FinOps one:

1. **The failure is invisible to normal monitoring.** LLM calls are I/O-bound,
   so CPU and memory stay flat. Only per-cycle token/cost tracking reveals the
   anomaly. Traditional infra monitoring misses agent cost spirals entirely.
2. **The tools that track cost stop at tracking.** Langfuse, Datadog LLM,
   Helicone, Braintrust, SigNoz today — all sit on the *observe* side of the
   line. Postmortems keep repeating the same lesson: *tracking what you spent is
   not the same as controlling what you'll spend next.*

**Nobody in the open-source OTel world closes the loop from signal → action.**
That is the whitespace.

---

## 2. Why a breaker, not a dollar cap

A flat spend cap at the gateway can't tell a legitimate long-running task from a
pathological loop, so it kills good work too. The **trace shape** can. SigNoz
already holds the full agent execution — step chains, tool calls, retries,
per-step token counts — so Fuse trips on the *pathology signature*, not just a
number:

- **Loop signature** — near-identical spans repeating (the Analyzer↔Verifier
  ping-pong: plan → call → 429 → replan → call, thousands of times/hour, the
  agent having no concept of its own cumulative cost).
- **Context bloat** — input tokens growing every step because a 100K-token
  history costs 100K input tokens on *every* subsequent call.
- **Cost velocity spike** — $/min crossing a learned baseline (e.g. an API
  format change driving many times the baseline token rate).

That's the creativity hook: **observability that acts.** It reframes SigNoz from
a dashboard you have to remember to check into a nervous system with a reflex.

---

## 3. The integrated addition: Preflight (telemetry health as a precondition)

*Borrowed from the "telemetry trust" thesis — the one piece worth taking.*

A breaker is only as good as the telemetry feeding it. If an agent's `gen_ai`
spans lose token counts, or a release silently drops cost fields, Fuse's
detection fails **quietly** and gives false confidence while the meter runs.

So before Fuse claims to protect an agent, **Preflight** verifies that agent is
emitting the fields Fuse depends on:

- required `gen_ai` attributes present (model, token counts, cost)
- step-chain / parent-span propagation intact (no orphan spans)
- cost/velocity metrics actually flowing

If coverage degrades, **Fuse alerts on itself**: *"Protection degraded for
payment-agent — token spans missing since build abc123. Breaker is blind."*
This is a small, contained check — **not** a full contract/CI/Trust-Score
product — and it directly strengthens the core thesis: *a breaker you can't
trust is worse than no breaker.* It also gives the demo a second beat.

---

## 4. The closed loop, concretely

```
Preflight   Can I even protect this agent? (required gen_ai fields present?)
   │           → if not, alert: "protection blind"
   ▼
Sense       OTel gen_ai spans + metrics  ──►  SigNoz
   ▼
Detect      SigNoz alert on loop-signature / cost-velocity / context-bloat
   ▼
Enforce     webhook trips a lightweight breaker in the agent's LLM-call
            middleware; the NEXT call is paused, not placed   ◄── the novel core
   ▼
Diagnose    agent uses SigNoz MCP to pull the offending traces, writes postmortem
   ▼
Recommend   Slack card + optional PR (prompt caching, dedup history, cost ceiling)
   ▼
Resume      on human or policy approval
```

---

## 5. How it leans on *all* of SigNoz (the "Best Use of SigNoz" score)

| SigNoz surface | Role in Fuse |
|---|---|
| **Traces** | the sensor — `gen_ai` spans carry step chain + per-call tokens; pattern detection reads trace structure |
| **Metrics** | token/cost counters + histograms (OTel `gen_ai` semantic conventions) plus a derived cost-velocity metric |
| **Alerts** | SigNoz alerting **is** the trigger — wire alert rules to the enforcement webhook (using SigNoz as designed, just extending where the alert goes) |
| **Logs** | the breaker writes structured trip events back as logs, so enforcement is itself observable |
| **Dashboards** | an "agent cost health" board: spend by agent/user/task, live cost velocity, breaker trip history, projected monthly burn, **+ Preflight coverage** |
| **MCP** | the diagnosis half — on a trip, an agent pulls traces via SigNoz MCP, generates root cause + fix, optionally opens a PR |

Most builds touch only dashboards. Fuse uses the full stack as one loop.

---

## 6. Adoption / UX — the "would people use this daily?" test

Fuse is **set-and-forget infrastructure.** You point your agents' OTel export at
SigNoz (which you're doing anyway), write one budget/policy file, and it runs as
a guardrail forever. No new dashboard to babysit. It interrupts you only when it
saves you money — one Slack card. That passive-until-needed model is the opposite
of most observability tools, which demand attention to deliver value, and it's
what makes Fuse stick.

---

## 7. Build plan (Jul 20–26) — **breaker-first ordering**

> Reordered deliberately: the **Enforce** step is the riskiest, most novel part
> *and* the whole thesis. Prove it works before polishing anything else. If the
> breaker doesn't visibly pause a real call in the demo, Fuse collapses into
> "yet another dashboard."

- **Day 1 — Prove the breaker.** Build the breaker middleware: a token/cost
  counter + loop detector that intercepts the *pre-call* and can pause a real
  LLM call. Get it tripping on a hardcoded threshold first. This de-risks
  everything.
- **Day 2 — Broken agent + sensing.** Build the *deliberately broken* two-agent
  ping-pong loop (mirror a **real workflow you actually operate** — authenticity
  lifts Impact + UX). Instrument it with OTel `gen_ai` conventions → SigNoz;
  stand up the FinOps dashboard.
- **Day 3 — Detection + Preflight.** Move detection into SigNoz alert rules
  (loop-signature / cost-velocity / context-bloat) wired to the breaker webhook.
  Add the Preflight coverage check + "protection blind" alert.
- **Day 4 — Diagnose.** SigNoz MCP reads the offending traces → Slack incident
  card with root cause and suggested fix (+ optional PR).
- **Day 5 — Polish.** Before/after demo, README, 2-minute video.

**Demo script that sells itself:** launch the broken agent → cost line climbs
live in SigNoz → Fuse trips, the agent halts at ~$0.50 instead of a five-figure
runaway → Slack card lands: *"Tripped: Analyzer↔Verifier loop, 4,800 iters/hr,
no cumulative-cost bound. Fix: add session cost ceiling + prompt caching. PR
opened."* Then a second beat: **break the telemetry**, and show Fuse catching
its own blind spot via Preflight.

---

## 8. Scoring against the six criteria

- **Potential Impact** — maps to the #1 production-agent failure of the year;
  "stopped a five-figure loop at fifty cents" is a number judges repeat.
- **Creativity** — "observability that acts" is a genuine reframe; not a prompt
  already sitting on the board.
- **Technical Excellence** — OTel-native, clean sense→act architecture, real
  anomaly logic, self-verifying via Preflight.
- **Best Use of SigNoz** — traces + metrics + logs + alerts + dashboards + MCP
  as one system, not a single panel.
- **UX** — zero-babysit guardrail + one Slack card.
- **Presentation** — the runaway-cost narrative + a dramatic live before/after
  (twice) is a gift to a demo.

---

## 9. Ideas considered and rejected

- **PR-time regression gate replaying production traces** — strong, but
  Braintrust/Latitude already do eval-gated CI, and replay infra is hard in 5
  days.
- **SRE Sidekick** — a listed example build, so many teams will do it. Crowded,
  less creative.
- **Full telemetry-trust product (ContractGuard)** — genuinely good, but it's an
  idea already on the public board (reads as executing a prompt, not a leap), its
  climax is a score turning green (nobody feels it), and its breadth is a 5-day
  trap. We took only its sharpest insight — Preflight — and left the rest.

---

## 10. The one risk to watch

The breaker's **Enforce** step is the entire thesis. Build it and prove it
first (Day 1). Sensing, dashboards, and MCP diagnosis are the safe, easy parts —
they are worthless if the breaker doesn't visibly pause a real call on stage.
