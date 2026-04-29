# Pipedrive Connector — Design Spec

**Date**: 2026-04-29
**Author**: Danny + Claude
**Status**: Draft (pending review)

## Goal

Add a Pipedrive connector to gantri-ai-bot exposing 11 tools that cover Gantri's full B2B trade / wholesale CRM analytics surface. Drives questions like "monthly won-deal value YTD", "top firms by trade revenue", "deals lost in Q1 with reasons", "pipeline funnel by stage", "ICFF leads converted by quarter", "rep performance leaderboard".

Backed by Pipedrive's REST API (mix of v1 + v2). Auth via admin API token stored in Supabase vault.

## Non-goals

- Pipedrive write operations (create/update/delete deals). Read-only by design — the bot is for analytics, not CRM data entry.
- Webhooks subscription. Defer; we are query-time, not event-driven.
- Multi-tenant Pipedrive support. Single-tenant (Gantri).

## Tenant facts (verified live 2026-04-29)

- Subdomain: `https://gantri.pipedrive.com`
- API token belongs to Lana Arseienko (admin). Worth flagging: ties bot's Pipedrive access to her account; if she leaves Gantri, recreate via dedicated service user.
- Default currency: USD. **All deals are USD** — no FX conversion needed.
- 4 active pipelines:
  | id | Name | Stage count |
  |---|---|---|
  | 1 | Collection Pipeline-Trade & Wholesale | 5 |
  | 2 | Made Pipeline-Trade & Wholesale ("Gantri Made") | 5 |
  | 3 | Wholesale (physical/inventory) | 8 |
  | 4 | Wholesale (dropship/online) | 8 |
- Stage semantics differ across pipelines (Pipeline 1: Opportunity→Quoted→Booked→Ordered; Pipeline 3: Contact Made→Discovery→Goals→Sample→Contract→Quote→Invoice→Fulfillment). The LLM **must** call `pipedrive.list_directory` first before any stage filter to avoid cross-pipeline confusion.
- Open pipeline value (all 4): $2,481,089 across 157 open deals (April 2026).
- 9 active users (mostly admins): Chelsea, Francisco, Holland, Jennifer, Lana, Max, Michael, Stephanie, Zuzanna.
- 3 user-visible custom fields:
  - `Specifier` (org type) — hash `9539ba1ce1e5a79d39a30359e5c3e5b7a95ac082`
  - `Purchaser` (org type) — hash `1f25ac373967eb662bc1128e1312a6cde5543fe2`
  - `Source` (enum, 15 options) — hash `f21bb44b8b693a780b3e881a258257db8897b6d0`
- Source enum options: ICFF, Design Miami, Neocon / Design Days, Holland, Steph, Opensend, Gantri Trade Sign Up / Member, Shop Walk In, Rep Group NY, Rep Group SF, Inbound Email, BDNY, Shop Events, Max, Other (specify in Notes)
- **No pipeline default** in tools — they aggregate across all 4 pipelines unless the LLM filters explicitly. Decided per Danny 2026-04-29.

## API surface (verified)

- **v2** (current best practice): entity reads — `/v2/deals`, `/v2/persons`, `/v2/organizations`. Cursor pagination, typed `custom_fields{}` object.
- **v1** (still required): aggregations and metadata — `/v1/deals/timeline`, `/v1/deals/summary`, `/v1/dealFields`, `/v1/users`, `/v1/pipelines`, `/v1/stages`, `/v1/itemSearch`, `/v1/activities`. Offset pagination.
- **Auth**: API token via header `Authorization: api_token=<token>` OR query param `?api_token=<token>`. Both work; we use the header.
- **Rate limit**: token-budget-based; ~30K daily × seats × plan multiplier, plus 2-second rolling burst. Each endpoint has a token cost (timeline = 40 units). Comfortable for our use case.
- **Date format**: all wire timestamps are UTC ISO 8601. Bucket in PT in our code (consistent with rest of the bot).

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Slack (DM, mention) / Live Reports                  │
└─────────────────┬────────────────────────────────────┘
                  ▼
┌──────────────────────────────────────────────────────┐
│  PipedriveConnector (11 tools, registered in         │
│  ConnectorRegistry, all whitelisted for Live Reports)│
└─────────────────┬────────────────────────────────────┘
                  ▼
┌──────────────────────────────────────────────────────┐
│  PipedriveApiClient                                  │
│   - HTTP + auth header                               │
│   - 10-min in-memory cache for directory:            │
│     pipelines, stages, users, dealFields             │
│   - paginate<T> helper (50-page cap, generic)        │
│   - cap-bounded paginate (NEVER unbounded — orgs/    │
│     persons/deals capped to ≤2000 records)           │
└─────────────────┬────────────────────────────────────┘
                  ▼
        Pipedrive REST API
