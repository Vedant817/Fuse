-- Fuse Preflight telemetry-health store: one row per scope, tracking the
-- last committed evaluation (needed for the evaluator's recovery-dwell
-- hysteresis, which requires the previous result as input). Unlike
-- breaker_state, this does not use epoch-based CAS: Preflight evaluations
-- are not a security/enforcement-critical concurrent-writer race the way
-- breaker transitions are, so a simple row lock is an intentional,
-- lower-overhead choice for this store (see ADR-002's alternatives
-- section for why CAS was chosen for breaker_state specifically).

CREATE TABLE IF NOT EXISTS preflight_state (
  tenant TEXT NOT NULL,
  environment TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('protected', 'degraded', 'blind', 'disabled')),
  reason_code TEXT NOT NULL,
  reason TEXT NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL,
  last_good_at TIMESTAMPTZ,
  required_field_coverage_percent DOUBLE PRECISION NOT NULL,
  orphan_rate_percent DOUBLE PRECISION NOT NULL,
  freshness_ms BIGINT,
  pending_recovery_state TEXT,
  pending_since TIMESTAMPTZ,
  PRIMARY KEY (tenant, environment, agent_id)
);
