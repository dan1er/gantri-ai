# Plan — Asana `feature_qa_stats`

**Date:** 2026-07-13 · **Branch:** `feat/asana-feature-qa-stats`

Retro-documentation of the implementation (spec:
`docs/superpowers/specs/2026-07-13-asana-feature-qa-stats-design.md`). Phases map
to `docs/process/adding-a-connector.md`.

## Phase B — Storage
Skipped. No persistent state; results computed on demand and cached by the
existing cache-policy layer.

## Phase C — Client
`src/connectors/asana/client.ts` — `AsanaApiClient` ({ accessToken, fetchImpl?,
baseUrl? }), `Authorization: Bearer` header, typed `AsanaApiError(message,
status, body)`, offset pagination via `next_page.offset` (50-page cap),
retry-once on 429/5xx. Methods: `getProjectTasks`, `getTaskStories`,
`getCurrentUser`. Interfaces: `AsanaTask`, `AsanaStory`, `AsanaUser`,
`AsanaCustomFieldValue`.
Tests: `tests/unit/connectors/asana/client.test.ts`.

## Phase D — Connector & tools
- `board-config.ts` — validated gids (workspace, board, Type field + Feature
  option, all section gids) + section-name sets (QA stages, bounce targets,
  reopen from/to) + QA roster (Matt/Josh) + `isQaReviewer`/`shortNameFor`.
- `story-analyzer.ts` (PURE) — `isFeatureTask`, `parseSectionMove`,
  `analyzeFeature` (QA-stage detection, bounce detection, finder attribution,
  evidence gathering, marked_incomplete reopen with dedup), and
  `pacificWindowToUtcMs` (DST-aware PT→UTC window).
- `qa-classifier.ts` — `classifyBouncedFeatures`, ONE batched
  `callClaudeWithResilience` call (haiku → sonnet, site `asana_qa_classifier`),
  defensive `[...]` JSON extraction, Zod validation; returns
  `{ classifications, degraded }`.
- `connector.ts` — `AsanaConnector` deps `{ client, claude }`; single tool
  `asana.feature_qa_stats` with `DateRangeArg` + `includeFeatures?`. Fetches
  tasks → filters Features → prunes → fans out story fetches (concurrency 5) →
  analyzes → classifies bounced → aggregates totals + finder leaderboard →
  flat D1 output.
Tests: `story-analyzer.test.ts` (core), `qa-classifier.test.ts`,
`connector.test.ts`.

## Phase E — Wire-up (`src/index.ts`)
`readVaultSecret(supabase, 'ASANA_ACCESS_TOKEN').catch(() => null)` added to the
parallel block; conditional construction (with `logger.warn` when missing)
placed AFTER the shared `claude` Anthropic client is built, since the classifier
needs it; `registry.register(new AsanaConnector({ client, claude }))`.

## Phase F — Live Reports
- `src/reports/live/spec.ts`: `asana.feature_qa_stats` added to
  `WHITELISTED_TOOLS`.
- `src/connectors/live-reports/tool-output-shapes.ts`: output sample added
  (top-level keys + `finders`/`features` element keys).
- Cache policy in `src/connectors/base/default-policies.ts`:
  `{ version: 1, settleDays: 14, openTtlSec: 1800, dateRangePath: 'dateRange' }`.
- `tests/unit/connectors/base/date-range-invariant.test.ts`: asana connector
  added to the inspection list so the preset-string invariant covers it.

## Phase G — Prompts
`src/orchestrator/prompts.ts`: new section "5db. Asana — engineering QA stats"
with trigger phrases and a "not for marketing/sales" routing note.

## Phase H — Validation
`npx vitest run && npx tsc --noEmit && npm run build`, plus (run by the
orchestrator, no token locally) `scripts/smoke-asana.sh` and
`scripts/smoke-asana-tools.mjs`.
