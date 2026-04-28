# Impact.com Integration — FLC

**Status:** Draft
**Feature status:** Planned
**Author:** Danny Estevez
**Date:** 2026-04-27
**Branch:** `feat/impact-integration` (proposed)
**Related:**
- Impact.com partner dashboard — https://app.impact.com
- Impact.com developer docs — https://developer.impact.com/default/
- Reference connector: `src/connectors/northbeam-api/` (`client.ts` + `connector.ts`)
- Live Reports tool catalog: `src/connectors/live-reports/tool-output-shapes.ts`
- Live Reports whitelist: `src/reports/live/spec.ts`

---

## Goal

Give the bot direct visibility into per-partner performance on Gantri's Impact.com partnership/affiliate program. Today the only signal we have is Northbeam's "Impact" channel aggregate (~$1.5k revenue in a recent report) — we cannot tell which partners drove that revenue, what we paid in commissions, what the partner-level CAC/ROAS looks like, or whether NB-attributed Impact revenue agrees with what Impact itself recorded.

After this ships, the bot can answer:

- "Top 10 Impact partners by revenue this quarter, with payout amount."
- "Which Impact partners have CAC < $50 / highest ROAS?"
- "Compare Impact-attributed revenue (per Impact) vs the Impact channel in Northbeam for the same period." — direct recon, like our existing NB-vs-Porter reconciliation.
- "How much commission did we pay out last month, broken down by partner type / category?"
- "List all conversions from partner X in November."
- "Publish a live dashboard of monthly Impact partner performance" (Live Reports).

## Non-goals

- **No writes.** No creating partners, editing contracts, approving/reversing actions, or paying commissions. Read-only only.
- **No partner-name normalization layer beyond simple matching.** A real "Impact partner ↔ NB sub-channel name" mapping is a follow-up; v1 surfaces both names as-is and lets the user eyeball the comparison. (See Risks.)
- **No replacing Northbeam.** NB stays the source of truth for cross-channel attribution. Impact answers partner-level questions NB cannot.
- **No deep historical backfill at launch.** First-call latency is the cost of the first month people query; cache absorbs subsequent calls.
- **Not in MVP:** scheduled "weekly Impact digest" via `reports.subscribe`. The plumbing supports it (the tools are whitelisted), but a curated digest plan is a follow-up.

---

## Architecture (one paragraph)

`ImpactApiClient` (`src/connectors/impact-api/client.ts`) is a thin typed HTTP wrapper over Impact's REST API at `https://api.impact.com/Mediapartners/<AccountSID>/...`. It handles HTTP Basic auth (`AccountSID` + `AuthToken`), pagination (Impact returns `@Page`/`@PageSize`/`@TotalPages`), 429/5xx retry with backoff, and Zod-validated parsing of responses. `ImpactApiConnector` (`src/connectors/impact-api/connector.ts`) wraps the client in a narrow set of 4 read-only tools registered with the orchestrator's tool registry, mirroring the shape of `NorthbeamApiConnector`. Secrets (`IMPACT_ACCOUNT_SID`, `IMPACT_AUTH_TOKEN`) live in Supabase Vault and are loaded at boot in `src/index.ts` next to the other vault secrets. Cache policies for the new tools land in `src/connectors/base/default-policies.ts`. All 4 tools are whitelisted in `src/reports/live/spec.ts` and have verified output samples in `src/connectors/live-reports/tool-output-shapes.ts` so the Live Reports compiler doesn't guess field names.

```
                ┌─────────────────────────────┐
   user Q   ───►│        Orchestrator         │
                └────────┬────────────────────┘
                         │  (LLM picks tool)
                         ▼
                ┌─────────────────────────────┐
                │   ImpactApiConnector tools  │
                │  - impact.list_partners     │
                │  - impact.partner_perf      │
                │  - impact.list_actions      │
                │  - impact.commission_summary│
                └────────┬────────────────────┘
                         │
                         ▼
                ┌─────────────────────────────┐
                │      ImpactApiClient        │  ← HTTP Basic, retries, Zod
                └────────┬────────────────────┘
                         │
                         ▼
                  api.impact.com
```

---

## Functional spec

### Why now / business value

