# Google Search Console Integration — FLC

**Status:** Draft
**Feature status:** Planned
**Author:** Danny Estevez
**Date:** 2026-04-28
**Branch:** `feat/google-search-console`
**Related:**
- Search Console UI — https://search.google.com/search-console
- Search Console API docs — https://developers.google.com/webmaster-tools/v1/api_reference_index
- URL Inspection API — https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect
- Reference connector: `src/connectors/ga4/` (same Google service-account auth pattern)
- Live Reports tool catalog: `src/connectors/live-reports/tool-output-shapes.ts`

---

## Goal

Give the bot direct visibility into Google's view of gantri.com — what queries Google shows us for, which pages get impressions, where we rank, and which URLs Google has indexed (or marked as 404 / canonical-mismatched / blocked). Today the bot can only see what GA4 sees, which is **post-click**: real visits, plus their channel breakdown. GA4 has no concept of impressions, no SERP position, and no "Google indexed a URL that returns 404 from the server" — those signals only live in Search Console.

The trigger: in production today, the bot answered "any 404 page?" with a clean GA4 breakdown (70 sessions on /404 in April, 5 of which came from Klaviyo email links — actionable) but had to honestly say it can't see Google Search Console, where the much larger volume of *indexed* broken URLs lives. After this ships, the bot can answer:

- "What queries are we ranking for and at what position?" — top of funnel SEO visibility.
- "Which URLs is Google indexing as 404?" — wasted crawl budget, lost SEO equity.
- "Pages where we get impressions but no clicks (low CTR)" — title/meta optimization candidates.
- "Average ranking change for product pages last 30 days vs prior 30." — has SEO improved or regressed.
- "Is this specific URL indexed?" — single-page deep dive (URL Inspection API).
- "Compare Search Console clicks for /products/* against GA4 organic sessions for the same paths" — recon between Google's view and our analytics.

## Non-goals

- **No writes.** No submitting sitemaps, requesting reindex, or removing URLs. Read-only.
- **No keyword research replacement.** GSC tells us what Google *already* sends us — not what we *could* rank for. That's a separate tool (Ahrefs, Semrush) and out of scope.
- **No multi-property aggregation in v1.** Gantri uses two GSC properties — `https://gantri.com/` (storefront, default) and `https://made.gantri.com/` (made-to-order subdomain). The connector exposes both via the optional `siteUrl` arg; defaults to `gantri.com` and the LLM passes `siteUrl: 'https://made.gantri.com/'` when the user names the made-side. No automatic cross-property roll-up.
- **No real-time data.** Search Console data has a 2-3 day delay. The connector is honest about that — never serves "today" or "yesterday" results.
- **No crawl-error or coverage-report endpoints.** Google deprecated those in favor of URL Inspection (per-URL, on-demand). We use Inspection for the same purpose at the questions where it matters.
- **Not in MVP:** sitemaps API (low LLM utility for daily questions). Defer to v2 if the team starts auditing sitemap freshness.

---

## Architecture (one paragraph)

`SearchConsoleApiClient` (`src/connectors/gsc/client.ts`) is a thin typed HTTP wrapper over Google's Search Console API at `https://searchconsole.googleapis.com/`. Auth is a Google service account (same JSON-key pattern we use for GA4) with the read-only scope `https://www.googleapis.com/auth/webmasters.readonly`. The service account email gets added as a "User" of the GSC property — that's the only manual step. `SearchConsoleConnector` (`src/connectors/gsc/connector.ts`) wraps the client in 3 read-only tools: `gsc.list_sites`, `gsc.search_performance`, and `gsc.inspect_url`. Secrets (`GSC_SERVICE_ACCOUNT_KEY` — the JSON key, base64-encoded) live in Supabase Vault, loaded at boot in `src/index.ts` next to `GA4_SERVICE_ACCOUNT_KEY`. Cache policies for the 3 tools land in `src/connectors/base/default-policies.ts`. All 3 tools are whitelisted in `src/reports/live/spec.ts` and have verified output samples in `tool-output-shapes.ts`.

