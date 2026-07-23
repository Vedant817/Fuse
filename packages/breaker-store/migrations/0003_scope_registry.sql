-- Explicit scope registry and database-level cardinality boundary.
--
-- Upgrade semantics: every scope already present in breaker_state or
-- preflight_state is registered before foreign keys are validated. Existing
-- deployments therefore keep working without an insecure "allow unknown"
-- compatibility mode. New scopes can only be created through the
-- operator-authenticated registration API.

CREATE TABLE registered_scopes (
  tenant TEXT NOT NULL,
  environment TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL,
  registered_by_type TEXT NOT NULL,
  registered_by_id TEXT NOT NULL,
  registration_reason TEXT NOT NULL,
  PRIMARY KEY (tenant, environment, agent_id)
);

INSERT INTO registered_scopes (
  tenant,
  environment,
  agent_id,
  policy_version,
  registered_at,
  registered_by_type,
  registered_by_id,
  registration_reason
)
SELECT
  tenant,
  environment,
  agent_id,
  policy_version,
  updated_at,
  updated_by_type,
  updated_by_id,
  COALESCE(NULLIF(reason, ''), 'preexisting breaker scope migrated')
FROM breaker_state;

INSERT INTO registered_scopes (
  tenant,
  environment,
  agent_id,
  policy_version,
  registered_at,
  registered_by_type,
  registered_by_id,
  registration_reason
)
SELECT
  tenant,
  environment,
  agent_id,
  'unversioned',
  evaluated_at,
  'system',
  'system:scope-registry-migration',
  'preexisting Preflight scope migrated'
FROM preflight_state
ON CONFLICT (tenant, environment, agent_id) DO NOTHING;

-- A legacy Preflight-only scope did not necessarily have a breaker row.
-- Materialize one now so registration has one invariant after migration:
-- every registered scope has an initialized, durable breaker.
INSERT INTO breaker_state (
  tenant,
  environment,
  agent_id,
  state,
  epoch,
  reason,
  policy_version,
  cooldown_until,
  updated_at,
  updated_by_type,
  updated_by_id
)
SELECT
  tenant,
  environment,
  agent_id,
  'armed',
  0,
  'preexisting Preflight scope migrated',
  policy_version,
  NULL,
  registered_at,
  'system',
  'system:scope-registry-migration'
FROM registered_scopes
ON CONFLICT (tenant, environment, agent_id) DO NOTHING;

ALTER TABLE breaker_state
  ADD CONSTRAINT breaker_state_registered_scope_fk
  FOREIGN KEY (tenant, environment, agent_id)
  REFERENCES registered_scopes (tenant, environment, agent_id)
  NOT VALID;

ALTER TABLE breaker_audit_log
  ADD CONSTRAINT breaker_audit_log_registered_scope_fk
  FOREIGN KEY (tenant, environment, agent_id)
  REFERENCES registered_scopes (tenant, environment, agent_id)
  NOT VALID;

ALTER TABLE idempotency_keys
  ADD CONSTRAINT idempotency_keys_registered_scope_fk
  FOREIGN KEY (tenant, environment, agent_id)
  REFERENCES registered_scopes (tenant, environment, agent_id)
  NOT VALID;

ALTER TABLE preflight_state
  ADD CONSTRAINT preflight_state_registered_scope_fk
  FOREIGN KEY (tenant, environment, agent_id)
  REFERENCES registered_scopes (tenant, environment, agent_id)
  NOT VALID;

ALTER TABLE breaker_state VALIDATE CONSTRAINT breaker_state_registered_scope_fk;
ALTER TABLE breaker_audit_log VALIDATE CONSTRAINT breaker_audit_log_registered_scope_fk;
ALTER TABLE idempotency_keys VALIDATE CONSTRAINT idempotency_keys_registered_scope_fk;
ALTER TABLE preflight_state VALIDATE CONSTRAINT preflight_state_registered_scope_fk;
