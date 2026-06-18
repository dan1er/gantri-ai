#!/usr/bin/env bash
# Smoke test for the SendGrid connector — hits the Email Activity endpoints the
# bot uses against the live account and expects HTTP 200. Run BEFORE merging any
# change to src/connectors/sendgrid/.
#
# IMPORTANT: the /v3/messages Email Activity API requires the paid "Email
# Activity History" add-on on the SendGrid account. Without it these calls
# return 403 — that is an account billing setting, not a bug in this connector.
#
# Usage:
#   SENDGRID_API_KEY=<key> ./scripts/smoke-sendgrid.sh
#
# Or pull from Supabase vault:
#   SENDGRID_API_KEY=$(supabase ... read_vault_secret 'SENDGRID_API_KEY') ./scripts/smoke-sendgrid.sh
#
# Exit code: 0 if all 200, 1 if any non-200.

set -uo pipefail

if [ -z "${SENDGRID_API_KEY:-}" ]; then
  echo "ERROR: SENDGRID_API_KEY env var is required" >&2
  exit 2
fi

H="Authorization: Bearer ${SENDGRID_API_KEY}"
B="https://api.sendgrid.com"
FAIL=0

run_test() {
  local name="$1"
  local url="$2"
  local code
  code=$(curl -s -o /tmp/smoke-sendgrid-resp.json -w "%{http_code}" -H "$H" -H "Accept: application/json" "$url")
  local note=""
  if [ "$code" != "200" ]; then
    note=$(head -c 120 /tmp/smoke-sendgrid-resp.json | tr '\n' ' ')
    FAIL=1
  fi
  printf "  %-46s %s  %s\n" "$name" "$code" "$note"
}

echo "SendGrid smoke test — all endpoints must return 200"
echo "  (403 => account is missing the Email Activity History add-on)"
echo "  Endpoint                                       CODE  notes"
echo "  ---------------------------------------------- ----- -------"

# List the most-recent message (no query filter). Captures the first msg_id so
# we can probe the detail endpoint with a real id.
run_test "GET /v3/messages?limit=1"  "$B/v3/messages?limit=1"

MSG_ID=""
if command -v jq >/dev/null 2>&1; then
  MSG_ID=$(jq -r '.messages[0].msg_id // empty' /tmp/smoke-sendgrid-resp.json 2>/dev/null)
fi

if [ -n "$MSG_ID" ]; then
  run_test "GET /v3/messages/{id}" "$B/v3/messages/${MSG_ID}"
else
  echo "  (skipping /v3/messages/{id} — no msg_id available from the list call)"
fi

rm -f /tmp/smoke-sendgrid-resp.json
echo ""
if [ "$FAIL" = "0" ]; then
  echo "  ✓ all reachable endpoints returned 200"
  exit 0
else
  echo "  ✗ at least one endpoint failed — see notes column above (403 = add-on missing)"
  exit 1
fi