```
                ┌─────────────────────────────┐
   user Q   ───►│        Orchestrator         │
                └────────┬────────────────────┘
                         │  (LLM picks tool)
                         ▼
                ┌─────────────────────────────┐
                │  SearchConsoleConnector     │
                │  - gsc.list_sites           │
                │  - gsc.search_performance   │
                │  - gsc.inspect_url          │
                └────────┬────────────────────┘
                         │
                         ▼
                ┌─────────────────────────────┐
                │  SearchConsoleApiClient     │  ← OAuth2 SA token, retries, Zod
                └────────┬────────────────────┘
                         │
                         ▼
                  searchconsole.googleapis.com
```

---

## Functional spec

### Why now / business value

The 404 incident exposed a real gap. The team needs SEO visibility, and "Google's view of our site" is the canonical source for it. Connecting GSC is a small lift (we already have the service-account auth pattern from GA4 — almost identical), bounded scope (3 tools), and unblocks an entire category of recurring questions about indexing health, query performance, and broken URLs that no other connector can answer.

The 2-3 day data lag is fine for the questions users ask: SEO trends are weekly/monthly, not hourly.

### User stories / questions to support

| # | Question | Tools used |
|---|---|---|
| Q1 | Top 20 queries by clicks last 30 days, with average position. | `gsc.search_performance` (dim=query, sort=clicks desc, limit=20) |
| Q2 | Which pages does Google show us for but we get few clicks (low CTR)? | `gsc.search_performance` (dim=page, sort=impressions desc) — bot filters CTR < 2% per row |
| Q3 | Did our average position change for product pages in the last 30 days vs prior 30? | Two `gsc.search_performance` calls (different ranges) + bot computes delta |
| Q4 | Which URLs is Google crawling that return 404? | `gsc.search_performance` (dim=page, dataState=all) — pages with impressions can be cross-checked against `inspect_url` for indexing state, OR a small subset run through `gsc.inspect_url` |
| Q5 | Is `https://gantri.com/products/atto-table-light` indexed? | `gsc.inspect_url` |
| Q6 | What countries / devices send us the most search traffic? | `gsc.search_performance` (dim=country or device) |
| Q7 | Compare Search Console clicks for /products/* vs GA4 organic sessions, last 30 days. | `gsc.search_performance` (dim=page, pageFilter=contains "/products/") + `ga4.run_report` (organic only, same paths) |
| Q8 | Publish a live SEO dashboard (top queries, top pages, ranking trend). | `reports.publish_live_report` referencing `gsc.search_performance` |

### Tool surface (3 tools — narrow on purpose)

#### 1. `gsc.list_sites`

**Purpose.** Discovery + property resolution. Lists verified GSC properties the service account has access to. Mostly used at first boot to confirm `https://gantri.com` is reachable, but exposed as a tool so the bot can answer "what GSC properties do we have access to" without a separate path.

**Args.** `{}` (no args).

**Returns.** `{ count, sites: [{ siteUrl, permissionLevel }] }` where `permissionLevel` is `siteOwner | siteFullUser | siteRestrictedUser`.

**Maps to.** Boot health-check. Indirectly Q5 (resolve which property to inspect against).

#### 2. `gsc.search_performance`

**Purpose.** The workhorse. Wraps the SearchAnalytics `query` endpoint. Per-row search performance for any combination of `date | query | page | country | device | searchAppearance` dimensions, with optional filters and date range. Returns `clicks`, `impressions`, `ctr`, `position` per row plus totals.

**Args.**
```
{
  dateRange: 'last_7_days' | 'last_30_days' | 'last_90_days' | 'last_180_days'
           | 'last_365_days' | 'month_to_date' | 'last_month' | 'quarter_to_date'
           | 'year_to_date' | { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' },
  dimensions: Array<'date' | 'query' | 'page' | 'country' | 'device' | 'searchAppearance'>,  // 1-3
  pageFilter?: { operator: 'contains' | 'equals' | 'notContains' | 'notEquals'; expression: string },
  queryFilter?: { operator: 'contains' | 'equals' | 'notContains' | 'notEquals'; expression: string },
  countryFilter?: { operator: 'equals' | 'notEquals'; expression: string },  // ISO 3166-1 alpha-3 (e.g. 'usa')
  deviceFilter?: { operator: 'equals' | 'notEquals'; expression: 'DESKTOP' | 'MOBILE' | 'TABLET' },
  sortBy?: 'clicks' | 'impressions' | 'ctr' | 'position',  // default 'clicks'
  limit?: number,                                          // default 100, hard cap 1000
  siteUrl?: string,                                        // optional override; defaults to the configured property
}
```

**Returns.** `{ siteUrl, dateRange, dimensions, rowCount, totals: { clicks, impressions, ctr, position }, rows: [{ keys: string[], clicks, impressions, ctr, position }] }`

**Maps to.** Q1, Q2, Q3, Q4, Q6, Q7, Q8.

**Implementation notes.**
- The SC API takes `dataState: 'all' | 'final'`. v1 uses `'final'` (default; matches what the SC UI shows) so users see the same numbers they'd see in the dashboard. Could expose later if needed.
- Position is averaged per row. CTR is `clicks / impressions` per row, NOT a sum/avg.
- Search Console data has a 2-3 day lag. Connector emits a friendly note in the response (`note: 'Search Console data has a 2-3 day reporting delay'`) when the dateRange ends within the last 3 days. The LLM is told (via prompt) to repeat that note to the user.

#### 3. `gsc.inspect_url`

**Purpose.** Single-URL deep dive via the URL Inspection API. Tells us if Google has indexed the URL, when it last crawled, what it sees as the canonical, mobile-usability verdict, AMP status, and structured-data verdicts. The "is this URL indexed?" question that GA4 fundamentally cannot answer.

**Args.**
```
{
  pageUrl: string,        // full URL within the configured property
  siteUrl?: string,       // optional override
  languageCode?: string,  // BCP-47, e.g. 'en-US'. defaults to 'en-US'.
}
```

**Returns.** A flat, friendly subset of the SC `inspectionResult` (the raw response is deeply nested; we shape it for prompt-friendliness):
```
{
  url, indexStatusVerdict, coverageState, robotsTxtState, indexingState,
  lastCrawlTime, googleCanonical, userCanonical,
  mobileUsabilityVerdict, mobileUsabilityIssues: string[],
  ampVerdict, richResultsVerdict, richResultsItems: Array<{ richResultType, severity, message? }>,
  sitemap: string[],            // sitemaps that reference this URL
}
```

**Maps to.** Q5. Also useful for ad-hoc spot checks ("why isn't this product page indexed?").

**Implementation notes.**
- The URL Inspection API is rate-limited at **2,000 calls/day per property**. Aggressive cache (settleDays=0, openTtl=1800) is fine — index state for one URL changes slowly.
- The API requires the URL be within a verified property; we validate `pageUrl.startsWith(siteUrl)` before calling and return a friendly error if not.

### Why not more tools?

Considered and rejected:
- `gsc.list_sitemaps` / `gsc.get_sitemap` — admin-y, low query volume from analysts. Deferred to v2.
- `gsc.search_performance_compare` (built-in period-over-period delta) — the LLM can compose two `search_performance` calls + compute the delta itself. Saves a tool slot.
- `gsc.crawl_errors` — Google deprecated the legacy crawl-errors endpoint years ago in favor of URL Inspection. Don't add a wrapper for a dead surface.

### Cross-source patterns

The connector unlocks two especially-useful cross-source recipes the bot can orchestrate without new code:

1. **GSC vs GA4 organic recon** (Q7). GSC shows clicks per page from Google Search; GA4 shows organic sessions per landing page. They should match within ~10–15% (different counting models — clicks vs sessions, attribution differences). Big gaps → tracking/redirect issue worth investigating.

2. **GSC vs Klaviyo for broken-email-link audits.** The 404 incident is a recurring shape. The bot can pull `gsc.search_performance` for high-impression /404 pages, find the source URLs being indexed (likely promotional URLs that expired), and cross-reference against Klaviyo campaign lists for the same period. Not a new tool — just an emergent capability the LLM can plan when asked.

---

## Architecture

### File layout

```
src/connectors/gsc/
├── client.ts             ← HTTP, Google SA auth, retries, Zod parsing
└── connector.ts          ← 3 tools, args schemas, response shaping

migrations/               ← (none — Vault secret only, no schema changes)

tests/unit/connectors/gsc/
├── client.test.ts        ← mocked fetch
├── connector.test.ts     ← schema + execute happy paths + errors
```

### Auth + secrets

GSC uses **Google OAuth2 with a service account** — same pattern as GA4. One secret:

- `GSC_SERVICE_ACCOUNT_KEY` — base64-encoded JSON key file. Long-lived; rotated by GCP IAM.

Critically: **the service account email** (`gantri-ai-bot@<project>.iam.gserviceaccount.com`) **must be added as a User of the GSC property** by an existing site owner. This is a one-time manual step in https://search.google.com/search-console → Settings → Users and permissions → Add user. Without that grant, every API call returns 403.

We can reuse the same service account that powers GA4 — fewer secrets to rotate, fewer manual setup steps. Just need to grant it the GSC permission once.

Loaded at boot in `src/index.ts` alongside the existing GA4 secret:

```ts
readVaultSecret(supabase, 'GSC_SERVICE_ACCOUNT_KEY').catch(() => null),
```

If missing, the connector is **not registered** (mirrors the GA4 / Impact pattern). Bot keeps running; GSC questions get a graceful "GSC not configured" error.

The OAuth2 token is fetched and cached in-memory by the client (1 hour TTL — Google issues 1-hour access tokens). Same caching pattern we use in `Ga4Client`.

### Client (`client.ts`)

Mirrors `Ga4Client` in shape:

```ts
export interface SearchConsoleApiConfig {
  serviceAccountKey: object;       // parsed JSON
  /** default 'https://searchconsole.googleapis.com'. */
  baseUrl?: string;
  /** request timeout. default 30000ms. */
  timeoutMs?: number;
  /** retry budget. default 3. */
  maxRetries?: number;
  /** Optional fetch override for testing. */
  fetchImpl?: typeof fetch;
}

