-- Persist the exact accepted exporter attempt. Sequence is authoritative
-- within one bounded source instance; observed_at orders process restarts.
-- The bounded structural samples let revalidation use database evidence only,
-- so a delayed caller cannot replay stale success over a newer failure.

ALTER TABLE preflight_state
  ADD COLUMN exporter_source_instance_id VARCHAR(128),
  ADD COLUMN exporter_sequence BIGINT,
  ADD COLUMN exporter_observed_at_ms BIGINT,
  ADD COLUMN exporter_status TEXT,
  ADD COLUMN exporter_spans JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE preflight_state
  ADD CONSTRAINT preflight_exporter_source_instance_id_format
    CHECK (
      exporter_source_instance_id IS NULL OR
      exporter_source_instance_id ~ '^[A-Za-z0-9._:-]+$'
    ),
  ADD CONSTRAINT preflight_exporter_sequence_positive
    CHECK (exporter_sequence IS NULL OR exporter_sequence > 0),
  ADD CONSTRAINT preflight_exporter_observed_at_nonnegative
    CHECK (exporter_observed_at_ms IS NULL OR exporter_observed_at_ms >= 0),
  ADD CONSTRAINT preflight_exporter_status_valid
    CHECK (exporter_status IS NULL OR exporter_status IN ('success', 'failure')),
  ADD CONSTRAINT preflight_exporter_metadata_complete
    CHECK (
      (exporter_source_instance_id IS NULL AND exporter_sequence IS NULL AND
       exporter_observed_at_ms IS NULL AND exporter_status IS NULL AND
       exporter_spans = '[]'::jsonb)
      OR
      (exporter_source_instance_id IS NOT NULL AND exporter_sequence IS NOT NULL AND
       exporter_observed_at_ms IS NOT NULL AND exporter_status IS NOT NULL AND
       jsonb_typeof(exporter_spans) = 'array')
    );
