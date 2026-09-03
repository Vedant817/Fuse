#!/usr/bin/env bash
# Provisions and updates the control-plane detector webhook, Preflight Slack
# channel, and every checked-in alert rule. Persisted rules are fetched after
# apply and checked against source so episode-binding labels cannot silently
# disappear during an API migration.
set -euo pipefail
umask 077

SIGNOZ_URL="${SIGNOZ_URL:-http://localhost:8080}"
SIGNOZ_ADMIN_EMAIL="${SIGNOZ_ADMIN_EMAIL:-admin@fuse.local}"
SIGNOZ_ADMIN_PASSWORD="${SIGNOZ_ADMIN_PASSWORD:-FuseLocalDev123!}"
CONTROL_PLANE_WEBHOOK_URL="${CONTROL_PLANE_WEBHOOK_URL:-http://host.docker.internal:8090/v1/webhooks/signoz}"
CONTROL_PLANE_WEBHOOK_TOKEN="${CONTROL_PLANE_WEBHOOK_TOKEN:-}"
PREFLIGHT_SLACK_WEBHOOK_URL="${PREFLIGHT_SLACK_WEBHOOK_URL:-}"
export SIGNOZ_ADMIN_EMAIL SIGNOZ_ADMIN_PASSWORD CONTROL_PLANE_WEBHOOK_URL
export CONTROL_PLANE_WEBHOOK_TOKEN PREFLIGHT_SLACK_WEBHOOK_URL

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ALERTS_DIR="$SCRIPT_DIR/signoz/alerts"
CHANNELS_DIR="$SCRIPT_DIR/signoz/channels"
CONTRACT_TOOL="$REPO_DIR/tools/signoz-alerts/contract.mjs"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
EXPANDED_RULES_DIR="$WORK_DIR/rules"
mkdir -p "$EXPANDED_RULES_DIR"

if [ -z "$CONTROL_PLANE_WEBHOOK_TOKEN" ]; then
  echo "!! CONTROL_PLANE_WEBHOOK_TOKEN is required." >&2
  exit 1
fi
if ! node "$CONTRACT_TOOL" validate-slack-webhook; then
  echo "!! Configure a real Slack app Incoming Webhook; placeholder URLs are rejected." >&2
  exit 1
fi

request() {
  local operation="$1"
  local method="$2"
  local url="$3"
  local output="$4"
  local data_file="${5:-}"
  local -a args=(-sS -m 30 -X "$method" "$url" -o "$output" -w '%{http_code}')
  if [ -n "${access_token:-}" ]; then
    args+=(--config "$WORK_DIR/auth.curlrc")
  fi
  if [ -n "$data_file" ]; then
    args+=(-H 'content-type: application/json' --data-binary "@$data_file")
  fi
  local status
  status=$(curl "${args[@]}")
  if [[ "$status" != 2* ]]; then
    echo "!! $operation failed (HTTP $status); response body suppressed." >&2
    return 1
  fi
}

echo "==> Resolving SigNoz organization..."
encoded_email=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$SIGNOZ_ADMIN_EMAIL")
encoded_ref=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$SIGNOZ_URL/login")
request "organization lookup" GET \
  "$SIGNOZ_URL/api/v2/sessions/context?email=$encoded_email&ref=$encoded_ref" \
  "$WORK_DIR/context.json"
org_id=$(jq -r '.data.orgs[0].id // empty' "$WORK_DIR/context.json")
if [ -z "$org_id" ]; then
  echo "!! SigNoz organization lookup returned no organization; response body suppressed." >&2
  exit 1
fi

jq -n --arg orgID "$org_id" \
  '{email: env.SIGNOZ_ADMIN_EMAIL, password: env.SIGNOZ_ADMIN_PASSWORD, orgID: $orgID}' \
  > "$WORK_DIR/login-request.json"
request "SigNoz login" POST "$SIGNOZ_URL/api/v2/sessions/email_password" \
  "$WORK_DIR/login-response.json" "$WORK_DIR/login-request.json"
