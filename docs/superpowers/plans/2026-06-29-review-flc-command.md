# Plan: `/review-flc` Slack Command (v1)

Spec: `docs/superpowers/specs/2026-06-29-review-flc-command-design.md`
Source FLC: `features/flc-review-flc-slack-command.md`
Process: `docs/process/adding-a-connector.md`

## Connector-process phases — what was done vs. deliberately skipped

| Phase | Status | Notes |
|-------|--------|-------|
| A — Planning (spec + plan) | Done | This plan + the design spec. |
| B — Storage (migration + repo) | **Skipped** | v1 has no persistence. A review is one request/response cycle; findings live in an in-memory `Map` keyed by the result message `ts` (capped at 100). No table, no repo. |
| C — Client | Done | `src/connectors/notion/client.ts` (`NotionApiClient`) over `@notionhq/client`, injectable `fetch`, typed `NotionApiError`. |
| D — Connector & tools | Adapted | No `ToolDef`/registry connector — this is a slash command, not an LLM tool. The "connector" is the Notion client + the review service + the Slack command. |
| E — Wire-up in `index.ts` | Done | `NOTION_API_TOKEN` via env or vault; conditional construction (`if (token) … else logger.warn`); registered in `registerExtra`. No `decideCommandChannel` gating (any conversation). |
| F — Live Reports integration | **Skipped** | Not a Live Reports tool — there is no user-facing report built from it, so no `WHITELISTED_TOOLS` entry and no `tool-output-shapes.ts` sample. |
| G — LLM prompt docs | **Skipped** | Not an orchestrator LLM tool — `/review-flc` is a Slack slash command, never dispatched by the orchestrator, so it is not in the tool registry and needs no `src/orchestrator/prompts.ts` bullet. |
| H — Validation + smoke | Done (unit) / staged (live) | `vitest` + `tsc` + `build` green. Live smoke scripts written but NOT run (no real token at implementation time). |
| I — Deployment | **Deferred to the user** | No `fly deploy`, no Slack dashboard registration, no vault write — manual steps. |

## Tasks (all complete)

1. **Dependency** — `npm install @notionhq/client` (v5.22.0). ✅
2. **Notion client** — `resolvePageId` (slug/bare/dashed/`/p/`), `getPageMarkdown`
   (recursive + paginated; returns markdown + `{ blockId, text }[]`),
   `createPageComment`, `createBlockComment`, `NotionApiError`. ✅
3. **Review service** — `buildSystemPrompt` (standard + JSON contract scoped to
   selected areas), `reviewFlc` (resilient Claude + zod + one parse retry),
   `loadReviewStandard` (path relative to compiled module). ✅
4. **Slack command** — modal (URL + 5 preset area checkboxes), submit validation,
   "reviewing…" → findings render (checkbox per finding) → "Post selected as
   comments" (block comment with page fallback; reports posted/fallback/failed).
   In-memory store keyed by `ts`. ✅
5. **Wire-up** — `env.NOTION_API_TOKEN`, vault read, conditional construct +
   register. ✅
6. **Build** — `postbuild` copies `src/prompts/*.md` → `dist/prompts/`; Dockerfile
   copies them inline after `tsc`. ✅
7. **Smoke scripts** — `scripts/smoke-notion.sh` (curl, expect 200) and
   `scripts/smoke-notion-tools.mjs` (compiled-client resolve + fetch + DRY_RUN
   comment). Written, not run. ✅
8. **Tests** — Notion client, review service, command handlers. ✅

## Validation (run, all green)

- `npx vitest run` — all new tests pass (pre-existing pipedrive `last_30_days`
  date-fixture failures are unrelated to this work).
- `npx tsc --noEmit` — clean.
- `npm run build` — clean; `dist/prompts/flc-review-standard.md` shipped.

## Manual follow-up (user)

1. Create a Notion internal integration; put its token in the Supabase vault as
   `NOTION_API_TOKEN`.
2. Share the FLC Notion space (or pages) with that integration.
3. Register the `/review-flc` slash command in the Slack app dashboard (request
   URL = the bot's `/slack/events`).
4. Run the smoke scripts once the token exists, then `fly deploy`.
