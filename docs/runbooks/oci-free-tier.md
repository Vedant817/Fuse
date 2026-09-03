# Personal zero-cost deployment: OCI + Neon + GHCR

This is the recommended personal-project deployment, not an HA/SLA-backed
commercial production topology. It keeps the full Fuse product path,
including self-hosted SigNoz, while staying inside currently published free
allowances:

- one Oracle Cloud Always Free `VM.Standard.A1.Flex` Ubuntu VM using the full
  2 OCPUs and 12 GB RAM allowance;
- a 150 GB boot volume (within OCI's 200 GB combined Always Free block-volume
  allowance) and scheduled OCI volume backups;
- Neon Free Postgres for breaker state, registrations, idempotency, and audit;
- self-hosted SigNoz Foundry on the OCI VM;
- GHCR for the public multi-architecture Fuse image;
- the existing reserved ngrok HTTPS hostname for the control-plane and Slack
  interactive endpoint.

The tradeoffs are explicit: OCI may reclaim an idle Always Free VM, free-service
quotas and terms can change, and ngrok Free has no availability SLA. Fuse
remains fail-closed during an outage, but this topology
must not be described as highly available.

## 1. Accounts and values the owner must create

1. Create an OCI Free Tier tenancy. Choose the home region carefully; Always
   Free compute is tied to it.
2. Create a Neon Free project named `fuse-production`, PostgreSQL 16 or newer,
   and copy its pooled TLS connection string.
3. Keep the GitHub repository public so the published GHCR package can be
   pulled anonymously from the VM.
4. Retain the existing ngrok reserved hostname
   `appear-extradite-raven.ngrok-free.dev`. Only one free agent can own it at
   once, so stop the laptop tunnel before starting the VM tunnel.

Never paste bearer tokens, database credentials, Slack secrets, or the ngrok
authtoken into chat, Git, an image layer, or a Compose file.

## 2. Create the OCI VM

In the OCI Console:

1. Create an Ubuntu 24.04 ARM instance using `VM.Standard.A1.Flex`.
2. Allocate 2 OCPUs, 12 GB RAM, and a 150 GB boot volume.
3. Add your SSH public key.
4. In the subnet security list, allow inbound TCP 22 only from your own IP.
   Do not expose 8090, 4317, 4318, 8020, 8080, ClickHouse, or PostgreSQL.
5. Enable an OCI budget alert at `$1`; never select a non-Always-Free shape
   or paid load balancer.

Connect:

```bash
ssh ubuntu@OCI_PUBLIC_IP
```

Install Docker, Git, and basic host controls:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git ufw
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from YOUR_PUBLIC_IP to any port 22 proto tcp
sudo ufw --force enable
```

Log out and reconnect so Docker group membership applies.

## 3. Publish the release image

The checked-in `Release image` GitHub workflow verifies the full suite, builds
both `linux/amd64` and `linux/arm64`, and publishes to
`ghcr.io/vedant817/fuse-control-plane`.

First move the intended notes from `[Unreleased]` into a non-empty dated release
section. In GitHub, open **Actions → Release image → Run workflow** and set the
matching version, such as `vX.Y.Z-rc.1`. After it succeeds:

```bash
docker buildx imagetools inspect \
  ghcr.io/vedant817/fuse-control-plane:vX.Y.Z-rc.1
```

Record the `linux/arm64` manifest-list digest. Deployment must use
`ghcr.io/vedant817/fuse-control-plane@sha256:...`, never `latest`.

## 4. Install SigNoz and repository configuration

On the VM:

```bash
git clone https://github.com/Vedant817/Fuse.git fuse
cd fuse
./infra/signoz-up.sh
```

Wait for SigNoz and OTLP health. Keep its UI private and reach it only through
SSH forwarding:

```bash
ssh -L 8080:127.0.0.1:8080 ubuntu@OCI_PUBLIC_IP
```

Then open `http://localhost:8080` on the laptop. Create a least-privilege
SigNoz service account for MCP, start the MCP profile, and apply the checked-in
dashboard, alert rules, and Slack webhook channel using the existing scripts.

## 5. Install secrets on the VM

Create separate root-owned runtime and migration files:

```bash
sudo install -d -m 700 /etc/fuse
sudo install -m 600 /dev/null /etc/fuse/control-plane.env
sudo install -m 600 /dev/null /etc/fuse/migration.env
sudoedit /etc/fuse/control-plane.env
sudoedit /etc/fuse/migration.env
```

Generate each bearer token independently with `openssl rand -hex 32`. Populate
the runtime file from the local ignored `.env`, replacing `DATABASE_URL` with a
Neon pooled TLS URL for a DML-only `fuse_runtime` role and using host access for
the local SigNoz services:

