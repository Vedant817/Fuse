#!/usr/bin/env bash
# Provisions the fuse-control-plane webhook notification channel and the
# three detector alert rules (infra/signoz/alerts/*.json) against a running
# self-hosted SigNoz instance (see infra/signoz-up.sh), closing task.md
# §4.5: "SigNoz alerting, rather than an undisclosed parallel path,
# triggers the demo breaker."
#
# Idempotent by name: the channel is created or fully updated so URL/token
# rotation takes effect; alert rules remain create-if-missing because their
# fixed thresholds are versioned in source and a rule replacement needs an
# explicit rollout decision.
#
# Login flow (non-interactive; see docs/adr/006-signoz-alert-rule-
# provisioning.md for how this was reverse-engineered against the real
# instance, since it is undocumented and several plausible-looking paths
# silently fall through to the frontend instead of erroring):
#   1. GET  /api/v2/sessions/context?email=...&ref=...   -> resolves orgID
#   2. POST /api/v2/sessions/email_password               -> bearer JWT
set -euo pipefail

SIGNOZ_URL="${SIGNOZ_URL:-http://localhost:8080}"
SIGNOZ_ADMIN_EMAIL="${SIGNOZ_ADMIN_EMAIL:-admin@fuse.local}"
SIGNOZ_ADMIN_PASSWORD="${SIGNOZ_ADMIN_PASSWORD:-FuseLocalDev123!}"
# From inside the SigNoz/collector containers' Docker network, the control
# plane (running on the host) is reached via the Docker Desktop/OrbStack
# host gateway name, not localhost.
CONTROL_PLANE_WEBHOOK_URL="${CONTROL_PLANE_WEBHOOK_URL:-http://host.docker.internal:8090/v1/webhooks/signoz}"
CONTROL_PLANE_WEBHOOK_TOKEN="${CONTROL_PLANE_WEBHOOK_TOKEN:-}"

if [ -z "$CONTROL_PLANE_WEBHOOK_TOKEN" ]; then
  echo "!! CONTROL_PLANE_WEBHOOK_TOKEN is required (one token from this" >&2
  echo "   control plane's CONTROL_PLANE_WEBHOOK_TOKENS config)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALERTS_DIR="$SCRIPT_DIR/signoz/alerts"
CHANNELS_DIR="$SCRIPT_DIR/signoz/channels"

echo "==> Resolving org for $SIGNOZ_ADMIN_EMAIL..."
context_response=$(curl -sS -m 10 \
  "$SIGNOZ_URL/api/v2/sessions/context?email=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$SIGNOZ_ADMIN_EMAIL")&ref=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$SIGNOZ_URL/login")")
org_id=$(echo "$context_response" | jq -r '.data.orgs[0].id // empty')
if [ -z "$org_id" ]; then
  echo "!! Could not resolve an org for $SIGNOZ_ADMIN_EMAIL. Response:" >&2
  echo "   $context_response" >&2
  exit 1
fi

echo "==> Logging in (org $org_id)..."
login_response=$(curl -sS -m 10 -X POST "$SIGNOZ_URL/api/v2/sessions/email_password" \
  -H "content-type: application/json" \
  -d "$(jq -n --arg email "$SIGNOZ_ADMIN_EMAIL" --arg password "$SIGNOZ_ADMIN_PASSWORD" --arg orgID "$org_id" \
    '{email: $email, password: $password, orgID: $orgID}')")
access_token=$(echo "$login_response" | jq -r '.data.accessToken // empty')
if [ -z "$access_token" ]; then
  echo "!! Login did not return an accessToken. Response:" >&2
  echo "   $login_response" >&2
  exit 1
fi
auth_header="Authorization: Bearer $access_token"

echo "==> Ensuring the fuse-control-plane webhook channel exists..."
existing_channels=$(curl -sS -m 10 "$SIGNOZ_URL/api/v1/channels" -H "$auth_header")
channel_body=$(jq \
  --arg url "$CONTROL_PLANE_WEBHOOK_URL" \
  --arg token "$CONTROL_PLANE_WEBHOOK_TOKEN" \
  '.webhook_configs[0].url = $url | .webhook_configs[0].http_config.authorization.credentials = $token' \
  "$CHANNELS_DIR/fuse-control-plane.json")
if echo "$existing_channels" | jq -e '.data[]? | select(.name == "fuse-control-plane")' >/dev/null; then
  channel_id=$(echo "$existing_channels" | jq -r \
    '.data[]? | select(.name == "fuse-control-plane") | .id' | head -n 1)
  update_response=$(curl -sS -m 30 -X PUT \
    "$SIGNOZ_URL/api/v1/channels/$channel_id" \
    -H "$auth_header" -H "content-type: application/json" -d "$channel_body" \
    -w $'\n%{http_code}')
  update_status="${update_response##*$'\n'}"
  update_body="${update_response%$'\n'*}"
  if [[ "$update_status" != 2* ]]; then
    echo "!! Failed to update the webhook channel (HTTP $update_status). Response:" >&2
    echo "   $update_body" >&2
    exit 1
  fi
  echo "    updated."
else
  create_response=$(curl -sS -m 10 -X POST "$SIGNOZ_URL/api/v1/channels" \
    -H "$auth_header" -H "content-type: application/json" -d "$channel_body")
  if ! echo "$create_response" | jq -e '.data.id' >/dev/null 2>&1; then
    echo "!! Failed to create the webhook channel. Response:" >&2
    echo "   $create_response" >&2
    exit 1
  fi
  echo "    created."
fi

echo "==> Ensuring the three detector alert rules exist..."
existing_rules=$(curl -sS -m 10 "$SIGNOZ_URL/api/v2/rules" -H "$auth_header")
for rule_file in "$ALERTS_DIR"/*.json; do
  alert_name=$(jq -r '.alert' "$rule_file")
  if echo "$existing_rules" | jq -e --arg name "$alert_name" '.data[]? | select(.alert == $name)' >/dev/null; then
    echo "    $alert_name already exists — skipping."
    continue
  fi
  create_response=$(curl -sS -m 10 -X POST "$SIGNOZ_URL/api/v2/rules" \
    -H "$auth_header" -H "content-type: application/json" -d "@$rule_file")
  if ! echo "$create_response" | jq -e '.data.id' >/dev/null 2>&1; then
    echo "!! Failed to create $alert_name. Response:" >&2
    echo "   $create_response" >&2
    exit 1
  fi
  echo "    $alert_name created."
done

echo "==> Done."
