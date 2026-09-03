# Fuse production deployment runbook

This runbook deploys the compiled Fuse control plane as an immutable,
non-root container behind a TLS-terminating Kubernetes ingress. It does not
turn the self-hosted local SigNoz Foundry stack into a production SigNoz
installation; operate SigNoz and PostgreSQL with their own supported HA,
backup, upgrade, and TLS procedures.

## Supported topology and hard boundary

The checked-in Kubernetes deployment runs two control-plane replicas with a
rolling strategy and a PodDisruptionBudget. The SDK sends the complete bounded
trailing detector window with each observation, so a request may reach either
replica without splitting history. Breaker state, registration, idempotency,
and audit history are serialized in PostgreSQL.

Global request-rate counters are shared through Redis. Production startup
rejects a missing or unreachable `CONTROL_PLANE_RATE_LIMIT_REDIS_URL`; it never
falls back to replica-local memory. Provision a TLS/authenticated managed Redis
endpoint where possible and put its URL in the `fuse-control-plane-runtime-secrets`
key `rate-limit-redis-url`. The OCI Compose profile supplies an isolated,
non-published Redis container for its single-VM topology.

Each logical scope must still have one authoritative SDK observation stream.
If several independent agent processes intentionally share one
tenant/environment/agentId tuple, their separate client-side windows are not
merged by this API. Give independently-running agents distinct `agentId`
values, or use aggregate SigNoz alerting for that topology.

TLS terminates at the Kubernetes ingress. Plain HTTP is permitted only on the
cluster-internal `ClusterIP` service. Replace the example hostname,
ingress class, and certificate secret before applying the manifests.

## 1. Release, identify, and verify the image

CI builds and smoke-tests the image but deliberately does not publish it or
use registry credentials on pull requests. The manual-only `Release image`
workflow is the only supported publisher. Dispatch it from `main`; the checked
out commit must be reachable from `origin/main`, and the requested version must
be the first dated release below the empty `[Unreleased]` section in
`CHANGELOG.md`. Empty, malformed, and literal `latest` inputs fail before a
build. Configure the GitHub `release` Environment to allow only `main` and to
require reviewer approval before the publish job receives package, attestation,
and OIDC permissions.

```bash
export FUSE_VERSION=vX.Y.Z # must match the intentional dated CHANGELOG cut
export FUSE_IMAGE=ghcr.io/vedant817/fuse-control-plane
gh workflow run release.yml --ref main -f version="$FUSE_VERSION"
gh run watch --exit-status
```

Unreleased notes are not a pullable image. Do not use or describe any candidate
version as published until the workflow has succeeded and the version alias,
manifest digest, attestations, and retained scan evidence have been verified.

The workflow builds each platform once, runs all current migrations through
`0008` on a fresh database, starts the exact scratch image with production
configuration, shared Redis, and separate exact-scope agent/exporter
credentials. It submits isolated firing windows for loop signature, context
bloat, and cost velocity, then verifies each matching committed trip, denied
next permit, and durable diagnosis job. It pauses Redis and performs a bounded
PostgreSQL stop/start in turn to verify fail-closed readiness/API behavior and
recovery before registry authentication. A SHA-pinned
Anchore action using pinned Grype `v0.110.0` then scans each exact architecture;
any high or critical finding blocks publication. Only after both candidates pass
does the workflow authenticate and push run-specific `staging-*` tags, assemble
the two-platform staging manifest, validate workspace CycloneDX and final-image
SPDX SBOMs for expected runtime components with pinned Syft `v1.42.3`, publish digest-bound provenance/SBOM
attestations, and retain all SBOM/scan/digest evidence.

Consumer-facing version, `sha-<commit>`, and stable `latest` aliases are created
only in the final mutation step. Prereleases do not update `latest`. A rerun is
safe when an immutable alias is absent or already points to the exact staged
digest; an existing version or commit alias pointing elsewhere fails closed.
The workflow never uses version- or commit-specific architecture aliases.

