# Adding a New Connector — Standard Process

> **READ THIS FIRST when adding a new external data source (Klaviyo, GA4, Northbeam, etc.) to the bot.** This is the canonical checklist of every touchpoint required for a connector to be fully wired, validated, and deployable. Skipping a step usually causes silent breakage that's discovered weeks later when a Live Report fails or a tool is invisible to the LLM.

---

## How to keep this document in sync

This doc is the source of truth. When you add a connector and discover a new touchpoint not listed here — **update this doc in the same PR**. When you change a pattern (e.g., new shared schema, new validation gate), update this doc.

If you skip an item because it doesn't apply to your connector, note that in the PR description so reviewers know it was a deliberate skip, not an oversight.

The reference trail at the bottom points to the most recent connector implementation; future agents/devs can use it as a working example.

---

## Decision tree — does this checklist apply?

```
Adding a new external data source (HTTP API, scraping, OAuth, etc.)?
└─ YES → use this doc end-to-end
Adding a new tool to an EXISTING connector (no new client, no new auth)?
└─ Skip A (planning), B (migration), C (client). Jump to D-I as relevant.
Adding a new internal tool (not external)?
└─ Skip A-C. Use D (connector), E-I as relevant.
```

If unsure: do the full checklist. Skipping is a one-line PR note; missing a touchpoint is a regression.

---

## Phase A — Planning

### A1. Write a spec
- **File**: `docs/superpowers/specs/YYYY-MM-DD-<name>-design.md`
- Use `superpowers:brainstorming` skill to drive this. Spec must cover: goal, non-goals, definition (e.g., "what counts as consented"), architecture diagram, components, data flow, error handling, testing strategy, risks.
- Get user approval before writing the plan.

### A2. Write a plan
- **File**: `docs/superpowers/plans/YYYY-MM-DD-<name>.md`
- Use `superpowers:writing-plans` skill. Each task must be bite-sized TDD steps with full code (no placeholders).

### A3. Branch
- New branch off `main`: `feat/<name>` (e.g., `feat/klaviyo-consented-signups`).
- Push to origin so the spec/plan are visible.

---

## Phase B — Storage (skip if no persistent state)

### B1. Migration
- **File**: `migrations/0XXX_<table_name>.sql` — increment from the latest existing number.
- Use `create table if not exists` and `create index if not exists` (idempotent).
- Apply via `mcp__supabase__apply_migration` (project_id `ykjjwszoxazzlcovhlgd`). Verify with `information_schema.columns`.

### B2. Repo class
- **File**: `src/storage/repositories/<name>.ts`
- Constructor injection of `SupabaseClient`. Methods translate snake_case DB columns to camelCase TS types.
- **Use `.maybeSingle()` for "0 or 1 row" reads.** Never `.single()` + `PGRST116` sniffing — that's not the codebase convention.
- Errors: throw with a descriptive prefix `<table_name> <op> failed: <message>`.
- Empty-array no-op for batch upserts: `if (rows.length === 0) return;`
- **Tests**: `tests/unit/storage/<name>.test.ts`. Use a fake Supabase builder (see `tests/unit/storage/klaviyo-signup-rollup.test.ts` for the modern pattern with `order()`/`limit()`/`maybeSingle()` support).

---

## Phase C — Client (HTTP/auth layer)

### C1. Client class
- **File**: `src/connectors/<name>/client.ts`
- Pattern: typed `<Name>ApiClient` class, constructor takes config (`{ apiKey, fetchImpl?, baseUrl? }`).
- Auth headers in a single private method (e.g., `headers()` — not `authHeaders()`; the codebase convention is `headers()`).
- Pagination:
  - **Default**: bounded `paginate<T>()` with a 50-page cap.
  - **Unbounded** (for batch jobs): `paginateUnbounded<T>()` with a 10K-page sanity cap that throws if exceeded. Explicit opt-in — don't bump the default cap.
- Errors: throw a typed `<Name>ApiError` extending `Error`. Constructor signature: `(message, status, body)` — match existing classes.
- TS interfaces (not Zod) for response shapes. Cast with `as` (the JSON:API contract is stable and pinned by API revision).
- **Tests**: `tests/unit/connectors/<name>/client.test.ts`. Mock `fetchImpl` with `vi.fn()`. Cover happy path, pagination, error responses, and any client-specific edge cases (rate limit, sanity cap).

---

## Phase D — Connector & Tools