We've shipped Northbeam, GA4, Porter, Grafana, and Live Reports. Marketing is now actively asking partner-level questions on the Impact program, and the only honest answer the bot can give today is "Northbeam shows the channel total, but I can't break it down per partner." That kills the workflow at the moment the user wants to act ("which partner do we double down on?", "did Wirecutter's article last week move the needle?"). Impact is also the only place commission/payout data lives — NB doesn't ingest it. The integration unlocks (a) partner-level decisions, (b) commission visibility, (c) a NB-vs-Impact reconciliation that matches our existing NB-vs-Porter pattern.

### User stories / questions to support

| # | Question | Tools used |
|---|---|---|
| Q1 | Top 10 Impact partners by revenue this quarter, with payout amount. | `impact.partner_performance` (period=quarter_to_date, sort=revenue desc, limit=10) |
| Q2 | Which Impact partners have CAC under $50 last 90 days? | `impact.partner_performance` (period=last_90_days), bot filters `payout / actions` per row |
| Q3 | NB-attributed Impact channel vs Impact-attributed revenue, last month. | `impact.partner_performance` (sum of revenue) + `northbeam.metrics_explorer` (channel=Impact) |
| Q4 | How much commission did we pay last month, broken down by partner type? | `impact.commission_summary` (period=last_month, breakdown=partner_type) |
| Q5 | List all conversions from partner X in November. | `impact.list_partners` to resolve name → ID, then `impact.list_actions` (mediaPartnerId=X, range=Nov) |
| Q6 | "Publish a live dashboard of monthly Impact partner performance." | `reports.publish_live_report` → spec referencing `impact.partner_performance` |
| Q7 | Show me all our Impact partners. | `impact.list_partners` |

### Tool surface (4 tools — narrow on purpose)

The catalog feeds the LLM's prompt and bloats fast. Northbeam ships with 5 tools and that's about the upper bound. Each Impact tool earns its slot by answering a question the others can't.

#### 1. `impact.list_partners`

**Purpose.** Discovery. The catalog of partners Gantri has on Impact, with their stable IDs, names, and status. Used to resolve "Wirecutter" → `MediaPartnerId 12345` for follow-up tool calls and to enumerate partners for ranking questions.

**Args.**
```
{
  status?: 'Active' | 'Pending' | 'Inactive',          // defaults to Active
  partnerType?: string,                                 // e.g. 'Content', 'Coupon' — filter
  limit?: number,                                       // default 100, hard cap 500
}
```

**Returns.** `{ count, partners: [{ id, name, status, partnerType, joinedDate, primaryUrl }] }`

**Maps to.** Q5 (resolve name), Q7 (enumerate).

#### 2. `impact.partner_performance`

**Purpose.** The workhorse. Per-partner aggregated metrics for a date range — revenue, actions (conversions), payout, action count, EPC. One row per partner. Optional sort + limit so "top 10" questions don't pull the full catalog.

**Args.**
```
{
  dateRange: 'last_7_days' | 'last_30_days' | 'last_90_days' | 'last_180_days'
           | 'month_to_date' | 'last_month' | 'quarter_to_date' | 'year_to_date'
           | { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' },
  metrics?: Array<'revenue' | 'actions' | 'payout' | 'epc' | 'clicks'>, // default ALL
  sortBy?: 'revenue' | 'actions' | 'payout',           // default 'revenue'
  sortDir?: 'asc' | 'desc',                            // default 'desc'
  limit?: number,                                      // default 100
  partnerIds?: string[],                               // optional explicit filter
}
```

**Returns.** `{ period, sortBy, rowCount, rows: [{ partnerId, partnerName, revenue, actions, payout, clicks, epc }], totals: { revenue, actions, payout } }`

**Maps to.** Q1 (top 10), Q2 (filter on payout/actions), Q3 (sum), Q6 (live dashboard).

**Implementation note.** Impact exposes performance through the Reports endpoint (`/Reports/<ReportId>`). We pick one canonical report (likely "Performance by Media Partner" or equivalent) and shape its rows into our schema. The client hides the report ID detail — the connector exposes a stable contract regardless.

#### 3. `impact.list_actions`

**Purpose.** Per-conversion detail for a date range, optionally filtered to a single partner. Answers "list all conversions from X in November" and lets the user inspect specific transactions (refunds, reversals, items sold).

**Args.**
```
{
  dateRange: <same shape as above, but capped at 90 days max>,
  mediaPartnerId?: string,                             // restrict to one partner
  state?: 'PENDING' | 'APPROVED' | 'REVERSED',         // default ALL
  limit?: number,                                      // default 200, hard cap 1000
}
```

