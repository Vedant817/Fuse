-- Exporter evidence is source-instance scoped. A monotonic sequence orders
-- callbacks only within one process; database receipt time supplies liveness
-- without trusting unrelated process clocks.

CREATE TABLE preflight_source_evidence (
  tenant TEXT NOT NULL,
  environment TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  source_instance_id VARCHAR(128) NOT NULL
    CHECK (source_instance_id ~ '^[A-Za-z0-9._:-]+$'),
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  observed_at_ms BIGINT NOT NULL CHECK (observed_at_ms >= 0),
  status TEXT NOT NULL CHECK (status IN ('success', 'failure')),
  spans JSONB NOT NULL CHECK (jsonb_typeof(spans) = 'array'),
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant, environment, agent_id, source_instance_id),
  FOREIGN KEY (tenant, environment, agent_id)
    REFERENCES registered_scopes (tenant, environment, agent_id)
    ON DELETE CASCADE
);

CREATE INDEX preflight_source_evidence_scope_received_idx
  ON preflight_source_evidence (tenant, environment, agent_id, received_at DESC);

-- Preserve the one source captured by migration 0006. evaluated_at is the
-- trusted server-side approximation available for historical receipt time.
INSERT INTO preflight_source_evidence (
  tenant, environment, agent_id, source_instance_id, sequence,
  observed_at_ms, status, spans, received_at
)
SELECT
  tenant, environment, agent_id, exporter_source_instance_id,
  exporter_sequence, exporter_observed_at_ms, exporter_status,
  exporter_spans, evaluated_at
FROM preflight_state
WHERE exporter_source_instance_id IS NOT NULL
ON CONFLICT (tenant, environment, agent_id, source_instance_id) DO NOTHING;