export class SearchConsoleApiClient {
  constructor(cfg: SearchConsoleApiConfig) { ... }

  listSites(): Promise<Site[]>;
  searchAnalyticsQuery(siteUrl: string, body: SearchAnalyticsQueryBody): Promise<SearchAnalyticsResponse>;
  inspectUrl(siteUrl: string, pageUrl: string, languageCode?: string): Promise<InspectionResult>;

  health(): Promise<{ ok: boolean; detail?: string }>;
}
```

**Behavioral contract:**
- Uses `google-auth-library` (already a transitive dep via GA4) to mint access tokens from the service account JWT.
- Token cached in-memory; refreshed on 401 or before expiry.
- Sets `Authorization: Bearer <token>`, `Accept: application/json`.
- HTTP 429 / 5xx retried with exponential backoff (max 3 retries).
- HTTP 4xx (other than 429) → throws `SearchConsoleApiError` with status + body.
- `searchAnalyticsQuery` paginates internally via `startRow` until either `rowLimit` is hit or fewer rows than `rowLimit` come back. Hard cap on total rows = 25,000 (one API request's max).

### Connector (`connector.ts`)

Same skeleton as `Ga4Connector`. Each tool:
- Has a Zod schema (`ListSitesArgs`, `SearchPerformanceArgs`, `InspectUrlArgs`).
- Runs through `zodToJsonSchema` for the tool registry.
- Catches `SearchConsoleApiError` and returns structured `{ ok: false, error: { code, status, message, body } }` (so the registry's caching layer never caches failures, and the LLM can adapt).
- Reshapes verbose Google response keys into the stable contracts above (e.g. `inspectionResult.indexStatusResult.verdict` → `indexStatusVerdict`).

### Wiring

In `src/index.ts`:

1. Read `GSC_SERVICE_ACCOUNT_KEY` from Vault (same parallel-readVault block as GA4 / Impact).
2. If present, parse the JSON key, construct `SearchConsoleConnector`, register in the `ConnectorRegistry`.
3. The `CachingRegistry` wraps it transparently using policies in `default-policies.ts`.

In `src/orchestrator/prompts.ts`:

- New section "*5d. Google Search Console (SEO / search visibility)*" with one paragraph + tool docs.
- **Routing rule** (critical): "Use **GSC** for impressions, ranking position, search query data, indexing status (URL Inspection), and 'pages Google indexed but…' questions. Use **GA4** for actual visits / sessions / behavior. They're complementary, not interchangeable. GSC = pre-click; GA4 = post-click."
- Trigger words: "search console", "GSC", "SEO", "ranking", "rank", "search position", "impressions", "search queries", "indexed", "Google indexed", "404 in Google", "crawled", "canonical", "sitemap" (the last few route to `inspect_url`).

### Live Reports compatibility

Whitelist all 3 tools in `src/reports/live/spec.ts`:

```ts
export const WHITELISTED_TOOLS = new Set<string>([
  // ... existing tools
  'gsc.list_sites',
  'gsc.search_performance',
  'gsc.inspect_url',
]);
```

Add output samples to `tool-output-shapes.ts` — verified against real responses, not guesses (the FLC-tool-shapes invariant catches missing entries at boot).

Sample for the workhorse:

```ts
'gsc.search_performance': {
  summary: 'Per-row search performance from Google Search Console. Top-level: { siteUrl, dateRange, dimensions, rowCount, totals, rows }. Each row: { keys: string[] (one per requested dimension, in order), clicks, impressions, ctr, position }. CTR is decimal (0.034 = 3.4%); position is average (1.0 = top of SERP). Search Console data has a 2-3 day reporting lag — recent days will be partial.',
  example: {
    siteUrl: 'https://gantri.com/',
    dateRange: { startDate: '2026-03-29', endDate: '2026-04-25' },
    dimensions: ['query'],
    rowCount: 3,
    totals: { clicks: 2104, impressions: 81350, ctr: 0.0259, position: 18.4 },
    rows: [
      { keys: ['gantri'], clicks: 1430, impressions: 4200, ctr: 0.3405, position: 1.4 },
      { keys: ['3d printed lamp'], clicks: 67, impressions: 8120, ctr: 0.00825, position: 22.1 },
      { keys: ['modern table lamp'], clicks: 41, impressions: 12030, ctr: 0.00341, position: 38.7 },
    ],
  },
  expectedTopLevelKeys: ['siteUrl', 'dateRange', 'dimensions', 'rowCount', 'totals', 'rows'],
  expectedArrayElementKeys: { rows: ['keys', 'clicks', 'impressions', 'ctr', 'position'] },
},
```

Equivalent samples for `list_sites` and `inspect_url`.

---

## Cache strategy

Settings live in `src/connectors/base/default-policies.ts`:

| Tool | settleDays | openTtlSec | Why |
|---|---|---|---|
| `gsc.list_sites` | 0 | 3600 | Property catalog. Stable. 1h TTL. |
| `gsc.search_performance` | 5 | 600 | GSC has a 2-3 day data lag, plus a small day-N+1 settle. After 5 days, treat as final and cache aggressively (matches NB's settleDays pattern). 10-min TTL inside the open window. |
| `gsc.inspect_url` | 0 | 1800 | Index state for a single URL changes slowly — once Google has indexed it, the verdict is stable for days. 30-min TTL is plenty and conserves the daily 2,000-calls-per-property limit. |

---

## System prompt updates

New section in `src/orchestrator/prompts.ts`, routed via the existing "*5x. <connector>*" pattern:

```
*5d. Google Search Console (SEO / search visibility)* — `gsc.list_sites`, `gsc.search_performance`, `gsc.inspect_url`
  • **What lives in GSC**: how Google sees gantri.com — what queries Google ranks us for, where we rank, how many impressions/clicks each query/page gets, whether specific URLs are indexed, and crawl/canonical/mobile-usability verdicts. PRE-click data: GSC sees impressions and clicks on the SERP, NOT what happens after the click (that's GA4).
  • **Trigger words**: "Search Console", "GSC", "SEO", "ranking", "rank", "search position", "impressions", "search queries", "indexed", "Google indexed", "404 in Google", "crawled", "canonical", "average position".
  • **`gsc.search_performance`** — workhorse. Per-row clicks/impressions/ctr/position over a date range, broken by date|query|page|country|device|searchAppearance. Sort + filter (page/query/country/device). Use for "top queries", "low-CTR pages", "ranking trend", "GSC clicks for /products/*", "404s in Google (filter page contains '/404')".
  • **`gsc.inspect_url`** — single-URL deep dive. Indexing verdict, last crawl, canonical, mobile usability, rich-results verdicts. Use for "is X indexed", "why isn't X indexed", "what does Google see as the canonical for X".
  • **`gsc.list_sites`** — list verified properties. Mostly internal/discovery.
  • **Properties in scope**: `https://gantri.com/` (default — storefront, all the marketing pages and product detail pages live here) and `https://made.gantri.com/` (made-to-order subdomain — the configurator and order-status flows live here). For any storefront/SEO question default to `gantri.com`; pass `siteUrl: 'https://made.gantri.com/'` only when the user explicitly names the made-side ("indexing on made.gantri.com", "search traffic to the configurator").
  • **GSC vs GA4**: GSC is PRE-click (Google's view: SERP impressions, clicks, rank). GA4 is POST-click (real visits, behavior). Don't conflate them. For "how many people came from Google", GA4 organic. For "how many times did Google show us in search", GSC impressions. For "are our SEO efforts working", GSC position trend + GSC clicks trend.
  • **Data lag**: Search Console data is 2-3 days behind. NEVER claim "today's" or "yesterday's" GSC data — note the lag in any answer that ends within the last 3 days.
```

The exact phrasing tuned during implementation. The structural rule is "name the question shape, name the GA4-vs-GSC distinction explicitly."

---

## Testing plan

### Unit (vitest, mocked fetch) — `tests/unit/connectors/gsc/`

- `client.test.ts`
  - Builds the OAuth2 access-token request from the service-account JWT correctly (asserts `iss`, `scope`, `aud`, `exp`).
  - Caches the token; second call within 55 min reuses it.
  - On 401, refreshes the token and retries once.
  - `searchAnalyticsQuery` paginates: 25k limit, walks `startRow` until exhausted.
  - `inspectUrl` validates the `pageUrl` is within `siteUrl` (else throws).
  - 429/5xx retry behavior with backoff.
  - Throws `SearchConsoleApiError` on non-retryable 4xx with status + body.

- `connector.test.ts`
  - Each of the 3 tools: happy path with a recorded fixture, schema validation rejects bad args, error from client surfaces as `{ ok: false, error: { ... } }`.
  - `search_performance.totals.clicks` equals the SUM of `rows[].clicks` (sanity).
  - `search_performance.totals.position` is the WEIGHTED AVG by impressions across rows (the only correct way to aggregate position) — pinned with a dedicated test.
  - Date-range presets resolve to PT-anchored YYYY-MM-DD pairs, same as Impact/Klaviyo.
  - `inspect_url` flattens the deeply-nested Google response into the stable contract (`indexStatusResult.verdict` → `indexStatusVerdict`, etc).

- `tool-output-shapes.test.ts` (existing)
  - All 3 new tools have entries; example matches declared keys.

### Integration (live API, gated)

- `tests/unit/connectors/gsc/tools.test.ts` — only runs when `GSC_SERVICE_ACCOUNT_KEY` env is present. CI skips. Hits the real API:
  - `gsc.list_sites` returns at least 1 site.
  - `gsc.search_performance` for `last_30_days` with `dim=query`, `limit=10` returns rows with `clicks` ≥ 0.
  - `gsc.inspect_url` against `https://gantri.com/` returns a verdict.

### Smoke test from Slack

After deploy, manually fire from the Slack workspace:
1. "Top 20 search queries by clicks last 30 days" → ranked rows with familiar query names.
2. "Pages with high impressions but low CTR last 90 days" → pages + numbers; bot calls out the lag note.
3. "Is `https://gantri.com/products/atto-table-light` indexed?" → indexing verdict.
4. "Compare GSC clicks for /products/* vs GA4 organic sessions for the same paths last 30 days" → cross-source recon.
5. "Publish a live SEO dashboard with top queries and top pages" → URL renders.

A pass means: bot picked the right tool, response is well-formed, latency under ~10s for cached follow-ups, lag-warning included where relevant.

---

## Risks / unknowns

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Service account not granted on the GSC property.** Easy to forget; results in 403 on every call. | H | M | Boot health-check calls `list_sites`; if returns 0 properties, log a clear actionable error ("GSC service account `<email>` is not granted on any property — add it as a User in Search Console → Settings → Users and permissions"). Fail-fast on registration. |
| **2-3 day data lag confuses users** ("why doesn't yesterday's data show up?"). | H | L | Connector emits a `note` field on responses ending in the last 3 days. Prompt instructs the LLM to repeat the note. Unit-test the note logic. |
| **Position-aggregation footgun.** Naive average of `position` across rows is mathematically wrong (weighted by impressions is right). | M | M | Connector computes `totals.position` as impression-weighted average. Pinned by unit test. The LLM is told the field is already correct — don't recompute. |
| **URL Inspection daily cap (2,000/property/day).** Bulk auditing N URLs hits this fast. | L | M | Cache aggressively (30-min TTL). Document the cap in the tool description. Live Reports could in theory loop and hit it, but the 10-min in-memory cache + the daily cap == effectively never an issue for human-driven queries. |
| **GSC response volume on a page-dim 90-day query.** Can return 25k rows. | M | M | Hard cap `limit: 1000` in the connector args. If a user wants more, route them to a CSV export workflow (future). 25k client-side is fine; the issue is LLM context bloat. |
| **siteUrl format drift.** GSC verifies `https://gantri.com/` (with trailing slash) but users will type `gantri.com`, `https://www.gantri.com`, etc. | H | L | Connector normalizes the input (`new URL(...).origin + '/'`) and falls back to the configured default. If the normalized URL doesn't match a verified property, friendly error. |
| **Same service account for GA4 + GSC** — if one breaks (key rotation), both break. | L | M | Acceptable trade-off for fewer secrets / fewer manual setups. Document in runbook. Separate keys is a 30-min lift if it ever matters. |
| **PII in inspection results.** Unlikely but theoretically returns indexed URLs that contain query-string PII. | L | L | We only return URLs that the user explicitly inspected; if they pass a PII-bearing URL in, they already had it. No bulk URL listing surface. |

---

## Rollout

### Phase 1 — MVP (~2 days)

1. **Day 1:** Branch `feat/google-search-console`. Confirm the GA4 service account works for GSC by adding it as a User on the gantri.com property (manual: Search Console → Settings → Users and permissions → "Add user" → paste service account email → role "Restricted"). Probe the API manually with curl — list sites, run a tiny searchAnalytics query, inspect one URL — to confirm auth + base URL + response shapes. Document anything surprising inline.
2. **Day 1:** Implement `SearchConsoleApiClient` with TDD — token minting, paginate, retries, error mapping. Reuse `google-auth-library` (already in `package.json` from GA4).
3. **Day 1–2:** Implement `SearchConsoleConnector` with the 3 tools + Zod schemas + response reshaping. Unit tests with recorded fixtures.
4. **Day 2:** Add tool entries to `tool-output-shapes.ts` (verify against real responses, not guesses). Add tools to `WHITELISTED_TOOLS`. Add cache policies. Make the FLC invariant tests pass.
5. **Day 2:** Wire `SearchConsoleConnector` into `src/index.ts`. Update system prompt with the new section + GSC-vs-GA4 routing rules.
6. **Day 2:** Build TS, run full test suite, deploy to Fly. Smoke-test 5 questions from Slack (above).
7. **Day 2:** Send a 1-paragraph "what's new" DM (mirroring the Klaviyo/Impact announcement pattern) — to Danny first for review, then broadcast.

### Phase 2 — Polish (deferred, when prompted)

- **Sitemaps API tools** (list, get, submit-status) — useful for SEO ops audits but not for the analyst questions we have today.
- **`gsc.search_performance_compare` tool** — PoP delta as a single call. Only worth adding if the LLM repeatedly fumbles the two-call composition.
- **Bulk URL Inspection workflow** — given a list of URLs, fan-out + summarize indexing verdicts. Bounded by the 2k/day cap, so requires backpressure.
- **Per-property partition** if Gantri ever adds subdomains (m.gantri.com, etc.).

### Rollback

- Yank the registration line from `src/index.ts` (one-line revert) and redeploy. Bot keeps running; GSC questions get the graceful "not configured" error. No data migration. Vault secret stays (no need to revoke). Service-account property grant can stay or be removed manually — neither path matters for the bot's operation.

---

## Open questions (resolve before implementation)

1. **Reuse the GA4 service account or mint a new one?** Lean **reuse** — fewer secrets, fewer setup steps, and the blast radius of a key rotation is the same either way (the bot has multiple critical secrets that all need rotation handling). Decision: reuse unless GCP IAM forbids it.
2. ✅ **RESOLVED — two properties in scope**: `https://gantri.com/` (default) and `https://made.gantri.com/` (made-to-order subdomain). Connector accepts `siteUrl` arg with `gantri.com` default. Prompt gives the LLM both URLs and tells it to pass `made.gantri.com` when the user names the made-side.
3. **Do we want the `searchAppearance` dimension exposed?** It surfaces things like "Web Light", "AMP", "Rich Result". Probably yes — surface it but don't promote it in the tool description; it's niche.
4. **Should `search_performance` accept multiple page filters (e.g. "/products/*" OR "/blog/*")?** GSC's API supports group filters (`groupType: 'and'`). v1: single filter only — the LLM can compose two calls if needed. Revisit if patterns emerge.

---

## Self-review

- ✅ Tool surface stays narrow (3 tools, justified one by one, mirrors Impact's discipline).
- ✅ Read-only — no mutation surface.
- ✅ Auth pattern matches GA4 exactly (service account, Vault secret, lazy registration).
- ✅ Live Reports compatibility wired (whitelist + tool-output-shapes + cache policies).
- ✅ Cache policy explicit per tool, justified by GSC's data lag and per-URL stability.
- ✅ System prompt routing rule disambiguates GSC (pre-click) vs GA4 (post-click) — this is the most important LLM clarity win.
- ✅ Cross-source patterns (GSC↔GA4, GSC↔Klaviyo) called out without being premature tools.
- ✅ Risks list addresses the auth-grant gotcha (the most common GSC integration failure), the 2-3 day lag, the position-averaging footgun, and the URL-inspection daily cap.
- ✅ Test plan covers unit + gated integration + Slack smoke.
- ✅ Rollback is one-line revert; failure mode is graceful no-op.
- ⚠️ Manual step (granting the SA on the GSC property) is the only out-of-codebase setup. Documented; cannot be automated from outside GCP.
- ⚠️ Sitemaps endpoints deferred. If SEO ops asks for sitemap freshness audits, that's the v2 scope.

---

**Next step:** Resolve open question 2 (confirm verified property) and grant the existing GA4 service account on the GSC property. Once unblocked, implementation plan (TDD task-by-task) follows the same shape as `2026-04-26-ga4-integration.md`.