**Returns.** `{ period, count, totalReturned, actions: [{ id, partnerId, partnerName, eventDate, lockingDate, state, amount, payout, customerStatus, currency, items? }] }`

**Maps to.** Q5.

**Cap.** 90-day window cap. Per-row data is volatile, refunds adjust late, and pulling 6 months of per-action rows would be slow + uncacheable. If users want longer windows, route them to `partner_performance` for aggregates.

#### 4. `impact.commission_summary`

**Purpose.** "How much commission did we pay?" decomposed by partner or partner type. Pure payout aggregation — no clicks, no revenue. Distinct from `partner_performance` because the user question is "what did we spend on commissions?" not "who performed best?", and an LLM that has both surfaces routes more reliably than one that has to deduce-and-filter from a single tool.

**Args.**
```
{
  dateRange: <preset or {start,end}>,
  breakdown: 'partner' | 'partnerType',                // default 'partner'
  state?: 'PENDING' | 'APPROVED' | 'REVERSED',         // default APPROVED
  limit?: number,                                      // default 50
}
```

**Returns.** `{ period, breakdown, rowCount, rows: [{ key, label, payout, actions, avgPayoutPerAction }], totals: { payout, actions } }`

**Maps to.** Q4.

### Why not more tools?

Considered and rejected:
- `impact.list_campaigns` — Gantri runs one campaign on Impact. Static. Hardcode the campaign ID inside the client.
- `impact.list_contracts` — contract data is interesting but doesn't unlock a question users are asking yet. Add when there's a concrete need.
- `impact.partner_detail` — covered by `list_partners` + `partner_performance` for that partner. Not worth a third tool.
- `impact.click_logs` — too low-level. NB / GA4 already cover top-of-funnel attribution.

### NB-vs-Impact reconciliation

Q3 ("compare NB-attributed Impact vs Impact's own numbers") is the killer use case for the integration and worth calling out separately. The bot's plan:

1. `impact.partner_performance` over the period → returns `totals.revenue` (call this `IMP_rev`).
2. `northbeam.metrics_explorer` with `metrics:["rev"]`, `breakdown:{key:"Platform (Northbeam)", values:["Impact"]}`, same period → returns `rows[0].rev` (call this `NB_rev`).
3. Bot reports both, plus delta and delta%.

Expected divergence: NB attribution ≠ Impact's own conversion tracking (different attribution windows, different click-vs-view weighting, latency in NB ingesting Impact's postbacks). The point isn't to make them agree — it's to surface the gap so the user knows whether to trust NB's "Impact channel" number when making budget decisions.

---

## Architecture

### File layout

```
src/connectors/impact-api/
├── client.ts          ← HTTP, auth, pagination, retry, Zod parsing
└── connector.ts       ← 4 tools, args schemas, field-name shaping

migrations/            ← (none — Vault secrets only, no schema changes)

tests/unit/connectors/impact-api/
├── client.test.ts     ← mocked fetch
├── connector.test.ts  ← schema + execute happy paths + errors
└── tools.test.ts      ← live API gated by env (skipped in CI)
```

### Auth + secrets

Impact uses **HTTP Basic** with two secrets:

- `IMPACT_ACCOUNT_SID` — username portion of Basic auth. Identifies the advertiser (Gantri).
- `IMPACT_AUTH_TOKEN` — password portion. Long-lived; rotated by the Impact account admin.

Both go in Supabase Vault and are loaded at boot in `src/index.ts` alongside `NORTHBEAM_API_KEY`, `GRAFANA_TOKEN`, etc:

```ts
readVaultSecret(supabase, 'IMPACT_ACCOUNT_SID').catch(() => null),
readVaultSecret(supabase, 'IMPACT_AUTH_TOKEN').catch(() => null),
```

If either is missing, the Impact connector is **not registered** (mirrors the GA4 pattern: `logger.warn('impact not configured … skipping registration')`). The bot keeps running; questions that need Impact get a graceful "Impact integration not configured" error instead of a crash.

The base URL is `https://api.impact.com/Mediapartners/<AccountSID>/` — the SID is part of the path, so the client builds it once at construction.

### Client (`client.ts`)

Mirrors `NorthbeamApiClient` in shape:

```ts
export interface ImpactApiConfig {
  accountSid: string;
  authToken: string;
  /** default 'https://api.impact.com' */
  baseUrl?: string;
  /** request timeout. default 30000ms. */
  timeoutMs?: number;
  /** retry budget. default 3. */
  maxRetries?: number;
  /** Optional fetch override for testing. */
  fetchImpl?: typeof fetch;
}

export class ImpactApiClient {
  constructor(cfg: ImpactApiConfig) { ... }

  // High-level: paginated, fully consumed, Zod-validated.
  listMediaPartners(params: { status?: string; partnerType?: string; limit?: number }): Promise<MediaPartner[]>;
  runReport(reportId: string, params: Record<string, string>): Promise<ReportResult>;
  listActions(params: { startDate: string; endDate: string; mediaPartnerId?: string; state?: string; limit?: number }): Promise<Action[]>;

  // Health.
  health(): Promise<{ ok: boolean; detail?: string }>;
}
```

**Behavioral contract (must hold across versions):**

- All requests `Accept: application/json` (Impact serves XML by default — must be explicit).
- HTTP 429 → exponential backoff with jitter, respect `Retry-After` if present.
- HTTP 5xx → up to `maxRetries` retries with backoff.
- HTTP 4xx (other than 429) → throw `ImpactApiError` with status + body.
- Pagination: walk `@nextpageuri` until exhausted or `limit` reached, whichever comes first.
- Numeric fields: Impact returns numbers as strings. Coerce with `Number()` at the connector layer (NOT in the client) so both raw + typed callers can use the client.
- All requests logged at `info` with redacted auth header.

### Connector (`connector.ts`)

Same skeleton as `NorthbeamApiConnector`:

```ts
export class ImpactApiConnector implements Connector {
  readonly name = 'impact';
  readonly tools: readonly ToolDef[];
  constructor(cfg: ImpactApiConfig) {
    this.client = new ImpactApiClient(cfg);
    this.tools = buildTools(this.client);
  }
  async healthCheck() { ... }
}
```

Each tool:
- Has a Zod schema (`ListPartnersArgs`, `PartnerPerformanceArgs`, etc).
- Runs through `zodToJsonSchema` for the tool registry.
- Catches `ImpactApiError` and returns structured `{ ok: false, error: { code, status, message, body } }` (so the LLM can adapt) instead of throwing.
- Reshapes Impact's verbose response keys to the stable contracts above (`MediaPartnerName` → `partnerName`, `ActionPayoutTotal` → `payout`, etc). This keeps prompts predictable and isolates us from Impact API changes.

### Wiring

In `src/index.ts`:

1. Read `IMPACT_ACCOUNT_SID` + `IMPACT_AUTH_TOKEN` from Vault.
2. If both present, construct `ImpactApiConnector` and register in the `ConnectorRegistry`.
3. The `CachingRegistry` wraps it transparently using policies in `default-policies.ts`.

In `src/orchestrator/prompts.ts` (system prompt):

- New section "Impact (partnership platform)" with one paragraph + tool docs.
- **Routing rule** (critical): "Use **Impact** for partner-level questions ('which partner', 'top partners by revenue', 'commission paid'). Use **Northbeam** for channel-aggregate questions ('Impact as a channel vs Email', 'cross-channel ROAS'). For 'Impact-vs-NB reconciliation' questions, use BOTH."
- Trigger words to bias toward Impact: "partner", "affiliate", "commission", "payout", "Impact partner", "Wirecutter", named publishers.

### Live Reports compatibility

Whitelist all 4 tools in `src/reports/live/spec.ts`:

```ts
export const WHITELISTED_TOOLS = new Set<string>([
  // ... existing tools
  'impact.list_partners',
  'impact.partner_performance',
  'impact.list_actions',
  'impact.commission_summary',
]);
```

Add output samples to `src/connectors/live-reports/tool-output-shapes.ts` — this is the canary-in-coal-mine doc. Each entry MUST include `summary`, `example`, `expectedTopLevelKeys`, and (for array fields) `expectedArrayElementKeys`. Tests in `tests/unit/live-reports/tool-output-shapes.test.ts` enforce that every whitelisted tool has an entry and that the example matches the declared keys.

Sample for the workhorse tool:

```ts
'impact.partner_performance': {
  summary: 'Per-partner aggregated metrics for a period. Top-level: { period, sortBy, rowCount, rows, totals }. THE DATA IS IN `rows`. Each row: { partnerId, partnerName, revenue, actions, payout, clicks, epc }. `totals` is the SUM ACROSS ROWS for revenue/actions/payout — use it for KPIs. Numeric values are NUMBERS (already coerced in the connector).',
  example: {
    period: { start: '2026-01-01', end: '2026-03-31' },
    sortBy: 'revenue',
    rowCount: 2,
    rows: [
      { partnerId: '12345', partnerName: 'Wirecutter', revenue: 8420.50, actions: 47, payout: 842.05, clicks: 9120, epc: 0.92 },
      { partnerId: '67890', partnerName: 'Architectural Digest', revenue: 3210.00, actions: 18, payout: 321.00, clicks: 4500, epc: 0.71 },
    ],
    totals: { revenue: 11630.50, actions: 65, payout: 1163.05 },
  },
  expectedTopLevelKeys: ['period', 'sortBy', 'rowCount', 'rows', 'totals'],
  expectedArrayElementKeys: { rows: ['partnerId', 'partnerName', 'revenue', 'actions', 'payout', 'clicks', 'epc'] },
},
```

Equivalent samples for the other 3 tools land in the same file.

---

## Cache strategy

Settings live in `src/connectors/base/default-policies.ts`. Reasoning per tool:

| Tool | settleDays | openTtlSec | Why |
|---|---|---|---|
| `impact.list_partners` | 0 | 3600 | Catalog data — partners come and go but slowly. 1h TTL on the open window is plenty; no settle window because there's no date range arg. |
| `impact.partner_performance` | 7 | 600 | Impact actions can flip PENDING → APPROVED → REVERSED for up to ~7 days. Once a period is 7+ days old, treat as final and cache aggressively. Inside the open window, 10-minute TTL. |
| `impact.commission_summary` | 7 | 600 | Same settling profile as performance — payout amounts are derived from action state. |
| `impact.list_actions` | — (not cached) | — | Per-row data, individual actions can flip state, hard cap on the total query size — too volatile to cache profitably. Mirrors `northbeam.list_orders` (also uncached). |

Pattern matches NB exactly: aggregates settle and freeze, row-level lists don't get cached. The CachingRegistry wraps the connector at boot — no per-tool code changes.

---

## System prompt updates

Add a new section after the existing "Northbeam" block in `src/orchestrator/prompts.ts`:

```
🤝 IMPACT (partnership / affiliate platform)

Tools: impact.list_partners, impact.partner_performance, impact.list_actions, impact.commission_summary.

When to use Impact:
- ANY question that names or implies a specific partner / publisher / affiliate
  (e.g. "Wirecutter", "Architectural Digest", "our top affiliates").
- Commission / payout questions ("how much did we pay in commissions",
  "commission cost per action").
- Partner-level CAC / ROAS / EPC.
- Per-conversion drill-down on the Impact program ("list conversions from X").

When to use Northbeam, NOT Impact:
- "Impact as a channel" questions ("how does Impact compare to Email",
  "ROAS by channel"). Northbeam's channel breakdown is the right surface;
  Impact data sits inside that one channel.
- Cross-channel attribution.

Reconciliation pattern (when explicitly asked or when the user is sanity-checking):
- Run BOTH impact.partner_performance (totals.revenue) AND
  northbeam.metrics_explorer (Platform=Impact, metric=rev) for the same period.
- Report both numbers + delta. The two will differ; the gap is the point.

Discovery flow:
- If the user names a partner ("from Wirecutter"), call impact.list_partners
  FIRST to resolve the name → MediaPartnerId, then use that ID in the
  follow-up tool call. Match case-insensitively, prefer exact match over
  substring.

Argument hygiene:
- impact.list_actions is capped at 90 days. For longer windows, redirect to
  impact.partner_performance.
- partner_performance.limit defaults to 100 — set explicitly when the user
  asks for "top N".
```

The exact phrasing will be tuned in implementation; the structural rule is "name the question shape that picks each tool."

---

## Testing plan

### Unit (vitest, mocked fetch) — `tests/unit/connectors/impact-api/`

- `client.test.ts`
  - Builds correct Authorization header (`Basic base64(SID:Token)`).
  - Sets `Accept: application/json`.
  - Walks pagination via `@nextpageuri` until exhausted.
  - Retries 429 with backoff respecting `Retry-After`.
  - Retries 5xx with capped exponential backoff.
  - Throws `ImpactApiError` on non-retryable 4xx with status + body.
  - Coerces numeric strings to numbers in known fields.