```dotenv
DATABASE_URL=postgresql://fuse_runtime:...@...neon.../fuse?sslmode=require
CONTROL_PLANE_DEPLOYMENT_ENVIRONMENT=production
CONTROL_PLANE_DETECTOR_POLICY_FILE=/app/policies/production.json
CONTROL_PLANE_RATE_LIMIT_REDIS_URL=redis://redis:6379/0
CONTROL_PLANE_API_TOKENS=demo:...
CONTROL_PLANE_AGENT_API_TOKENS=demo:production:canary:...
CONTROL_PLANE_PREFLIGHT_EXPORTER_TOKENS=demo:production:canary:...
CONTROL_PLANE_WEBHOOK_TOKENS=demo:...
CONTROL_PLANE_STORE_OUTAGE_MODE=fail-closed
CONTROL_PLANE_WEBHOOK_POLICY_VERSION=fuse-production-v1
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_INCIDENT_CHANNEL=C0BKFBTFR4H
OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318
FUSE_SIGNOZ_MCP_URL=http://host.docker.internal:8020/mcp
```

The token portions represented by `...` must each be independent 64-character
hex values; agent and exporter values must differ. The matching exporter runtime
receives only the raw token as `FUSE_PREFLIGHT_EXPORTER_TOKEN`. The migration
file contains only a DDL-authorized connection:

```dotenv
DATABASE_URL=postgresql://fuse_migrator:...@...neon.../fuse?sslmode=require
```

Create and grant the external roles as documented in
`docs/runbooks/deployment.md`; Compose cannot enforce PostgreSQL privileges, but
the separate env files prevent the migration container from receiving runtime
API, Redis, Slack, or OTel secrets. Validate the runtime file through the same
parser used at startup:

```bash
pnpm --filter @fuse/control-plane run build
pnpm run validate:production-env -- /etc/fuse/control-plane.env
```

Do not copy LLM provider keys to the control-plane VM. Groq/NVIDIA keys belong
only in the agent workload that actually calls those providers.

## 6. Migrate and start Fuse

From the repository checkout:

```bash
export FUSE_CONTROL_PLANE_IMAGE='ghcr.io/vedant817/fuse-control-plane@sha256:...'
export FUSE_ENV_FILE=/etc/fuse/control-plane.env
export FUSE_MIGRATION_ENV_FILE=/etc/fuse/migration.env

docker compose -f infra/production/oci-free/compose.yaml \
  --env-file /etc/fuse/control-plane.env \
  --profile tools run --rm migrate
docker compose -f infra/production/oci-free/compose.yaml \
  --env-file /etc/fuse/control-plane.env \
  up -d control-plane
docker compose -f infra/production/oci-free/compose.yaml \
  --env-file /etc/fuse/control-plane.env \
  ps

curl --fail http://127.0.0.1:8090/healthz
curl --fail http://127.0.0.1:8090/readyz
```

## 7. Move the reserved ngrok hostname to OCI

Stop the laptop's ngrok process first. On the VM, install ngrok from its
official repository, add the existing account authtoken locally, and verify:

```bash
ngrok config add-authtoken YOUR_NGROK_AUTHTOKEN
ngrok http --url=appear-extradite-raven.ngrok-free.dev 8090
curl --fail https://appear-extradite-raven.ngrok-free.dev/healthz
```

Install that exact command as a systemd unit with `Restart=always`; store the
authtoken in ngrok's root-readable config, not in the unit. In Slack App
settings, keep **Interactivity & Shortcuts → Request URL** set to:

```text
https://appear-extradite-raven.ngrok-free.dev/v1/slack/interactive
```

## 8. Canary and backup

Before calling it deployed:

1. register a dedicated `demo/production/canary` scope;
2. confirm permit returns allowed;
3. submit a 100,000-token detector observation;
4. confirm the direct trip, next guarded-call denial, PostgreSQL audit and
   diagnosis rows, exporter-role-reported Preflight, SigNoz evidence, and Slack
   card;
5. click **Resume (requires reason)** and confirm permit recovers;
6. reboot the VM and confirm SigNoz, Fuse, and ngrok recover automatically;
7. schedule OCI boot-volume backups and a monthly Neon logical export;
8. set retention for ClickHouse telemetry, idempotency keys, and breaker audit
   rows before the 150 GB disk or 0.5 GB Neon allowance is exhausted.

Keep the original Kubernetes deployment for a future paid/HA move. The OCI
Compose path is the smallest honest zero-cost topology for this personal
deployment.
