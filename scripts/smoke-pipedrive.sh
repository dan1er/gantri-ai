#!/usr/bin/env bash
# Smoke test for the Pipedrive connector — hits every endpoint the bot uses
# against the live tenant and expects HTTP 200. Run BEFORE merging any change
# to src/connectors/pipedrive/.
#
# Usage:
#   PIPEDRIVE_API_TOKEN=<token> ./scripts/smoke-pipedrive.sh
#
# Or pull from Supabase vault:
#   PIPEDRIVE_API_TOKEN=$(supabase ... read_vault_secret 'PIPEDRIVE_API_TOKEN') ./scripts/smoke-pipedrive.sh
#
# Exit code: 0 if all 200, 1 if any non-200.

set -uo pipefail

if [ -z "${PIPEDRIVE_API_TOKEN:-}" ]; then
  echo "ERROR: PIPEDRIVE_API_TOKEN env var is required" >&2
  exit 2
fi

H="x-api-token: ${PIPEDRIVE_API_TOKEN}"
B="https://api.pipedrive.com"
FAIL=0

run_test() {
  local name="$1"
  local url="$2"
  local code
  code=$(curl -s -o /tmp/smoke-pipedrive-resp.json -w "%{http_code}" -H "$H" -H "Accept: application/json" "$url")
  local note=""
  if [ "$code" != "200" ]; then
    note=$(head -c 100 /tmp/smoke-pipedrive-resp.json | tr '\n' ' ')
    FAIL=1
  fi
  printf "  %-50s %s  %s\n" "$name" "$code" "$note"
}

echo "Pipedrive smoke test — all endpoints must return 200"
echo "  Endpoint                                            CODE  notes"
echo "  --------------------------------------------------- ----- -------"

# Directory (cached 10 min in client)
run_test "GET /v1/pipelines"               "$B/v1/pipelines"
run_test "GET /v1/stages"                  "$B/v1/stages"
run_test "GET /v1/users"                   "$B/v1/users"
run_test "GET /v1/dealFields"              "$B/v1/dealFields"

# Aggregation (NOT cached)
run_test "GET /v1/deals/timeline"          "$B/v1/deals/timeline?start_date=2026-01-01&interval=month&amount=3&field_key=won_time"
run_test "GET /v1/deals/summary"           "$B/v1/deals/summary?status=open"

# Lists
run_test "GET /v1/deals (lost)"            "$B/v1/deals?status=lost&limit=1"
run_test "GET /api/v2/deals"               "$B/api/v2/deals?limit=1"
run_test "GET /api/v2/organizations"       "$B/api/v2/organizations?limit=1"
run_test "GET /api/v2/persons"             "$B/api/v2/persons?limit=1"
run_test "GET /v1/activities"              "$B/v1/activities?limit=1"

# Detail (uses fixed IDs that exist on Gantri's tenant)
run_test "GET /api/v2/deals/{id}"          "$B/api/v2/deals/816"
run_test "GET /api/v2/organizations/{id}"  "$B/api/v2/organizations/12"

# Search
run_test "GET /v1/itemSearch"              "$B/v1/itemSearch?term=Rarify&limit=1"

rm -f /tmp/smoke-pipedrive-resp.json
echo ""
if [ "$FAIL" = "0" ]; then
  echo "  ✓ all 14 endpoints returned 200"
  exit 0
else
  echo "  ✗ at least one endpoint failed — see notes column above"
  exit 1
fi
