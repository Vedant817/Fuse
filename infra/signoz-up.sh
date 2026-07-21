#!/usr/bin/env bash
# Brings up self-hosted SigNoz (via Foundry: https://github.com/SigNoz/foundry)
# from infra/signoz/casting.yaml — the checked-in source of truth — and
# completes SigNoz's one-time first-run org/admin bootstrap non-interactively.
# Safe to re-run: `foundryctl cast` is idempotent, and the bootstrap step
# skips itself once `setupCompleted` is already true.
#
# Local dev only. The admin credentials this script creates are a fixed,
# publicly-known local default (see below) — never expose this deployment's
# port 8080 beyond localhost, and never reuse these credentials anywhere
# real. Override with SIGNOZ_ADMIN_EMAIL/SIGNOZ_ADMIN_PASSWORD if you want
# different local values.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/signoz"

SIGNOZ_URL="${SIGNOZ_URL:-http://localhost:8080}"
SIGNOZ_ADMIN_NAME="${SIGNOZ_ADMIN_NAME:-Fuse Local Admin}"
SIGNOZ_ADMIN_EMAIL="${SIGNOZ_ADMIN_EMAIL:-admin@fuse.local}"
SIGNOZ_ADMIN_PASSWORD="${SIGNOZ_ADMIN_PASSWORD:-FuseLocalDev123!}"
SIGNOZ_ORG_NAME="${SIGNOZ_ORG_NAME:-fuse-local}"

if ! command -v foundryctl >/dev/null 2>&1; then
  echo "==> foundryctl not found on PATH; installing (official installer, curl | bash)..."
  echo "    See https://github.com/SigNoz/foundry — installs to \$XDG_BIN_HOME or ~/.local/bin."
  curl -fsSL https://signoz.io/foundry.sh | bash -s -- -y
  export PATH="$HOME/.local/bin:$PATH"
fi

echo "==> Casting the self-hosted SigNoz stack (infra/signoz/casting.yaml)..."
foundryctl cast -f casting.yaml

echo "==> Waiting for the SigNoz backend health endpoint..."
for _ in $(seq 1 60); do
  if curl -sS -m 2 "$SIGNOZ_URL/api/v1/health" 2>/dev/null | grep -q '"status":"ok"'; then
    break
  fi
  sleep 2
done

echo "==> Checking first-run setup status..."
setup_completed=$(curl -sS -m 5 "$SIGNOZ_URL/api/v1/version" | grep -o '"setupCompleted":[a-z]*' | cut -d: -f2)

if [ "$setup_completed" = "true" ]; then
  echo "==> Setup already completed — skipping admin/org bootstrap."
else
  echo "==> Completing first-run setup (creates the initial org, without which the"
  echo "    OTel collector cannot register itself and OTLP ingestion stays dark)..."
  register_response=$(curl -sS -m 10 -X POST "$SIGNOZ_URL/api/v1/register" \
    -H "content-type: application/json" \
    -d "{\"name\":\"$SIGNOZ_ADMIN_NAME\",\"email\":\"$SIGNOZ_ADMIN_EMAIL\",\"password\":\"$SIGNOZ_ADMIN_PASSWORD\",\"orgId\":\"\",\"orgName\":\"$SIGNOZ_ORG_NAME\",\"isAnonymous\":false}")
  if ! echo "$register_response" | grep -q '"status":"success"'; then
    echo "!! Registration did not report success (may be a real error, or setup"
    echo "   completed between the check above and this call — safe to ignore if"
    echo "   the reason is \"self-registration is disabled\"/already-registered):"
    echo "   $register_response"
  fi
  echo "==> Waiting for the OTel collector to register and its OTLP receivers to start..."
  for _ in $(seq 1 60); do
    if curl -sS -m 2 -o /dev/null http://localhost:4318/ 2>/dev/null; then
      break
    fi
    sleep 2
  done
fi

echo "==> Done. SigNoz UI: $SIGNOZ_URL (login: $SIGNOZ_ADMIN_EMAIL)"
echo "    OTLP endpoint for FUSE_OTEL/OTEL_EXPORTER_OTLP_ENDPOINT: http://localhost:4318"