- `connector.test.ts`
  - Each of the 4 tools: happy path with a recorded fixture, schema validation rejects bad args, error from client surfaces as `{ ok: false, error: { ... } }`.
  - `partner_performance.totals` is the actual sum of `rows[].revenue/actions/payout`.
  - `commission_summary.breakdown=partnerType` aggregates correctly across partners of the same type.
- `tool-output-shapes.test.ts` (existing test file)
  - All 4 new tools have entries.
  - `expectedTopLevelKeys` matches `Object.keys(example)`.
  - `expectedArrayElementKeys.rows` exists and matches the example's first row.

### Integration (live API, gated)

- `tests/unit/connectors/impact-api/tools.test.ts` — only runs when `IMPACT_ACCOUNT_SID` + `IMPACT_AUTH_TOKEN` are present in the env. CI skips. Hits the real API for:
  - `impact.list_partners` returns at least 1 active partner.
  - `impact.partner_performance` for `last_30_days` returns numeric `totals.revenue`.
  - `impact.list_actions` for `last_7_days` returns at most `limit` rows.
  - `impact.commission_summary` totals match the sum of rows.

### Smoke test from Slack

After deploy, manually fire from the Gantri Slack workspace:
1. "Top 10 Impact partners by revenue this quarter" → expects ranked rows, partner names familiar.
2. "How much commission did we pay last month?" → expects a single payout total.
3. "Compare Impact-attributed revenue vs the Impact channel in Northbeam, last 30 days" → expects two numbers + delta.
4. "Publish a live report of monthly Impact partner performance" → expects URL; visit it, confirm rows render.

A pass means: bot picked the right tool, response is well-formed, latency under ~10s for cached follow-ups.

### NB-recon validation

Once the data is flowing, sanity-check against NB on a known period:
- Pull NB's `Impact` channel revenue for last month (`metrics_explorer`, breakdown=Platform, value=Impact).
- Pull `impact.partner_performance.totals.revenue` for the same month.
- Document the typical delta in `docs/superpowers/specs/changelog-impact.md` so future users have a "this is the expected gap" reference.

---