```

No rollup table. No nightly job. All tools serve live (matches the post-Klaviyo-pivot pattern). Server-aggregation via `/deals/timeline` and `/deals/summary` covers the heavy analytics; lighter pagination handles entity listings.

## File structure

| Type | Path | Responsibility |
|---|---|---|
| New | `src/connectors/pipedrive/client.ts` | HTTP client + cache + paginate helpers + typed responses |
| New | `src/connectors/pipedrive/connector.ts` | 11 tool definitions, schemas, execute methods |
| Extend | `src/index.ts` | Vault read, instantiate connector, register |
| Extend | `src/reports/live/spec.ts` | Whitelist all 11 tools |
| Extend | `src/connectors/live-reports/tool-output-shapes.ts` | Output samples for all 11 tools |
| Extend | `src/orchestrator/prompts.ts` | Tool documentation section for Pipedrive |
| New | `tests/unit/connectors/pipedrive/client.test.ts` | Client unit tests (auth, cache, pagination cap, response parsing) |
| New | `tests/unit/connectors/pipedrive/connector.test.ts` | All 11 tool tests, mocked client |
| Extend | `tests/unit/connectors/base/date-range-invariant.test.ts` | Auto-picks up the new whitelisted tools |

## Tools (11)

All output shapes follow `{ period, granularity, rows, note? }` where applicable. Currency hard-coded USD (skip in args).

### Discovery / lookup (small, cached)

#### 1. `pipedrive.list_directory`
- **Args**: `kind: 'pipelines' | 'stages' | 'users' | 'deal_fields' | 'source_options'`
- **Description**: Returns the small static directories the LLM needs to map names → ids before calling other tools. Cached 10 min.
- **Output**:
  - `pipelines`: `[{id, name, active}]`
  - `stages`: `[{id, pipeline_id, pipeline_name, name, order_nr}]`
  - `users`: `[{id, name, email, active, is_admin}]`
  - `deal_fields`: `[{key, name, type, options?}]` (only user-visible custom fields)
  - `source_options`: `[{id, label}]` (the Source enum values, dereferenced)

#### 2. `pipedrive.search`
- **Args**: `query: string`, `entity?: 'all' | 'deals' | 'persons' | 'organizations' = 'all'`, `limit?: number = 10`
- **Description**: Fuzzy substring search across deals, persons, and orgs via `/v1/itemSearch`. Returns minimal records with `id, type, name, summary`.
- **Use case**: "find KBM-Hogue", "search for Bilotti", "any deal mentioning Wirecutter"

### Aggregations (server-side, time-series)

#### 3. `pipedrive.deal_timeseries`
- **Args**: `dateRange: DateRangeArg`, `granularity: 'day'|'week'|'month'|'quarter' = 'month'`, `dateField: 'add_time'|'won_time'|'close_time'|'expected_close_date' = 'won_time'`, `pipelineId?: number`, `ownerId?: number`, `stageId?: number`, `sourceOptionId?: number`
- **Description**: Counts and total/won/open value per time bucket via `/v1/deals/timeline`. Server-aggregated. Filterable by pipeline, owner, stage, lead source.
- **Output rows**: `{key, count, totalValueUsd, wonCount, wonValueUsd, openCount, openValueUsd, weightedValueUsd}`
- **Use case**: "Monthly won-deal value YTD", "Deals created per week in Q1", "ICFF leads (sourceOptionId=161) converted by month"

#### 4. `pipedrive.pipeline_snapshot`
- **Args**: `pipelineId?: number`, `ownerId?: number`, `status: 'open'|'won'|'lost'|'all' = 'open'`
- **Description**: Point-in-time stage funnel: count + value per stage in a pipeline (or all pipelines). Built on a single paginated `/v2/deals` scan filtered by status, grouped client-side by stage_id.
- **Output rows**: `{stageId, stageName, pipelineId, pipelineName, count, totalValueUsd}`
- **Use case**: "Funnel of Made pipeline right now", "Open deals owned by Maria by stage", "Stuck deals — biggest count by stage"

### Deal-level

#### 5. `pipedrive.list_deals`
- **Args**: `dateRange?: DateRangeArg`, `dateField?: 'add_time'|'won_time'|'close_time'|'update_time' = 'update_time'`, `status?: 'open'|'won'|'lost'|'deleted'|'all_not_deleted' = 'all_not_deleted'`, `pipelineId?`, `stageId?`, `ownerId?`, `orgId?`, `personId?`, `sourceOptionId?`, `search?: string`, `sortBy?: 'value'|'add_time'|'update_time'|'won_time' = 'value'`, `sortOrder?: 'asc'|'desc' = 'desc'`, `limit: number = 50` (max 500)
- **Description**: Cursor-paginated list of deals with the analytical fields. Hard cap of 500/call to prevent runaway scans.
- **Output rows**: `{id, title, status, valueUsd, pipelineId, stageId, ownerId, ownerName, orgId, orgName, personId, personName, addTime, wonTime, lostTime, lostReason, sourceLabel, specifierOrgName, purchaserOrgName, expectedCloseDate}`
- **Use case**: "Top 20 open deals by value", "Lost deals last month with their reasons", "All deals from ICFF source"

#### 6. `pipedrive.deal_detail`
- **Args**: `dealId: number`
- **Description**: Single deal with all fields, custom fields resolved to human-readable names + linked person + org + last activity.
- **Output**: All fields from list_deals row PLUS: `personDetail{name, emails, phones}, orgDetail{name, address, web}, lastActivity{type, subject, dueDate, done}, products[{name, qty, priceUsd}], notesCount, activitiesCount, doneActivitiesCount, customFields{...all user-visible custom fields by name}`
- **Use case**: "Show me deal 816 in detail", "What's the context on the KBM-Hogue deal"

### Customer / pipeline analysis

#### 7. `pipedrive.organization_performance`
- **Args**: `dateRange: DateRangeArg`, `topN: number = 25` (max 100), `metric: 'won_value'|'won_count'|'open_value' = 'won_value'`
- **Description**: Top organizations by contribution over a window. Hybrid: paginate `/v2/deals?status=won` (or `open`) over the window, group client-side by `org_id`, join names from `/v2/organizations?ids=...`. Capped at ~5000 deals scanned (10 pages).
- **Output rows**: `{orgId, orgName, dealCount, totalValueUsd, wonCount, wonValueUsd, openCount, openValueUsd, lastDealTime}`
- **Use case**: "Top 10 firms by trade revenue YTD", "Customer concentration analysis", "Repeat buyers in Q1"

#### 8. `pipedrive.organization_detail`
- **Args**: `orgId: number`, `includeDeals: boolean = true`, `includePersons: boolean = true`, `includeActivities: boolean = false`
- **Description**: Single org with deals, contacts, and optionally activities. Useful for account-context lookups.
- **Output**: `{org: {id, name, address, web, ...}, deals?: [list_deals row, max 50], persons?: [{id, name, emails, phones}, max 50], activities?: [{id, type, subject, due, done, ownerName}, max 50]}`
- **Use case**: "Tell me about Rarify — who's our contact, what deals are open, last interaction"

#### 9. `pipedrive.lost_reasons_breakdown`
- **Args**: `dateRange: DateRangeArg`, `pipelineId?`, `groupBy: 'reason'|'reason_and_stage' = 'reason'`, `topN: number = 25`
- **Description**: Group lost deals by `lost_reason` (and optionally last stage) over a window. Pagina `/v2/deals?status=lost` con date filter, agrega client-side.
- **Output rows**: `{reason, count, totalValueUsd, percentOfTotal, ...stageBreakdown if groupBy='reason_and_stage'}`
- **Use case**: "Why did we lose Q1 deals", "Lost reasons in Wholesale physical pipeline last quarter"

### Productivity

#### 10. `pipedrive.activity_summary`
- **Args**: `dateRange: DateRangeArg`, `granularity?: 'day'|'week'|'month' = 'month'`, `userId?`, `type?: 'call'|'meeting'|'email'|'task'|'all' = 'all'`, `status?: 'done'|'pending'|'all' = 'done'`
- **Description**: Volume of activities by user/type/status over a window. Pagina `/v1/activities` with filters, aggregates client-side. Capped at 5000 activities.
- **Output rows**: `{key, count, byType: {call, meeting, email, task}, byUser: [{userId, userName, count}]}`
- **Use case**: "How many calls did Max log in March", "Pending activities by user", "Meeting count trend last 6 months"

#### 11. `pipedrive.user_performance`
- **Args**: `dateRange: DateRangeArg`, `metric: 'won_value'|'won_count'|'activities_done'|'avg_deal_value' = 'won_value'`, `topN?: number = 10`
- **Description**: Sales rep leaderboard for the window. For deal metrics, use `/v1/deals/timeline?user_id=...` per user (cached directory). For activity metrics, paginate `/v1/activities` and group.
- **Output rows**: `{userId, userName, value, rank}` where `value` is the metric requested
- **Use case**: "Top performer last quarter by won revenue", "Who closed the most deals in March", "Best avg deal size by rep"

## Client design

`PipedriveApiClient`:

```ts
constructor({ apiToken, fetchImpl?, baseUrl? = 'https://api.pipedrive.com' })

