-- Durable, at-least-once diagnosis delivery. The breaker audit row remains
-- the source of truth; this table stores only delivery state and bounded
-- structural metadata, keyed one-to-one by the audit event that created it.

CREATE TABLE diagnosis_jobs (
  audit_event_id UUID PRIMARY KEY
    REFERENCES breaker_audit_log (id),
  detector VARCHAR(200) NOT NULL
    CHECK (length(detector) BETWEEN 1 AND 200),
  detector_version VARCHAR(200),
  score DOUBLE PRECISION,
  threshold DOUBLE PRECISION,
  starts_at TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ,
  notify_slack BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'dead-letter')),
  attempts INTEGER NOT NULL DEFAULT 0
    CHECK (attempts BETWEEN 0 AND 100),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  leased_by VARCHAR(200),
  leased_until TIMESTAMPTZ,
  last_error VARCHAR(1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT diagnosis_jobs_lease_pair CHECK (
    (leased_by IS NULL AND leased_until IS NULL) OR
    (leased_by IS NOT NULL AND leased_until IS NOT NULL)
  ),
  CONSTRAINT diagnosis_jobs_measurement_set CHECK (
    (detector_version IS NULL AND score IS NULL AND threshold IS NULL AND window_end IS NULL) OR
    (detector_version IS NOT NULL AND score IS NOT NULL AND threshold IS NOT NULL AND window_end IS NOT NULL)
  )
);

CREATE INDEX diagnosis_jobs_claim_idx
  ON diagnosis_jobs (available_at, created_at)
  WHERE status = 'pending';

CREATE INDEX diagnosis_jobs_expired_lease_idx
  ON diagnosis_jobs (leased_until)
  WHERE status = 'running';