Resolve and record that registry digest. Deploy the digest, never the tag:

```bash
export FUSE_IMAGE_DIGEST="$(docker buildx imagetools inspect \
  "$FUSE_IMAGE:$FUSE_VERSION" --format '{{json .Manifest}}' | jq -r .digest)"
test -n "$FUSE_IMAGE_DIGEST"
gh attestation verify "oci://$FUSE_IMAGE@$FUSE_IMAGE_DIGEST" \
  --repo Vedant817/Fuse
```

Before deployment, require the repository CI gate and review the retained source
SBOM, image SBOM, and both architecture scan reports. `pnpm audit --prod
--audit-level low` fails on any known production dependency advisory; the
complete JSON audit remains a CI artifact. There is intentionally no checked-in
SBOM snapshot: generated evidence is bound to the workflow run and image digest
it actually describes.

## 2. Provision dependencies and secrets

Use a managed or separately-operated PostgreSQL 16 deployment with TLS,
point-in-time recovery, automated backups, and a restore rehearsal. Do not
deploy the local `infra/docker-compose.yml` database in production.

Create separate external database principals. The checked manifests enforce
separate Kubernetes Secrets and project only `DATABASE_URL` into migration and
maintenance jobs, but PostgreSQL grants remain the database owner's
responsibility:

- `fuse_migrator` owns the Fuse schema and can apply DDL. Only the one-shot
  migration Job receives this credential.
- `fuse_runtime` receives schema `USAGE`, table DML, sequence use, and migration
  ledger reads, but no schema/database `CREATE` authority.
- `fuse_maintenance` receives `USAGE` plus `SELECT, DELETE` on
  `idempotency_keys` only.

Have a database administrator adapt and run the following after creating all
three login roles with independent, secret-manager-generated passwords of at
least 32 random bytes. Run the grants again after the first migration so the
current tables are covered; the default privileges cover later migrations
owned by `fuse_migrator`.

```sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO fuse_migrator;

GRANT USAGE ON SCHEMA public TO fuse_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fuse_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fuse_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE fuse_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fuse_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE fuse_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO fuse_runtime;

GRANT USAGE ON SCHEMA public TO fuse_maintenance;
GRANT SELECT, DELETE ON TABLE idempotency_keys TO fuse_maintenance;
```

Create `fuse-system`, generate independent 32-byte bearer credentials, and
provision three Secrets through your external secret manager. The commands
below show the required Kubernetes shape without placing values in Git.
`openssl rand -hex 32` emits 32 random bytes as 64 hexadecimal characters:

