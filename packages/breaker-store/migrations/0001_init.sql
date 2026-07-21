-- Fuse breaker state store: initial schema.
-- One row per scoped breaker; atomicity is via epoch-based compare-and-swap
-- from the application layer (see ADR-002), not row locks or triggers here.

CREATE TABLE IF NOT EXISTS breaker_state (
  tenant TEXT NOT NULL,
  environment TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('armed', 'tripped', 'disabled')),
  epoch BIGINT NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  policy_version TEXT NOT NULL,
  cooldown_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by_type TEXT NOT NULL,
  updated_by_id TEXT NOT NULL,
  PRIMARY KEY (tenant, environment, agent_id)
);

CREATE TABLE IF NOT EXISTS breaker_audit_log (
  id UUID PRIMARY KEY,
  tenant TEXT NOT NULL,
  environment TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  epoch_before BIGINT NOT NULL,
  epoch_after BIGINT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  noop BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS breaker_audit_log_scope_idx
  ON breaker_audit_log (tenant, environment, agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant TEXT NOT NULL,
  environment TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant, environment, agent_id, key)
);

CREATE INDEX IF NOT EXISTS idempotency_keys_expires_idx
  ON idempotency_keys (expires_at);
