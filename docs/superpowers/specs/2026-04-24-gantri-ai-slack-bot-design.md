# gantri-ai-bot — Design

**Status:** Draft — ready for review
**Author:** Danny Estévez
**Date:** 2026-04-24

## Purpose

Build a Slack bot that lets Gantri's team (Danny + management + select collaborators, ~5–15 users) ask business questions in natural language and get grounded, accurate answers backed by the company's real data sources — starting with Northbeam and extensible to other sources later.

## Problem statement

Gantri's management routinely asks questions that require pulling attribution, spend, revenue, and performance data from Northbeam. Today this data sits behind a dashboard that only Danny uses fluently, and Northbeam's public API is too limited for the questions being asked (it covers orders and basic attribution but not the rich breakdowns that power the Overview and Sales pages). Danny ends up as a manual bottleneck.

There is no existing internal tool that allows management to self-serve these questions. Consumer chat tools (ChatGPT/Claude) cannot reach Gantri's Northbeam account directly.

## Goals

1. Management can @mention a Slack bot and ask a business question in plain English and get a correct answer grounded in live Northbeam data within ~30 seconds.
2. Thread follow-ups work ("and by campaign?", "compare to last month"). The bot maintains conversational context per thread.
3. The architecture is extensible: adding a new data source (e.g. the existing `gantri-mcp`, Google Ads direct API, Postgres) is a new connector class, not a rewrite.
4. Credentials are never in prompts, logs, or code — they live in Supabase Vault.
5. Operation cost is predictable: target <$50/month infra + Claude usage bounded by per-conversation token caps.

## Non-goals (v1)

- Non-Slack UIs (web app, mobile, email). Slack only.
- Sources beyond Northbeam. The connector interface is designed for extension but v1 ships with only `NorthbeamConnector`.
- Write operations (creating campaigns, pausing ads, etc.). Read-only only.
- Scheduled/proactive reports. Pull-based only in v1.
- Per-user access controls beyond a flat allowlist.
- Custom charting. Text + tables + optional static chart images in fase 2.

## Users

| User | How they use it |
|---|---|
| Danny (owner, power user) | Deep exploration, follow-ups, quick lookups instead of opening the dashboard. Also operates the bot. |
| Management (~3–5) | Ad-hoc business questions: spend, ROAS, attribution, comparisons. |
| Other internal collaborators (~5–10) | Same as management, scoped by whoever Danny allowlists. |

## Architecture

### High-level topology

```
  Slack workspace
        │
        │ Events API (app_mention, DM)
        ▼
  ┌─────────────────────────────────────────────┐
  │  gantri-ai-bot (Fly.io, Node/TS)             │
  │                                              │
  │  Slack Bolt ──▶ Orchestrator ──▶ Connector   │
  │                 (Claude +       Registry     │
  │                  tool-use)         │         │
  │                                    ▼         │
  │                           NorthbeamConnector │
  │                           (+ future ones)    │
  └──────────┬──────────────────────┬────────────┘
             │                      │
             │ GraphQL + Auth0      │ SQL + Vault
             ▼                      ▼
    dashboard-api.            Supabase (Postgres
    northbeam.io              + Vault + Branches)
```

One always-on container on Fly.io. Stateless request handling; state lives in Supabase.

### Components

**Slack layer (`src/slack/`)**
- `@slack/bolt` app with Events API mode.
- **DM-only surface in v1.** Only handles `message.im` (direct messages). `app_mention` in channels is ignored (or replied to with a "please DM me instead" note) so that one user's questions and answers are never visible to another user.
- Acks within 3s with a placeholder message in the DM thread ("🔍 Consultando datos…"), then edits it with the final answer via `chat.update`.
- Validates the sender is in the allowlist (`authorized_users` table); polite decline otherwise.
- Handles thread follow-ups by loading prior messages from the same `thread_ts` as conversation history.

**Orchestrator (`src/orchestrator/`)**
- Claude API (Anthropic SDK) with tool-use.
- System prompt is built per-request and includes: today's date, brief instructions, the connector-registry tool manifest, and a freshly loaded catalog (metric IDs + breakdown values) so the LLM grounds on valid parameters.
- Tool loop hard-capped at 5 iterations to prevent runaway.
- Model: `claude-sonnet-4-6` by default. Escalates to `claude-opus-4-7` for complex multi-step questions (heuristic: if first-pass response requests ≥3 tool calls).
- Thread context: last 10 turns of the same thread passed as prior `messages`.
- Output: Claude produces markdown; a small formatter converts it to Slack Blocks (headings, tables, footer with attribution context).

**Connector layer (`src/connectors/`)**
Common interface every source implements:

```ts
interface Connector {
  readonly name: string;
  readonly tools: ToolDef[];
  execute(tool: string, args: unknown): Promise<ToolResult>;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}
```

A registry assembles the union of `tools` from every registered connector and exposes it to the Orchestrator.

**NorthbeamConnector (`src/connectors/northbeam/`)**