// Directory (cached 10 min)
listPipelines(): Promise<Pipeline[]>
listStages(): Promise<Stage[]>
listUsers(): Promise<User[]>
listDealFields(): Promise<DealField[]>

// Aggregation
dealsTimeline(opts): Promise<TimelinePeriod[]>  // /v1/deals/timeline
dealsSummary(opts): Promise<DealsSummary>        // /v1/deals/summary

// Lists (paginated, capped)
listDeals(opts): Promise<{ items: Deal[], hasMore: boolean }>           // /v2/deals
listOrganizations(opts): Promise<{ items: Org[], hasMore: boolean }>    // /v2/organizations
listPersons(opts): Promise<{ items: Person[], hasMore: boolean }>       // /v2/persons
listActivities(opts): Promise<{ items: Activity[], hasMore: boolean }>  // /v1/activities

// Single fetch
getDeal(id): Promise<DealDetail>
getOrganization(id): Promise<OrgDetail>

// Search
itemSearch(query, opts): Promise<SearchResult>  // /v1/itemSearch

// Internal: paginate<T> with maxPages cap (default 10)
```

## Error handling

| Failure | Detection | Action |
|---|---|---|
| 401/403 | response status | Throw `PipedriveApiError` with status, body. Likely token expired or wrong scope. |
| 429 (rate limit) | response status | Backoff + retry once (1s, then 2s). Then throw if still failing. |
| 5xx | response status | Backoff + retry once. |
| Pagination cap exceeded | counter | Log warning, return partial result with `truncated: true` flag. Do NOT throw — partial data is better than none for analytics. |
| Custom field hash unknown | lookup miss | Skip the custom field in the output, log warn (probably new field added in Pipedrive UI). |
| Empty result for time-series window | empty `data[]` | Return `rows: []`, no error. |

## Testing

| Test | Coverage |
|---|---|
| Client: auth header attached to every request | core auth |
| Client: cache directory across calls (1 fetch for 2 calls within TTL) | cache |
| Client: 10-min TTL expires correctly | cache |
| Client: pagination respects maxPages | safety cap |
| Client: 401 throws PipedriveApiError | auth error |
| Client: 429 retries once and throws if still failing | rate limit |
| Client: parses dealsTimeline shape correctly (totals.values.USD) | response parsing |
| Each tool (×11): happy path with stubbed client | tool logic |
| Each tool (×11): preset string accepted via DateRangeArg | invariant |
| Each tool (×11) where applicable: empty result returns `rows: []` + freshness | edge case |
| Live Reports invariant test (auto-picks up new whitelisted tools) | regression |
| Smoke (manual post-deploy): one tool from each category against real API | sanity |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| API token belongs to a person (Lana) — leaves Gantri → bot breaks | Medium | Document in spec + plan. Migrate to dedicated service user as follow-up. |
| Pipeline 1 (Collection) and Pipeline 2 (Made) have overlapping stage names ("Opportunity", "Quoted", "Booked") — LLM gets confused | Medium | `list_directory` returns `pipeline_name` alongside stage name; tool descriptions explicitly tell the LLM to filter by `pipelineId` when stage names ambiguous. |
| Custom fields change (Gantri adds / renames in UI) | Low | `dealFields` cache TTL is 10 min, so a new field appears within 10 min on its own. The connector is field-name-driven (not hash-hardcoded) so this works. |
| Pagination caps return partial data, user thinks the count is total | Low | Output includes `truncated: true` flag and a `note` line; LLM is instructed to surface it. |
| Lana's Pipedrive UI workflow uses fields/views we don't expose | Medium | Defer to follow-ups. Coverage is comprehensive for analytics; UI-driven workflows out of scope. |
| Rate-limit spike during a Live Reports refresh storm | Low | Daily token budget is generous; per-tool cost is bounded. If we ever hit it, add inter-call delay or per-tenant cache. |

## Out of scope (explicit)

- Write operations (create/update/delete deals/persons/orgs/activities)
- Webhooks / push notifications
- Multi-tenant Pipedrive support
- File/note upload + retrieval
- Email integration (Pipedrive's "Sales Inbox")
- The Pipedrive Insights internal endpoints (only REST endpoints exposed)