```bash
kubectl apply -f infra/production/kubernetes/namespace.yaml

export OPERATOR_TOKEN="$(openssl rand -hex 32)"
export AGENT_TOKEN="$(openssl rand -hex 32)"
export EXPORTER_TOKEN="$(openssl rand -hex 32)"
export WEBHOOK_TOKEN="$(openssl rand -hex 32)"
export DATABASE_URL='postgres://fuse_runtime:RUNTIME_PASSWORD@HOST:5432/fuse?sslmode=require'
export CONTROL_PLANE_DEPLOYMENT_ENVIRONMENT=production
export CONTROL_PLANE_DETECTOR_POLICY_FILE=/etc/fuse/policies/production.json
export CONTROL_PLANE_RATE_LIMIT_REDIS_URL='rediss://USER:PASSWORD@REDIS_HOST:6380/0'
export CONTROL_PLANE_API_TOKENS="TENANT:$OPERATOR_TOKEN"
export CONTROL_PLANE_AGENT_API_TOKENS="TENANT:production:AGENT_ID:$AGENT_TOKEN"
export CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS="TENANT:production:AGENT_ID:$EXPORTER_TOKEN"
export CONTROL_PLANE_WEBHOOK_TOKENS="TENANT:$WEBHOOK_TOKEN"

pnpm --filter @fuse/control-plane run build
pnpm run validate:production-env

kubectl -n fuse-system create secret generic fuse-control-plane-runtime-secrets \
  --from-literal=DATABASE_URL="$DATABASE_URL" \
  --from-literal=CONTROL_PLANE_API_TOKENS="$CONTROL_PLANE_API_TOKENS" \
  --from-literal=CONTROL_PLANE_AGENT_API_TOKENS="$CONTROL_PLANE_AGENT_API_TOKENS" \
  --from-literal=CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS="$CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS" \
  --from-literal=CONTROL_PLANE_WEBHOOK_TOKENS="$CONTROL_PLANE_WEBHOOK_TOKENS" \
  --from-literal=rate-limit-redis-url="$CONTROL_PLANE_RATE_LIMIT_REDIS_URL" \
  --from-literal=OTEL_EXPORTER_OTLP_ENDPOINT='https://OTEL_COLLECTOR:4318' \
  --dry-run=client -o yaml |
kubectl apply -f -

kubectl -n fuse-system create secret generic fuse-control-plane-migration-secrets \
  --from-literal=DATABASE_URL='postgres://fuse_migrator:MIGRATOR_PASSWORD@HOST:5432/fuse?sslmode=require' \
  --dry-run=client -o yaml |
kubectl apply -f -

kubectl -n fuse-system create secret generic fuse-control-plane-maintenance-secrets \
  --from-literal=DATABASE_URL='postgres://fuse_maintenance:MAINTENANCE_PASSWORD@HOST:5432/fuse?sslmode=require' \
  --dry-run=client -o yaml |
kubectl apply -f -

unset OPERATOR_TOKEN AGENT_TOKEN EXPORTER_TOKEN WEBHOOK_TOKEN
```

The validation command calls the same `loadConfig` function as the server and
prints no configuration values. Use independent random tokens for each role and tenant. Production agent
and exporter-evidence credentials must use separate exact
`tenant:environment:agentId:token` entries; missing exporter credentials, plain,
partial-scope, wildcard, and raw-token reuse are rejected at production startup.
Give the matching agent workload only the raw `AGENT_TOKEN`; give the supported
OTel exporter path the raw `EXPORTER_TOKEN` as
`FUSE_PREFLIGHT_EXPORTER_TOKEN`. If full agent-process compromise is in scope,
run the exporter under a separate identity and secret boundary instead of using
the in-process runtime. Operators may use `tenant:token`. A tenant-bound webhook token requires every alert in one
grouped delivery to name that same tenant; use a plain wildcard webhook token
only when one SigNoz channel intentionally groups several tenants. The webhook
role remains trip-only. Do not pass secrets as Docker build arguments, store
them in a ConfigMap, or commit a rendered Secret.

Optional keys in `fuse-control-plane-runtime-secrets`:

- `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, and
  `SLACK_INCIDENT_CHANNEL`;
- `SLACK_AUTHORIZED_USER_IDS` and an optional exact `SLACK_TEAM_ID`; without
  authorized users, incident cards remain read-only;
- `FUSE_SIGNOZ_MCP_URL`;
- `OTEL_EXPORTER_OTLP_HEADERS` when the collector requires authentication.

The container filesystem is read-only. Incident snapshots therefore use the
memory-backed `/tmp` volume and are ephemeral; use Slack or a durable incident
store for records that must survive restarts.

Provision operational alerts against the pinned SigNoz instance only after the
collector receives control-plane metrics. `PREFLIGHT_SLACK_WEBHOOK_URL` is also
used to create the separate `fuse-operations` channel; the operational rules
never use the breaker webhook channel.

```bash
pnpm run test:signoz-alerts
export SIGNOZ_URL='https://SIGNOZ_HOST'
export SIGNOZ_ADMIN_EMAIL='SIGNOZ_ADMIN_EMAIL'
export SIGNOZ_ADMIN_PASSWORD='SIGNOZ_ADMIN_PASSWORD'
export CONTROL_PLANE_WEBHOOK_URL='https://YOUR_FUSE_HOST/v1/webhooks/signoz'
export CONTROL_PLANE_WEBHOOK_TOKEN="$WEBHOOK_TOKEN"
export PREFLIGHT_SLACK_WEBHOOK_URL='https://hooks.slack.com/services/REAL/APP/SECRET'
bash infra/signoz-alerts-up.sh
```

The provisioner expands the versioned operational rule array, updates every
rule by stable alert name, fetches persisted rules, and verifies metric,
filter, threshold/channel, grouping, schema-version, and no-data fields
round-trip. Stop the deployment if the pinned SigNoz API rejects or rewrites
those fields. Credentials and API response bodies stay in a mode-0700 temporary
directory and are not printed.

## 3. Adapt the deployment

Edit an environment overlay rather than the base before deployment:

- replace `fuse.example.com`, `ingressClassName`, and
  `fuse-control-plane-tls`;
- set both the migration Job and Deployment to the same recorded
  `image@sha256:...` digest;
- label the ingress-controller namespace so the NetworkPolicy permits it:

  ```bash
  kubectl label namespace INGRESS_NAMESPACE \
    networking.fuse.dev/ingress=true --overwrite
  ```

- narrow the NetworkPolicy egress rules to the actual PostgreSQL, OTel,
  SigNoz MCP, DNS, and Slack destinations supported by your CNI. The portable
  base can restrict ports but cannot express external DNS names;
- size `CONTROL_PLANE_RATE_LIMIT_MAX` above measured aggregate permit volume,
  and size `CONTROL_PLANE_DB_POOL_MAX` within the database connection budget;
- keep the default fail-closed outage mode unless the availability/cost
  tradeoff has been explicitly approved.

Set the checked-in Kustomize image placeholder to the verified digest, then
render and inspect the exact objects before applying:

```bash
export FUSE_IMAGE=ghcr.io/vedant817/fuse-control-plane
test -n "$FUSE_IMAGE_DIGEST"
(cd infra/production/kubernetes && \
  kustomize edit set image "$FUSE_IMAGE=$FUSE_IMAGE@$FUSE_IMAGE_DIGEST")
kubectl kustomize infra/production/kubernetes
kubectl apply --dry-run=server -k infra/production/kubernetes
```

The checked-in detector policy source is
`infra/production/kubernetes/production-detector-policy.json`; Kustomize
generates the mounted ConfigMap from that file. Production startup refuses a
missing or invalid policy.

## 4. Backup and migrate

The migration runner is forward-only and holds a PostgreSQL advisory lock for
the complete migration integrity-check/apply sequence, so concurrent jobs
serialize. Every ledger row stores the SQL file's SHA-256 checksum; the Job
fails before applying pending work if an existing ID is absent from the image
or its content differs. Never repair this by editing an applied SQL file.
Take and verify a restorable database backup first; operationally, still run
one migration Job per release so ownership and logs remain unambiguous.

There are currently **eight** migrations, `0001_init.sql` through
`0008_preflight_source_evidence.sql`. Render the standalone migration Job with the
same immutable digest selected above, apply it, and wait for completion before
applying the Deployment:

```bash
kubectl set image --local \
  -f infra/production/kubernetes/migration-job.yaml \
  job/fuse-control-plane-migrate \
  migrate="$FUSE_IMAGE@$FUSE_IMAGE_DIGEST" \
  -o yaml > /tmp/fuse-control-plane-migrate.yaml
kubectl -n fuse-system delete job fuse-control-plane-migrate --ignore-not-found
kubectl apply -f /tmp/fuse-control-plane-migrate.yaml
kubectl -n fuse-system wait \
  --for=condition=complete \
  --timeout=5m \
  job/fuse-control-plane-migrate
