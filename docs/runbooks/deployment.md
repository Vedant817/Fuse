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

Each logical scope must still have one authoritative SDK observation stream.
If several independent agent processes intentionally share one
tenant/environment/agentId tuple, their separate client-side windows are not
merged by this API. Give independently-running agents distinct `agentId`
values, or use aggregate SigNoz alerting for that topology.

TLS terminates at the Kubernetes ingress. Plain HTTP is permitted only on the
cluster-internal `ClusterIP` service. Replace the example hostname,
ingress class, and certificate secret before applying the manifests.

## 1. Build, identify, and scan the image

CI builds and smoke-tests the image but deliberately does not publish it or
use registry credentials on pull requests. For a release, build from a clean,
reviewed commit and publish an immutable version:

```bash
export FUSE_VERSION=0.1.0
export FUSE_IMAGE=ghcr.io/vedant817/fuse-control-plane
export FUSE_REVISION="$(git rev-parse HEAD)"
export FUSE_BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --build-arg VERSION="$FUSE_VERSION" \
  --build-arg VCS_REF="$FUSE_REVISION" \
  --build-arg BUILD_DATE="$FUSE_BUILD_DATE" \
  --provenance=mode=max \
  --sbom=true \
  --tag "$FUSE_IMAGE:$FUSE_VERSION" \
  --push .
```

Resolve and record the registry digest. Deploy the digest, not a mutable tag:

```bash
docker buildx imagetools inspect "$FUSE_IMAGE:$FUSE_VERSION"
```

Before promotion, require the repository CI gate, a registry/container scan
with zero unaccepted critical/high findings, and review of the generated
CycloneDX SBOM artifact. `pnpm audit --prod --audit-level high` intentionally
fails on high/critical production dependency findings; the complete JSON
audit remains an artifact so accepted lower-severity findings are visible.

## 2. Provision dependencies and secrets

Use a managed or separately-operated PostgreSQL 16 deployment with TLS,
point-in-time recovery, automated backups, and a restore rehearsal. The
database role needs schema migration and normal table read/write privileges.
Do not deploy the local `infra/docker-compose.yml` database in production.

Create `fuse-system`, then provision the runtime secret through your external
secret manager. This command shows the required Kubernetes shape without
placing values in Git:

```bash
kubectl apply -f infra/production/kubernetes/namespace.yaml

kubectl -n fuse-system create secret generic fuse-control-plane-secrets \
  --from-literal=DATABASE_URL='postgres://USER:PASSWORD@HOST:5432/fuse?sslmode=require' \
  --from-literal=CONTROL_PLANE_API_TOKENS='TENANT:OPERATOR_TOKEN' \
  --from-literal=CONTROL_PLANE_AGENT_API_TOKENS='TENANT:AGENT_TOKEN' \
  --from-literal=CONTROL_PLANE_WEBHOOK_TOKENS='WEBHOOK_TOKEN' \
  --from-literal=OTEL_EXPORTER_OTLP_ENDPOINT='https://OTEL_COLLECTOR:4318' \
  --dry-run=client -o yaml |
kubectl apply -f -
```

Use independent random tokens for each role and tenant. Plain tokens are
wildcards across tenants; use the documented `tenant:token` form for operator
and agent credentials. A tenant-bound webhook token requires every alert in
one grouped delivery to name that same tenant; use a plain wildcard webhook
token only when one SigNoz channel intentionally groups several tenants. The
webhook role remains trip-only. Do not pass secrets as Docker build arguments,
store them in a ConfigMap, or commit a rendered Secret.

Optional keys in the same runtime secret:

- `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, and
  `SLACK_INCIDENT_CHANNEL`;
- `FUSE_SIGNOZ_MCP_URL`;
- `OTEL_EXPORTER_OTLP_HEADERS` when the collector requires authentication.

The container filesystem is read-only. Incident snapshots therefore use the
memory-backed `/tmp` volume and are ephemeral; use Slack or a durable incident
store for records that must survive restarts.

## 3. Adapt the deployment

Edit an environment overlay rather than the base before deployment:

- replace `fuse.example.com`, `ingressClassName`, and
  `fuse-control-plane-tls`;
- replace the image tag with the recorded `image@sha256:...` digest;
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

Render and inspect the exact objects before applying:

```bash
kubectl kustomize infra/production/kubernetes
kubectl apply --dry-run=server -k infra/production/kubernetes
```

## 4. Backup and migrate

The migration runner is forward-only and holds a PostgreSQL advisory lock for
the complete migration check/apply sequence, so concurrent jobs serialize.
Take and verify a restorable database backup first; operationally, still run
one migration Job per release so ownership and logs remain unambiguous.

Set the migration Job image to the same immutable digest as the Deployment,
then run:

```bash
kubectl -n fuse-system delete job fuse-control-plane-migrate --ignore-not-found
kubectl apply -f infra/production/kubernetes/migration-job.yaml
kubectl -n fuse-system wait \
  --for=condition=complete \
  --timeout=5m \
  job/fuse-control-plane-migrate
kubectl -n fuse-system logs job/fuse-control-plane-migrate
```

Expected output is `applied: ...` or `no pending migrations`. Stop the rollout
if the Job fails. Do not run `infra/reset.sh`; it destroys the schema.

## 5. Deploy and verify

```bash
kubectl apply -k infra/production/kubernetes
kubectl -n fuse-system rollout status deployment/fuse-control-plane --timeout=5m
kubectl -n fuse-system get pods,service,ingress
```

Verify both the public TLS boundary and the internal readiness endpoint:

```bash
curl --fail --show-error --silent https://YOUR_FUSE_HOST/healthz
kubectl -n fuse-system port-forward service/fuse-control-plane 18090:80
curl --fail --show-error --silent http://127.0.0.1:18090/readyz
```

Then run a canary with a dedicated scope and tenant-scoped credentials:

1. confirm an armed scope returns `allowed: true`;
2. issue an authenticated, idempotent trip;
3. confirm the next permit returns `allowed: false`;
4. query `breaker_audit_log` and verify actor, reason, policy version,
   correlation ID, and epoch;
5. resume with an operator credential and confirm permits recover;
6. emit detector telemetry and confirm its metric reaches the production
   SigNoz instance.

Do not promote based only on `/healthz`; `/readyz` proves PostgreSQL access,
while the canary proves the actual enforcement boundary.

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
  backup failure.

Schedule deletion of expired `idempotency_keys`. Define an explicit legal and
operational retention period for `breaker_audit_log`; it has no automatic
expiry. See `docs/runbooks/operations.md` for the SQL and the full limitations
list before approving a production change.