Reverse-engineered from the live dashboard (captured 2026-04-24). Everything talks to a single GraphQL endpoint: `POST https://dashboard-api.northbeam.io/api/graphql`. Full reverse-engineering notes in `reference_northbeam_api` memory.

Sub-modules:

- `auth-manager.ts` — obtains and refreshes an Auth0 JWT.
  - First: attempts ROPC (`POST https://auth.northbeam.io/oauth/token` with `grant_type=password`, `audience=https://api.northbeam.io`, `client_id=SAwznFb2...`, email, password). If Auth0 returns a token, use it.
  - Fallback: headless Playwright (Chromium) drives the Auth0 Universal Login page, captures the authorization code on redirect, exchanges for JWT via `/oauth/token` with code verifier. Only runs once per 24h (tokens have `exp = iat + 86400`).
  - Persists the encrypted token in `northbeam_tokens`. Refreshes when <1h of life remains.
- `graphql-client.ts` — thin `fetch` wrapper that always attaches the four required headers: `Authorization: Bearer <jwt>`, `x-nb-dashboard-id: <workspace>`, `x-nb-impersonate-user: <workspace>`, `content-type: application/json`.
- `queries.ts` — TypeScript constants for each GraphQL operation. v1 ships `GetOverviewMetricsReportV3`, `GetSalesMetricsReportV4`, `GetSalesMetricsCountV4`, `GetSalesBreakdownConfigs`, `FetchPartnersApexConsent`.
- `tools.ts` — tool definitions exposed to the LLM (see "Tool surface" below).
- `northbeam-connector.ts` — orchestrates the above, implements the `Connector` interface.

**Storage (`src/storage/`)**
- `supabase.ts` — typed client; helpers for reading secrets from Vault at boot.
- `cache.ts` — TTL cache backed by `northbeam_cache` table. Key = `sha256(operationName + stable-stringify(variables))`.
- `repositories/` — one file per table (conversations, authorized users, northbeam tokens, cache).

## Data model

```sql
create table authorized_users (
  slack_user_id text primary key,
  slack_workspace_id text not null,
  email text,
  role text not null default 'user' check (role in ('user','admin')),
  created_at timestamptz not null default now()
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  slack_thread_ts text not null,
  slack_channel_id text not null,
  slack_user_id text references authorized_users(slack_user_id),
  question text not null,
  tool_calls jsonb,
  response text,
  model text,
  tokens_input int,
  tokens_output int,
  duration_ms int,
  error text,
  created_at timestamptz not null default now()
);
create index conversations_thread_idx on conversations (slack_thread_ts);

create table northbeam_cache (
  cache_key text primary key,
  response jsonb not null,
  expires_at timestamptz not null
);
create index northbeam_cache_expires_idx on northbeam_cache (expires_at);

create table northbeam_tokens (
  id int primary key default 1 check (id = 1),
  access_token_encrypted text not null,
  expires_at timestamptz not null,
  last_refresh_method text check (last_refresh_method in ('ropc','playwright')),
  refreshed_at timestamptz not null default now()
);
```

Secrets in Supabase Vault:

- `NORTHBEAM_EMAIL`, `NORTHBEAM_PASSWORD`, `NORTHBEAM_DASHBOARD_ID`
- `ANTHROPIC_API_KEY`
- `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`

## Tool surface (v1)

Exposed to the LLM by `NorthbeamConnector`:

| Tool | Purpose | Key parameters | Underlying GraphQL |
|---|---|---|---|
| `northbeam.overview` | Top-level metrics like the Overview tiles | `dateRange`, `metrics[]`, `dimensions[]`, `attributionModel`, `compareToPreviousPeriod?` | `GetOverviewMetricsReportV3` |
| `northbeam.sales` | Granular performance table | `level`, `dateRange`, `metrics[]`, `breakdown?`, `filters?`, `sorting?`, `limit?` | `GetSalesMetricsReportV4` + `…CountV4` |
| `northbeam.list_breakdowns` | Enumerate valid breakdown keys + values | — | `GetSalesBreakdownConfigs` |
| `northbeam.list_metrics` | Enumerate valid metric IDs + human descriptions | — | Static catalog + tenant custom metrics |
| `northbeam.connected_partners` | Which ad platforms have working connections | — | `FetchPartnersApexConsent` |

Each tool:

- Accepts only strictly typed arguments (enums, ISO dates, fixed string lists). No free-form SQL.
- Normalizes the response to a consistent shape: `{ summary: {...}, rows: [...], period: {...}, meta: {...} }`.
- Returns errors as structured objects so Claude can self-correct in the next loop iteration.

## Caching policy

| Query shape | TTL |
|---|---|
| Contains today's date in range | 5 min |
| Range within last 7 days | 30 min |
| Range entirely >30 days ago | 24 h |
| Catalogs (`list_breakdowns`, `list_metrics`, `connected_partners`) | 24 h |

On cache hit, the tool returns in <50ms. Expired rows are swept by a daily cron.

## Deployment & ops