### D1. Connector class
- **File**: `src/connectors/<name>/connector.ts`
- `<Name>ConnectorDeps` interface (deps object pattern). Includes the client + any repos + other connectors it depends on.
- Tool definitions follow `ToolDef<Args>` shape: `{ name, description, schema, jsonSchema, execute }`.
- **Tool naming**: `<connector>.<verb>` lowercase snake_case. E.g., `klaviyo.consented_signups`, `gsc.search_performance`.
- **Date ranges**: ALWAYS use the shared `DateRangeArg` from `src/connectors/base/date-range.ts`. NEVER write a local DateRange schema. The invariant test at `tests/unit/connectors/base/date-range-invariant.test.ts` enforces this for whitelisted tools.
  - Inside `execute()`: `const { startDate, endDate } = normalizeDateRange(args.dateRange);`
- **Tool description**: write for the LLM. Cover what it returns, when to use it, contrast with similar tools, and any freshness/latency caveats. The LLM picks tools based on the description.
- **Output shape**: keep flat. Top-level keys for metadata (`period`, `granularity`, etc.), `rows: []` for table data. Dates as `YYYY-MM-DD` strings. Currency in cents (integers) — formatters add `$` at render time.
- **Tests**: extend `tests/unit/connectors/<name>/connector.test.ts`. Stub deps with `vi.fn()`. Cover happy path, edge cases, preset string acceptance for `dateRange`.

### D2. (Optional) Job class
Required if the connector needs a scheduled batch (e.g., nightly rollup).

- **File**: `src/connectors/<name>/<name>-job.ts`
- Pattern (mimic `src/connectors/rollup/rollup-refresh.ts`):
  - Class with `timer: NodeJS.Timeout | null`, `running: boolean` flag.
  - `start()`: 15-minute `setInterval` calling `tickIfDue()`. Also fires `run()` once on boot for backfill.
  - `tickIfDue()`: PT-hour gate, `if (hourPt !== <hour>) return;`. Use a free hour (sales rollup uses 4, Klaviyo signups uses 3 — pick something else for the next).
  - `run()`: `try { ... } catch { logger.error; return zeros; } finally { running = false; }`. Returns `{ daysWritten, profilesSeen }` (or analogous).
  - PT-day bucketing: use `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year, month, day })` — emits `YYYY-MM-DD`.
- **Tests**: `tests/unit/connectors/<name>/<name>-job.test.ts`. Stub client + repo. Cover bucketing, drift recompute (if applicable), error path returns zeros, concurrency serialization (running flag).

---

## Phase E — Wire-up in `src/index.ts`

### E1. Imports
- Import client, connector, repo, job classes.

### E2. Vault secret reads
- Use `readVaultSecret(supabase, 'YOUR_SECRET_NAME')` for any API keys / OAuth credentials. **Never** put secrets in `.env` files.
- Add the secret to the Supabase vault first (one-time setup). Document the vault key name in the `reference_gantri_ai_bot_deploy.md` memory.

### E3. Conditional construction
- Wrap connector + job instantiation in `if (apiKey) { ... } else { logger.warn(...) }` so unconfigured local/test envs don't crash.
- **Share the client instance** between connector and any related job — this matters for rate-limit-bucket sharing. Construct directly (`new <Name>Connector({ client, ... })`), don't go through factory functions that build their own client.

