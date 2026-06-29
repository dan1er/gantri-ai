#!/usr/bin/env bash
# Smoke test for the Notion connector — hits the endpoints the /review-flc client
# uses against the live Notion API and expects HTTP 200. Run BEFORE merging any
# change to src/connectors/notion/.
#
# NOTE: do NOT run this until a real NOTION_API_TOKEN exists in the vault and the
# target FLC page has been shared with the reviewer integration. No token is
# available at implementation time.
#
# Usage:
#   NOTION_API_TOKEN=<token> NOTION_TEST_PAGE_ID=<32-char page id> ./scripts/smoke-notion.sh
#
# Or pull from the Supabase vault:
#   NOTION_API_TOKEN=$(supabase ... read_vault_secret 'NOTION_API_TOKEN') \
#     NOTION_TEST_PAGE_ID=<id> ./scripts/smoke-notion.sh
#
# Exit code: 0 if all 200, 1 if any non-200.

set -uo pipefail

if [ -z "${NOTION_API_TOKEN:-}" ]; then
  echo "ERROR: NOTION_API_TOKEN env var is required" >&2
  exit 2
fi
if [ -z "${NOTION_TEST_PAGE_ID:-}" ]; then
  echo "ERROR: NOTION_TEST_PAGE_ID env var is required (a page shared with the integration)" >&2
  exit 2
fi

AUTH="Authorization: Bearer ${NOTION_API_TOKEN}"
# Pin a Notion-Version. Bump alongside the @notionhq/client version if the SDK
# default changes (Client.defaultNotionVersion).
VER="Notion-Version: 2025-09-03"
B="https://api.notion.com/v1"
FAIL=0

run_test() {
  local name="$1"
  local url="$2"
  local code
  code=$(curl -s -o /tmp/smoke-notion-resp.json -w "%{http_code}" -H "$AUTH" -H "$VER" "$url")
  local note=""
  if [ "$code" != "200" ]; then
    note=$(head -c 120 /tmp/smoke-notion-resp.json | tr '\n' ' ')
    FAIL=1
  fi
  printf "  %-44s %s  %s\n" "$name" "$code" "$note"
}

echo "Notion smoke test — all endpoints must return 200"
echo "  Endpoint                                     CODE  notes"
echo "  -------------------------------------------- ----- -------"

run_test "GET /users/me (token + integration ok)"  "$B/users/me"
run_test "GET /pages/{id}"                          "$B/pages/${NOTION_TEST_PAGE_ID}"
run_test "GET /blocks/{id}/children"                "$B/blocks/${NOTION_TEST_PAGE_ID}/children?page_size=5"

rm -f /tmp/smoke-notion-resp.json
echo ""
if [ "$FAIL" = "0" ]; then
  echo "  ✓ all 3 endpoints returned 200"
  exit 0
else
  echo "  ✗ at least one endpoint failed — see notes column above"
  echo "    403/404 on the page usually means the page isn't shared with the integration."
  exit 1
fi