- Hosting: **Fly.io**, single region (closest to Slack/Supabase latency-wise), 1 machine, auto-scale off in v1.
- Container: Node 20 + preinstalled Chromium (for Playwright fallback). Dockerfile in repo.
- CI/CD: GitHub Actions — PR runs typecheck + lint + unit + integration tests against a Supabase preview branch. Merge to `main` auto-deploys to Fly.
- Observability:
  - Structured JSON logs to stdout (Fly captures).
  - BetterStack sink for WARN/ERROR (reuses existing Gantri BetterStack account).
  - Supabase Studio / Metabase dashboard over `conversations` for usage analytics.
- Token cost guardrails:
  - Per-turn caps: 20k input tokens, 4k output tokens.
  - Per-conversation cap: 5 turns (tool-loop iterations).
  - Daily spend alert if Claude usage exceeds a configured threshold.
- Rotation: to rotate credentials, update the Vault entry and restart the Fly machine.

## Testing

- **Unit tests (Vitest):** orchestrator with mocked Claude + connectors; `NorthbeamConnector` with mocked GraphQL; formatter with snapshot assertions on Slack Blocks output.
- **Integration tests:** recorded Northbeam GraphQL responses replayed via `msw`; full Slack event → response flow exercised with a fake Slack transport.
- **Smoke test:** post-deploy, a workflow sends `@gantri-ai healthcheck` to a staging channel and asserts the bot responds within 15s.
- **No DB mocks:** integration tests hit a Supabase preview branch.

## Rollout plan

1. **Phase 0 — foundation (week 1):** Fly app live, Supabase migrations applied, `NorthbeamConnector` with `overview` and `sales` tools, orchestrator wired to Claude, Slack bot posting in `#gantri-ai-staging`. Only Danny allowlisted.
2. **Phase 1 — quality (week 2):** catalogs loaded into system prompt, cache active, allowlist UI (admin commands in Slack), thread follow-ups polished, formatter improved. Invite 2–3 trusted users.
3. **Phase 2 — rollout (week 3):** open to management + rest of team (up to 15). Monitor conversation quality by reviewing `conversations` rows; iterate on prompt.
4. **Phase 3 — expand (ongoing):** additional Northbeam pages (customers, orders, creative analytics, MMM, incrementality); then new connectors (Google Ads direct, Postgres, `gantri-mcp`, etc.).

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Auth0 rejects ROPC → Playwright required in hot path | Tokens last 24h; Playwright runs at most once per day. A scheduled cron refreshes before expiry to avoid blocking user requests. |
| Northbeam changes GraphQL schema | Typed query constants fail loudly; BetterStack alert on parse errors; queries documented in `reference_northbeam_api` memory for quick re-inspection. |
| LLM hallucinates metric IDs or breakdown values | System prompt includes the live catalog; tool returns structured errors; Claude self-corrects in the next loop iteration. |
| Claude costs run away | Token caps per conversation; tool loop cap of 5; daily spend alert; aggressive caching on repeated queries. |
| Prompt-injection via Slack message | Tools accept only strict types — no tool can execute raw SQL or arbitrary GraphQL. The LLM's "damage ceiling" is limited to the parameterized tools. |
| Credentials leaked in logs | Vault-only storage; log scrubber drops any field matching known secret names; JWTs never logged (only `exp` claim). |
| Northbeam login breaks (password change, new MFA, Auth0 tenant change) | Health check endpoint reports auth status; Slack alert to Danny; graceful degradation (bot replies "Northbeam connection is down, tell Danny"). |

## Open questions

None at spec time. All open questions from draft were resolved 2026-04-24.

## Resolved design decisions

- **2026-04-24 — Slack surface:** DM-only. Each user converses 1:1 with the bot; no other user can see someone else's questions or answers. Channel mentions are not supported in v1.
- **2026-04-24 — Allowlist management:** Manual edits to the `authorized_users` table via Supabase Studio in v1. Danny is the sole admin and the user base is small enough (5–15) that a Slack admin command (`/gantri-admin add @user`) is deferred to fase 2.
- **2026-04-24 — Log depth:** Summary-by-default. Persist question, tool names + args (not raw tool responses), final response text, model, token counts, duration, and error. An environment flag `DEBUG_FULL_LOGS=true` (off by default) causes the full system prompt and raw tool responses to also be persisted, for troubleshooting windows.

## Future work (explicitly deferred)

- Phase 2 Northbeam coverage: `customers`, `orders`, `creative-analytics`, `mmm`, `incrementality` tools.
- `GantriMcpConnector` — wraps the existing `gantri-mcp` HTTP server as a connector so its tools (database, grafana, betterstack, ads, backend-api, existing Northbeam public API) appear alongside the new Northbeam GraphQL tools.
- Direct Google Ads / Meta / TikTok connectors for data Northbeam does not expose (quality score, search terms, etc.).
- Scheduled proactive reports ("every Monday at 9am, post top 10 campaigns by ROAS last week").
- Inline chart rendering via a headless chart service.
- Slash commands (`/gantri <question>`) as an alternative to @mentions.
- Web UI alongside Slack for users who want ChatGPT-style iteration.
