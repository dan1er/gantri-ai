#!/usr/bin/env bash
# Smoke test for the Asana connector — hits every endpoint the bot uses against
# the live workspace and expects HTTP 200. Run BEFORE merging any change to
# src/connectors/asana/.
#
# Usage:
#   ASANA_ACCESS_TOKEN=<token> ./scripts/smoke-asana.sh
#
# Or pull from Supabase vault:
#   ASANA_ACCESS_TOKEN=$(supabase ... read_vault_secret 'ASANA_ACCESS_TOKEN') ./scripts/smoke-asana.sh
#
# Exit code: 0 if all 200, 1 if any non-200.

set -uo pipefail

if [ -z "${ASANA_ACCESS_TOKEN:-}" ]; then
  echo "ERROR: ASANA_ACCESS_TOKEN env var is required" >&2
  exit 2
fi

H="Authorization: Bearer ${ASANA_ACCESS_TOKEN}"
B="https://app.asana.com/api/1.0"
BOARD="1210754051061529"       # Software Board project
SAMPLE_TASK="1214467028143235" # a real Feature task on the board
FAIL=0

run_test() {
  local name="$1"
  local url="$2"
  local code
  code=$(curl -s -o /tmp/smoke-asana-resp.json -w "%{http_code}" -H "$H" -H "Accept: application/json" "$url")
  local note=""
  if [ "$code" != "200" ]; then
    note=$(head -c 120 /tmp/smoke-asana-resp.json | tr '\n' ' ')
    FAIL=1
  fi
  printf "  %-48s %s  %s\n" "$name" "$code" "$note"
}

echo "Asana smoke test — all endpoints must return 200"
echo "  Endpoint                                         CODE  notes"
echo "  ------------------------------------------------ ----- -------"

run_test "GET /users/me"                 "$B/users/me?opt_fields=name,email"
run_test "GET /projects/{board}"         "$B/projects/$BOARD?opt_fields=name"
run_test "GET /projects/{board}/tasks"   "$B/projects/$BOARD/tasks?limit=1&opt_fields=name,custom_fields.gid,custom_fields.enum_value.gid"
run_test "GET /tasks/{sample}/stories"   "$B/tasks/$SAMPLE_TASK/stories?limit=1&opt_fields=created_at,created_by.name,resource_subtype,text"

rm -f /tmp/smoke-asana-resp.json
echo ""
if [ "$FAIL" = "0" ]; then
  echo "  ✓ all 4 endpoints returned 200"
  exit 0
else
  echo "  ✗ at least one endpoint failed — see notes column above"
  exit 1
fi
