-- Operator-attributed, idempotent dead-letter replay audit. Requeueing changes
-- delivery state, not breaker state, so it needs its own immutable audit trail.

CREATE TABLE diagnosis_job_replay_audit (
  id UUID PRIMARY KEY,
  audit_event_id UUID NOT NULL REFERENCES diagnosis_jobs (audit_event_id),
  tenant TEXT NOT NULL,
  environment TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  actor_type VARCHAR(16) NOT NULL CHECK (actor_type = 'manual'),
  actor_id VARCHAR(256) NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 256),
  reason VARCHAR(2000) NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  idempotency_key VARCHAR(200) NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant, idempotency_key)
);

CREATE INDEX diagnosis_job_replay_audit_job_idx
  ON diagnosis_job_replay_audit (audit_event_id, created_at DESC);

CREATE INDEX diagnosis_jobs_list_idx
  ON diagnosis_jobs (created_at DESC, audit_event_id DESC);