### E4. Job lifecycle
- Call `.start()` on any new job after construction.
- (Known limitation: jobs leak intervals on SIGTERM. Codebase-wide pattern; tracked separately, don't fix per-connector.)

---

## Phase F — Live Reports integration (skip if tool isn't user-facing)

Required if the tool is callable from Live Reports (i.e., users can ask the bot to build a published report that uses this tool).

### F1. Whitelist
- **File**: `src/reports/live/spec.ts`
- Add the tool name to the `WHITELISTED_TOOLS` `Set<string>`. Maintain alphabetical order **within the connector's section** (other sections use logical order — match the surrounding pattern).

### F2. Output shape sample
- **File**: `src/connectors/live-reports/tool-output-shapes.ts`
- Add an entry with `expectedTopLevelKeys` and `expectedArrayElementKeys` (for any array fields the LLM will iterate over). Without this entry, the live-reports compiler refuses to load and tests fail. The example payload should match the connector's actual return shape exactly — type-check field names against the source.

---

## Phase G — LLM prompt docs

### G1. Tool documentation
- **File**: `src/orchestrator/prompts.ts`
- Find the connector's section (or create one). Add a bullet for the new tool matching the surrounding format.
- Update any inline lists at the top of the section to include the new tool name.
- Description should help the LLM disambiguate from similar tools. Include trigger phrases ("how many X in March", etc.).

---

## Phase H — Validation

Run all of these before committing a wiring change:

```bash
# Tests
npx vitest run

# Typecheck
npx tsc --noEmit

# Build
npm run build

# Specifically: the date-range invariant must pass — it auto-checks every
# whitelisted tool's `dateRange` schema accepts preset strings like 'last_30_days'
npx vitest run tests/unit/connectors/base/date-range-invariant.test.ts
```

If any of these fail, fix before merging. The invariant test catches the most common silent bug: a tool that ships with a dateRange schema that rejects preset strings (Live Reports' `$REPORT_RANGE` substitution will then fail at runtime).

---

## Phase I — Deployment

### I1. Push branch
```bash
git push -u origin feat/<name>
```

### I2. Deploy
```bash
fly deploy
```

Watch the deploy log. The deploy succeeds when you see "Machine ... is now in a good state".

### I3. Verify boot
- Hit `/healthz` and `/readyz` to confirm the bot is up.
- Check Fly logs for any `*_failed` errors.
- If a job runs on boot (rollup-style), watch logs for `<name>_completed { profilesSeen, durationMs }` — should appear within 1–3 minutes.

### I4. Verify data
- Query Supabase via `mcp__supabase__execute_sql` to confirm the rollup table is populated (if applicable).
- Compare against a known reference (e.g., Lana's dashboard numbers, or sample API output).

### I5. End-to-end smoke from Slack
- DM the bot with a test query that should route to the new tool (e.g., "how many email signups in March?").
- Verify the bot calls the right tool and returns sensible numbers.
- If Live Reports is in scope, ask the bot to build a report using the tool. Verify it compiles, publishes, and the visual verifier passes.

### I6. Notify stakeholder
- If the work was driven by stakeholder feedback (e.g., a Lana DM), reply on the original thread with what was shipped + a sample query/report URL.

---

## Reference trail

Most recent end-to-end implementation: `klaviyo.consented_signups` (April 2026). See:
- Spec: `docs/superpowers/specs/2026-04-29-klaviyo-consented-signups-design.md`
- Plan: `docs/superpowers/plans/2026-04-29-klaviyo-consented-signups.md`
- Branch: `feat/klaviyo-consented-signups`

When in doubt about how a step looks in practice, read the corresponding file from this connector.

Other complete reference connectors:
- `src/connectors/gsc/` — OAuth user flow + read-only HTTP client + 3 tools
- `src/connectors/impact/` — REST client with 45-day chunking + ISO formatting
- `src/connectors/ga4/` — GCP service account auth + cached access token
- `src/connectors/northbeam-api/` — public REST API with CSV export pattern
- `src/connectors/rollup/` — the original scheduled-rollup-job pattern (reference for Phase D2)
- `src/connectors/klaviyo/` — most recent rollup pattern with all phases

---

## Anti-patterns to avoid

- **Local `DateRange`/preset schemas.** They drift from the canonical shared schema. The registry's `unstringifyJsonObjects` preprocess works for any union, but local schemas may not get preset additions or other improvements. ALWAYS use the shared `DateRangeArg`.
- **Bumping the global pagination cap** (50 pages) for one connector that needs more. Add `paginateUnbounded` instead — explicit opt-in keeps batch jobs intentional.
- **Factory functions that hide client construction.** They make rate-limit-bucket sharing impossible. Direct `new` is the codebase preference.
- **`.single()` + `PGRST116` sniffing** for "0 or 1 row" reads. Use `.maybeSingle()`.
- **Tool descriptions that name the API instead of the use case.** The LLM picks based on the description; "fetch /api/profiles" is useless. "Count of profiles created in window AND currently consented" works.
- **Skipping `tool-output-shapes.ts`.** A whitelisted tool without an output sample causes the live-reports compiler to refuse to load. CI will catch this; saving the discovery for the deploy is more painful.
- **Not migrating existing tools to `DateRangeArg`** when extending a connector. The invariant test fails — fix it in the same PR.
- **Sending Slack messages without explicit user authorization.** Send-message is a visible-to-others action. Always confirm.

---

## When this doc gets out of sync

Symptoms:
- Tests pass locally but fail in CI on a check this doc didn't mention.
- A new touchpoint exists in another connector that isn't listed here.
- Deploys succeed but a feature is silently broken (compiler refuses tool, LLM doesn't know about it, etc.).

Action: update this doc in the PR that introduces the change. Don't defer it — silent drift makes the doc useless.
