# gantri-ai-bot — Project Instructions

## Adding a new connector or tool — REQUIRED READING

**Before adding a new external data source (Klaviyo, GA4, Northbeam, etc.), or before adding a new tool to an existing connector, READ this doc end-to-end:**

→ `docs/process/adding-a-connector.md`

It is the canonical checklist of every touchpoint required for a connector to be fully wired, validated, and deployable. Skipping a step usually causes silent breakage (e.g., Live Reports compile failure, LLM doesn't know the tool exists, rate-limit buckets get duplicated). The doc tells you exactly what to do for each phase: spec → plan → migration → repo → client → connector → job → wire-up → live-reports integration → prompts → validation → deploy.

**Keep the doc in sync.** If you discover a new touchpoint, change a pattern, or learn something the doc doesn't already say — update it in the same PR. Silent drift makes the doc useless.

## Other key docs

- Specs (per-feature design docs): `docs/superpowers/specs/`
- Plans (per-feature implementation plans): `docs/superpowers/plans/`
- Process docs: `docs/process/`

## Tooling reminders specific to this project

- **Migrations**: numbered SQL files in `migrations/`. Apply via `mcp__supabase__apply_migration` (project_id `ykjjwszoxazzlcovhlgd`). Verify with `information_schema.columns`.
- **Secrets**: stored in Supabase vault, read via `readVaultSecret(supabase, 'NAME')`. Never use `.env` for secrets in this project. Document new vault keys in the `reference_gantri_ai_bot_deploy.md` memory.
- **Date ranges**: ALWAYS import `DateRangeArg` and `normalizeDateRange` from `src/connectors/base/date-range.ts`. The invariant test at `tests/unit/connectors/base/date-range-invariant.test.ts` enforces this for whitelisted tools.
- **Pagination**: existing helper `paginate<T>()` has a 50-page cap. For batch jobs that need full history, write a sibling `paginateUnbounded<T>()` with a 10K-page sanity cap — explicit opt-in.
- **Repo reads**: use `.maybeSingle()` (not `.single()` + `PGRST116` sniffing) for "0 or 1 row" patterns.
- **Live Reports tools**: must be in `WHITELISTED_TOOLS` (`src/reports/live/spec.ts`) AND have an output sample in `src/connectors/live-reports/tool-output-shapes.ts`, otherwise the compiler refuses to load.

## Deploy

```bash
fly deploy        # rolling deploy to Fly app gantri-ai-bot
```

Verify with `/healthz` + `/readyz`, then end-to-end smoke from Slack.