## Risks / unknowns

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Rate limits unclear from public docs.** Impact's Mediapartners API doesn't publish a hard QPS in the public docs. | M | M | Conservative client defaults: 1 req/sec sustained, 3 retries with exponential backoff on 429, respect `Retry-After`. Cache aggressively. Monitor 429 rate via logs. |
| **Action state lag.** Impact actions transition PENDING → APPROVED over days; payout numbers shift retroactively. | H | M | `settleDays: 7` in cache policy. Document in tool descriptions that "last 7 days" amounts are provisional. |
| **Partner-name mismatch with NB.** "Wirecutter" in Impact may appear as "wirecutter.com" or "Affiliate - Wirecutter" or just be lumped into "Affiliate" in NB. | H | M | v1: surface both names side-by-side; user makes the call. v2 (deferred): build a partner-name normalization mapping table or a fuzzy-match pass. Add to follow-ups in `docs/superpowers/specs/changelog-impact.md`. |
| **Report ID is account-specific.** The exact "Performance by Media Partner" report ID may differ for Gantri vs the docs example. | M | L | Discover at boot via `/Reports` listing endpoint; cache the resolved ID for the connector lifetime. If discovery fails, log and refuse to register the connector (fail-fast). |
| **Wide variance in response time.** Action-list endpoints over wide ranges can be slow (10–30s observed in similar APIs). | M | M | 90-day cap on `list_actions` window. Default `limit: 200`, hard cap 1000. Cache the partner_performance aggregates (which are the slow one). |
| **Token rotation breaks the bot silently.** | L | H | Health-check tool (`impact.healthCheck` internal, exposed via `/healthz`) hits `list_partners` weekly. On 401, log error + DM Danny. |
| **API returns XML by default.** Easy footgun. | M | L | Always set `Accept: application/json`. Unit-test for it. |
| **Numeric strings.** Impact returns `"123.45"` not `123.45`. | H | L (now caught) | Client coerces in known numeric fields; Zod schema declares them as numbers. Test asserts `typeof === 'number'`. |
| **Account SID lives in URL, not header.** A buggy log line could leak it. | L | L | The SID alone is not auth — the Auth Token is the secret. Still, redact `Authorization` (which contains both base64'd) in logs. SID in URL paths is fine. |
| **PII in `list_actions`.** Customer status / order-level metadata may be PII. | L | M | We don't currently surface customer-identifiable fields. Verify before exposing — strip any email / address / IP from the returned shape. |

---

## Rollout

### Phase 1 — MVP (≈ 3 days)

1. **Day 1:** Branch `feat/impact-integration`. Get `IMPACT_ACCOUNT_SID` + `IMPACT_AUTH_TOKEN` from the Impact admin (Anthony / marketing). Insert into Supabase Vault. Probe the API manually with curl to confirm auth + base URL + the right report ID. Document findings inline.
2. **Day 1–2:** Implement `ImpactApiClient` with TDD — unit tests against mocked fetch. Cover auth, pagination, retries, error mapping.
3. **Day 2:** Implement `ImpactApiConnector` with the 4 tools + Zod schemas + reshaping. Unit tests with recorded fixtures.
4. **Day 2:** Add tool entries to `tool-output-shapes.ts` (must verify against real responses, not guesses). Add tools to `WHITELISTED_TOOLS`. Add cache policies to `default-policies.ts`. Make `tool-output-shapes.test.ts` pass.
5. **Day 2–3:** Wire `ImpactApiConnector` into `src/index.ts`. Update system prompt with the new section + routing rules.
6. **Day 3:** Build TS, run full test suite, deploy to Fly. Smoke-test 4 questions from Slack (above). Run NB-recon on last month and document the delta.
7. **Day 3:** Announce in the existing intro broadcast (`docs/intro-broadcast.md`) and via `bot.broadcast_notification`. Update the bot's intro DM template to mention Impact.

### Phase 2 — Polish (deferred, ~2 days when prioritized)

- Partner-name normalization layer (Impact ↔ NB) — a small SQL table `impact_partner_aliases` mapping `impact_partner_id` to `nb_breakdown_value`, used by a new `impact.compare_with_nb` tool that does the join automatically.
- Scheduled "weekly Impact digest" plan composable via `reports.subscribe` (pure config — the tools are already whitelisted).
- Backfill historical data into a rollup table if query latency becomes a complaint (it likely won't given the cache).

### Rollback

- Yank the connector registration from `src/index.ts` (one-line revert) and redeploy. Bot keeps running; Impact questions get the same "not configured" graceful error as if the secrets were missing. Vault secrets stay (no need to revoke). No data migration to undo.

---

## Open questions (resolve before implementation)

1. **Which Impact "Performance by Media Partner" report ID is the right one?** Likely `mp_perf_by_partner` or similar — needs a `/Reports` listing call from the live API to confirm the exact ID and the column names it returns. Mitigation: do the discovery as the very first manual probe in Phase 1 day 1, before any code.
2. **What rate limit are we actually subject to?** Public docs are silent. Plan: start with 1 req/s + retries; if logs show 429s, dial back. If docs surface a hard number, encode it as a token-bucket in the client.
3. **Is there PII in `list_actions` we shouldn't surface?** Need to inspect a real response. If customer email / address shows up, strip it in the connector before returning.
4. **Partner-name normalization scope for v1.** Punt to v2, OR add a tiny aliases SQL table now? Lean **punt** unless the recon delta in Phase 1 smoke is so noisy the user can't read it.
5. **Where does the "Anthony / marketing" admin contact live for getting the Impact credentials?** Need the actual person + handoff path before Phase 1 day 1 starts.

---

## Self-review

- ✅ Tool surface stays narrow (4 tools, justified one by one).
- ✅ Read-only — no mutation surface anywhere in the design.
- ✅ Auth secrets in Vault, lazy-load pattern matches GA4 and NB.
- ✅ Live Reports compatibility wired (whitelist + tool-output-shapes + cache policies).
- ✅ Cache policy explicit per tool, justified by Impact's settle behavior.
- ✅ System prompt routing rule disambiguates Impact (partner-level) vs NB (channel-aggregate).
- ✅ NB-vs-Impact recon pattern called out as a first-class use case.
- ✅ Risks list addresses rate limits, action settle lag, name normalization, report ID drift.
- ✅ Test plan covers unit + gated integration + Slack smoke.
- ✅ Rollback is one-line revert; failure mode is graceful no-op.
- ⚠️ Partner-name normalization is explicitly deferred — flagged as the most likely v2 follow-up.
- ⚠️ Exact rate limit + report ID need a manual probe before code starts.

---

**Next step:** Resolve open questions 1, 2, 5 (need the Impact admin contact + a 30-min API probe). Once unblocked, the implementation plan (TDD task-by-task) follows the same shape as `2026-04-26-ga4-integration.md`.