access_token=$(jq -r '.data.accessToken // empty' "$WORK_DIR/login-response.json")
if [ -z "$access_token" ]; then
  echo "!! SigNoz login returned no access token; response body suppressed." >&2
  exit 1
fi
printf 'header = "Authorization: Bearer %s"\n' "$access_token" > "$WORK_DIR/auth.curlrc"

request "channel listing" GET "$SIGNOZ_URL/api/v1/channels" \
  "$WORK_DIR/channels.json"

apply_channel() {
  local name="$1"
  local body_file="$2"
  local id
  id=$(jq -r --arg name "$name" '.data[]? | select(.name == $name) | .id' \
    "$WORK_DIR/channels.json" | head -n 1)
  if [ -n "$id" ]; then
    request "updating channel $name" PUT "$SIGNOZ_URL/api/v1/channels/$id" \
      "$WORK_DIR/channel-response.json" "$body_file"
    echo "    $name updated."
  else
    request "creating channel $name" POST "$SIGNOZ_URL/api/v1/channels" \
      "$WORK_DIR/channel-response.json" "$body_file"
    echo "    $name created."
  fi
}

echo "==> Applying notification channels..."
jq '.webhook_configs[0].url = env.CONTROL_PLANE_WEBHOOK_URL | .webhook_configs[0].http_config.authorization.credentials = env.CONTROL_PLANE_WEBHOOK_TOKEN' \
  "$CHANNELS_DIR/fuse-control-plane.json" > "$WORK_DIR/control-plane-channel.json"
apply_channel fuse-control-plane "$WORK_DIR/control-plane-channel.json"

jq '.slack_configs[0].api_url = env.PREFLIGHT_SLACK_WEBHOOK_URL' \
  "$CHANNELS_DIR/fuse-preflight-health.json" > "$WORK_DIR/preflight-channel.json"
apply_channel fuse-preflight-health "$WORK_DIR/preflight-channel.json"

jq '.slack_configs[0].api_url = env.PREFLIGHT_SLACK_WEBHOOK_URL' \
  "$CHANNELS_DIR/fuse-operations.json" > "$WORK_DIR/operations-channel.json"
apply_channel fuse-operations "$WORK_DIR/operations-channel.json"

for artifact in "$ALERTS_DIR"/*.json; do
  artifact_name="$(basename "$artifact" .json)"
  if [ "$(jq -r 'type' "$artifact")" = "array" ]; then
    jq -c '.[]' "$artifact" | while IFS= read -r rule; do
      alert_name="$(jq -r '.alert' <<< "$rule")"
      printf '%s\n' "$rule" > "$EXPANDED_RULES_DIR/$artifact_name-$alert_name.json"
    done
  else
    cp "$artifact" "$EXPANDED_RULES_DIR/$artifact_name.json"
  fi
done

echo "==> Applying checked-in alert rules..."
request "rule listing" GET "$SIGNOZ_URL/api/v2/rules" "$WORK_DIR/rules-before.json"
for rule_file in "$EXPANDED_RULES_DIR"/*.json; do
  alert_name=$(jq -r '.alert' "$rule_file")
  rule_id=$(jq -r --arg name "$alert_name" \
    '.data[]? | select(.alert == $name) | .id' "$WORK_DIR/rules-before.json" | head -n 1)
  if [ -n "$rule_id" ]; then
    request "updating rule $alert_name" PUT "$SIGNOZ_URL/api/v2/rules/$rule_id" \
      "$WORK_DIR/rule-response.json" "$rule_file"
    echo "    $alert_name updated."
  else
    request "creating rule $alert_name" POST "$SIGNOZ_URL/api/v2/rules" \
      "$WORK_DIR/rule-response.json" "$rule_file"
    echo "    $alert_name created."
  fi
done

request "rule round-trip listing" GET "$SIGNOZ_URL/api/v2/rules" \
  "$WORK_DIR/rules-after.json"
for rule_file in "$EXPANDED_RULES_DIR"/*.json; do
  node "$CONTRACT_TOOL" verify-rule "$rule_file" "$WORK_DIR/rules-after.json"
done

echo "==> Done. All rules round-tripped with their checked-in groupings."
