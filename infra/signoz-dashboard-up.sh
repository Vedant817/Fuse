#!/usr/bin/env bash
# Provisions the "Fuse - Agent Cost Health" dashboard (task.md §8) against a
# running self-hosted SigNoz instance from infra/signoz/dashboards/
# fuse-agent-cost-health.json. Idempotent by title: an existing dashboard
# with the same title is UPDATED in place (unlike infra/signoz-alerts-up.sh's
# create-if-missing-only rules, a dashboard's panels are expected to be
# iterated on, so this script always applies the current JSON file's
# contents) rather than skipped.
#
# See docs/adr/008-signoz-dashboard-provisioning.md for the exact widget
# schema this file matches — verified by actually rendering it (a "No Data"
# empty state proves the schema round-trips correctly; anything less
# strict silently accepts a shape the frontend can't read at all, the same
# trap ADR-006 documents for alert rules).
set -euo pipefail

SIGNOZ_URL="${SIGNOZ_URL:-http://localhost:8080}"
SIGNOZ_ADMIN_EMAIL="${SIGNOZ_ADMIN_EMAIL:-admin@fuse.local}"
SIGNOZ_ADMIN_PASSWORD="${SIGNOZ_ADMIN_PASSWORD:-FuseLocalDev123!}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARD_FILE="$SCRIPT_DIR/signoz/dashboards/fuse-agent-cost-health.json"
DASHBOARD_TITLE=$(jq -r '.title' "$DASHBOARD_FILE")

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

echo "==> Looking for an existing \"$DASHBOARD_TITLE\" dashboard..."
existing=$(curl -sS -m 10 "$SIGNOZ_URL/api/v1/dashboards" -H "$auth_header")
dashboard_id=$(echo "$existing" | jq -r --arg title "$DASHBOARD_TITLE" \
  '.data[]? | select(.data.title == $title) | .id' | head -n1)

if [ -z "$dashboard_id" ]; then
  echo "==> Creating a new dashboard..."
  create_response=$(curl -sS -m 10 -X POST "$SIGNOZ_URL/api/v1/dashboards" \
    -H "$auth_header" -H "content-type: application/json" \
    -d "$(jq -n --arg title "$DASHBOARD_TITLE" '{title: $title, uploadedGrafana: false, version: "v5"}')")
  dashboard_id=$(echo "$create_response" | jq -r '.data.id // empty')
  if [ -z "$dashboard_id" ]; then
    echo "!! Failed to create the dashboard. Response:" >&2
    echo "   $create_response" >&2
    exit 1
  fi
  echo "    created id=$dashboard_id"
else
  echo "    found existing id=$dashboard_id — updating its panels."
fi

echo "==> Applying the current panel set..."
update_response=$(curl -sS -m 10 -X PUT "$SIGNOZ_URL/api/v1/dashboards/$dashboard_id" \
  -H "$auth_header" -H "content-type: application/json" \
  --data-binary "@$DASHBOARD_FILE")
if ! echo "$update_response" | jq -e '.data.id' >/dev/null 2>&1; then
  echo "!! Failed to update the dashboard. Response:" >&2
  echo "   $update_response" >&2
  exit 1
fi
widget_count=$(echo "$update_response" | jq -r '.data.data.widgets | length')
echo "    applied — $widget_count widget(s) now on the dashboard."
echo "==> Done. View it at: $SIGNOZ_URL/dashboard/$dashboard_id"
