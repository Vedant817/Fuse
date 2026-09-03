-- Order Preflight reports by their source evidence rather than arrival time.
-- Existing rows are backfilled from evaluated_at - freshness_ms where that
-- derivation is safe. Rows with no span evidence (or a historical negative
-- freshness caused by future timestamps) deliberately keep a NULL watermark,
-- allowing the next report to establish one without being incorrectly stale.

ALTER TABLE preflight_state
  ADD COLUMN evidence_watermark_ms BIGINT,
  ADD COLUMN evidence_version BIGINT NOT NULL DEFAULT 1
    CHECK (evidence_version >= 1);

UPDATE preflight_state
SET evidence_watermark_ms =
  (EXTRACT(EPOCH FROM evaluated_at) * 1000)::BIGINT - freshness_ms
WHERE freshness_ms IS NOT NULL
  AND freshness_ms >= 0
  AND (EXTRACT(EPOCH FROM evaluated_at) * 1000)::BIGINT >= freshness_ms;

ALTER TABLE preflight_state
  ADD CONSTRAINT preflight_state_evidence_watermark_nonnegative
  CHECK (evidence_watermark_ms IS NULL OR evidence_watermark_ms >= 0);