kubectl -n fuse-system logs job/fuse-control-plane-migrate
kubectl apply -k infra/production/kubernetes
kubectl -n fuse-system rollout status deployment/fuse-control-plane --timeout=5m
kubectl -n fuse-system get pods,service,ingress
```

Expected migration output ends with `0008_preflight_source_evidence.sql`, or is
`no pending migrations` when all eight ledger entries already exist. Stop the
rollout if the Job fails, including an integrity mismatch. `/readyz` independently
compares the same eight IDs and checksums before accepting traffic. Do not run
`infra/reset.sh`; it destroys the schema.
The suspended migration template in the Kustomize render documents the image
without racing the standalone run-and-wait Job.

## 5. Deploy and verify

Verify both the public TLS boundary and the internal readiness endpoint:

```bash
curl --fail --show-error --silent https://YOUR_FUSE_HOST/healthz
kubectl -n fuse-system port-forward service/fuse-control-plane 18090:80
curl --fail --show-error --silent http://127.0.0.1:18090/readyz
```

Then run a canary with a dedicated scope and its exact-scope agent credential:

1. confirm an armed scope returns `allowed: true`;
2. issue an authenticated, idempotent trip;
3. confirm the next permit returns `allowed: false`;
4. query `breaker_audit_log` and verify actor, reason, policy version,
   correlation ID, and epoch;
5. resume with an operator credential and confirm permits recover;
6. redeliver the old source-epoch alert and confirm `stale-epoch`;
7. emit a real OTLP trace export and confirm Preflight uses evidence reported
   through the separate exporter credential;
8. confirm the detector metric and durable diagnosis job are visible.
9. confirm `fuse.rate_limit.redis.ready` and
   `fuse.preflight.sweep.healthy` report `1`, then test the `fuse-operations`
   channel and verify resolved notifications are enabled.

Do not promote based only on `/healthz`; it deliberately stays 200 during
dependency outages. `/readyz` proves a bounded Redis `PING`, PostgreSQL access,
and the complete eight-migration schema, while the canary proves the actual
enforcement boundary.

## 6. Rollback

For an application-only rollback, redeploy the previous image digest:

```bash
kubectl -n fuse-system rollout undo deployment/fuse-control-plane
kubectl -n fuse-system rollout status deployment/fuse-control-plane --timeout=5m
```

The Deployment rolls back with `maxUnavailable: 0`. Verify `/readyz` and repeat
the trip/blocked-next-permit canary; SDKs still apply their configured outage
mode if the service becomes unreachable despite the availability controls.

There are no down migrations. If a release applied an incompatible schema
change, application rollback alone may be unsafe. Restore the pre-migration
backup into a new database, validate it, update `DATABASE_URL`, and redeploy
the previous image. Never overwrite the current database before the restored
copy has passed readiness and enforcement canaries.

## 7. Rotation, monitoring, and retention

Rotate bearer credentials by adding a new token, restarting, moving callers,
then removing the old token and restarting again. The process reads tokens at
startup; there is no online revocation.

At minimum, page on:

- readiness failures and control-plane restart loops;
- permit denial/error/latency and rate-limit saturation;
- detector observation-to-trip latency;
- webhook rejection/delivery failures;
- blind or stale Preflight state;
- OTel export failures and diagnosis/Slack delivery failures;
- PostgreSQL connection saturation, storage growth, replication lag, and
  backup failure;
- Redis availability, memory saturation, rejected commands, and limiter 429
  saturation.

The checked-in initial thresholds and exact opening/resolution/no-data
semantics are in
`docs/runbooks/operations.md#provisional-operational-slos`. They are explicitly
provisional until replaced by a versioned objective based on production
history. Do not tune them in the SigNoz UI; change the artifact, contract tests,
and runbook together, then rerun provisioning so drift is reconciled.

Schedule deletion of expired `idempotency_keys`. Define an explicit legal and
operational retention period for `breaker_audit_log`; it has no automatic
expiry. See `docs/runbooks/operations.md` for the SQL and the full limitations
list before approving a production change.
