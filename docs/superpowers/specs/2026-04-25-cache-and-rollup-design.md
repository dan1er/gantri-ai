# Closed-Period Cache + Daily Rollup — Design Spec

**Date:** 2026-04-25
**Owner:** Danny
**Status:** Approved (in-thread)

## Goal

Stop recomputing immutable historical aggregates on every question. Two layers:

1. **Tier 1 — Closed-period result cache.** Wrap the connector registry with a cache that, for any tool call whose date range ends before *today minus a per-tool settle window*, persists the result indefinitely.
2. **Tier 2 — Daily rollup table.** Materialize per-day revenue + order counts (with breakdowns by `type`, `status`, `organizationId`) into Supabase via a nightly job. Expose a `gantri.daily_rollup` tool the bot prefers over raw SQL for any aggregation that matches its grain.

## Non-Goals

- Pre-built quarterly/annual canvases (tier 3 — not in this scope).
- Cache invalidation on individual Porter writes. We accept the simpler "30d settle window" approximation for refunds.
- Sub-day rollup grain (hourly, weekly, monthly). The bot can roll up further from daily on the fly.

## Tier 1 — Closed-Period Cache

### Cache key

Deterministic SHA-256 hash of `JSON.stringify(canonicalize({tool, args, version}))`, where:

- Object keys are sorted alphabetically before stringify.
- Date strings are normalized to `YYYY-MM-DD`.
- SQL strings are whitespace-collapsed (`/\s+/g → ' '`).
- The `version` is a per-tool integer that the connector author bumps when the tool's args shape or output shape changes (so old cache entries get orphaned, not poisoned).

This gives us hash equality across phrasings: "best week 2025" and "top week 2025" — once compiled by the LLM into the same `grafana.sql` call — hit the same bucket.

### Per-tool cache policy

A small registry mapping `tool_name → CachePolicy`:

```ts
interface CachePolicy {
  /** Per-tool cache schema version. Bump on breaking output changes. */
  version: number;
  /** Days to wait after a period closes before considering its data final.
   *  0 = trust the read-replica.
   *  72h = Northbeam attribution settling.
   *  30d = Porter refunds. */
  settleDays: number;
  /** Where in args to find the date range used for closed-period detection. */
  dateRangePath?: string; // e.g. 'dateRange', 'period.range', or undefined for "always TTL only"
  /** TTL (seconds) when the date range is open / partial. 0 = no fallback caching. */
  openTtlSec: number;
}
```

Default policies (initial values):

| Tool | settleDays | openTtlSec | dateRangePath |
|------|------------|-----------|---------------|
| `grafana.sql` | 0 | 60 | (sniff `args.dateRange` or skip if SQL has hard-coded literals) |
| `grafana.run_dashboard` | 0 | 300 | `dateRange` |
| `gantri.order_stats` | 30 | 60 | `dateRange` |
| `gantri.orders_query` | 30 | 0 | `dateRange` (don't cache live row dumps) |
| `gantri.order_get` | — | 0 | (single-row lookup, status mutates, skip) |
| `northbeam.overview` | 3 | 600 | `dateRange` |
| `northbeam.sales` | 3 | 600 | `dateRange` |
| `northbeam.orders_summary` | 3 | 600 | `dateRange` |
| `northbeam.orders_list` | 3 | 0 | (skip — too volatile per row) |
| `northbeam.metrics_explorer` | 3 | 600 | `dateRange` |

### Storage

Reuse the existing `northbeam_cache` table, but rename it (migration) to `tool_result_cache` and broaden its schema:

```sql
alter table northbeam_cache rename to tool_result_cache;
alter table tool_result_cache add column tool text not null default 'northbeam';
alter table tool_result_cache add column frozen boolean not null default false;
-- frozen=true means the row never expires (closed-period). expires_at is then
-- set to a far-future date (e.g. 2099-01-01) for index-friendly queries.
```

A single `cleanup` job (runs hourly) deletes rows where `frozen = false AND expires_at < now()`. Frozen rows persist forever or until explicitly invalidated.

### Wrapper

A `CachingRegistry` extends `ConnectorRegistry`:

```ts
class CachingRegistry {
  async execute(toolName: string, args: unknown): Promise<ToolResult> {
    const policy = getCachePolicy(toolName);
    if (!policy) return this.inner.execute(toolName, args);
    const decision = decideCacheStrategy(policy, args, new Date());
    // decision: { mode: 'frozen' | 'ttl' | 'skip', ttlSec?: number, key?: string }
    if (decision.mode === 'skip') return this.inner.execute(toolName, args);
    const hit = await this.cache.get(decision.key);
    if (hit) {
      logger.info({ tool: toolName, mode: decision.mode, hit: true });
      return hit;
    }
    const result = await this.inner.execute(toolName, args);
    if (result.ok) {
      await this.cache.set(decision.key, result, {
        frozen: decision.mode === 'frozen',
        expiresAt: decision.mode === 'ttl' ? new Date(Date.now() + decision.ttlSec! * 1000) : null,
      });
    }
    return result;
  }
}
```

`decideCacheStrategy` reads the date range from `args` (via `dateRangePath`) and:
- If `endDate < today - settleDays`: `mode: 'frozen'`.
- Else if `openTtlSec > 0`: `mode: 'ttl'`, ttl from policy.
- Else: `mode: 'skip'`.

## Tier 2 — Daily Rollup

### Schema

```sql
create table sales_daily_rollup (
  date date primary key,                     -- PT calendar day
  total_orders int not null default 0,
  total_revenue_cents bigint not null default 0,
  by_type jsonb not null default '{}'::jsonb,         -- { 'Order': {orders, revenueCents}, ... }
  by_status jsonb not null default '{}'::jsonb,
  by_organization jsonb not null default '{}'::jsonb, -- { '<orgId or null>': {orders, revenueCents}, ... }
  refreshed_at timestamptz not null default now()
);
create index sales_daily_rollup_refreshed_idx on sales_daily_rollup (refreshed_at);
```

The `by_*` JSON fields are flat `{key: {orders, revenueCents}}` maps so we can store unbounded categories without widening the row.

### Refresh job

In-process, alongside `ReportsRunner`. Default schedule: daily at 04:00 PT (a few hours after midnight to absorb late writes).

Each refresh:

1. Compute the recompute window: `[today_pt - 30d, today_pt - 1d]` (yesterday is the latest closed PT day; the tail covers refunds within the settle window).
2. Run a single `grafana.sql` query that returns `(date, total_orders, total_revenue_cents, by_type, by_status, by_organization)` for each day in the window.
3. UPSERT each row into Supabase.
4. Log hit count, duration.

Initial backfill: on first run, walk back 24 months in 30-day chunks (~24 calls).

The query for a single window:

```sql
WITH txn AS (
  SELECT
    DATE_TRUNC('day', t."createdAt" AT TIME ZONE 'America/Los_Angeles')::date AS day,
    t.type,
    t.status,
    t."organizationId",
    COALESCE((amount->>'total')::numeric,
             (amount->>'subtotal')::numeric
             + COALESCE((amount->>'shipping')::numeric, 0)
             + COALESCE((amount->>'tax')::numeric, 0)) AS revenue_cents
  FROM "Transactions" t
  WHERE t."createdAt" >= $start AND t."createdAt" < $end
    AND t.status NOT IN ('Cancelled','Lost')
)
SELECT
  day,
  COUNT(*)::int AS total_orders,
  SUM(revenue_cents)::bigint AS total_revenue_cents,
  jsonb_object_agg(type_key, type_agg) FILTER (WHERE type_key IS NOT NULL) AS by_type,
  ...
```

(Full query lives in the rollup-refresh module.)

### Tool: `gantri.daily_rollup`

Args:

```ts
{
  dateRange: { startDate: 'YYYY-MM-DD'; endDate: 'YYYY-MM-DD' };  // PT
  dimension?: 'type' | 'status' | 'organization' | 'none';        // default 'none'
  types?: string[];                                                // optional filter
  granularity?: 'day' | 'week' | 'month';                          // default 'day'
}
```

Returns rows in the requested grain, summed across the requested dimension. The tool reads from `sales_daily_rollup` directly (no Porter / Grafana call); for week/month grain it sums across the daily rows.

If the requested range extends beyond `MAX(refreshed_at)`'s coverage (e.g. asking for "this week" before today's rollup has run), the tool transparently falls back to a `grafana.sql` query for the missing tail and merges. Caller doesn't need to know.

## Wiring

`src/index.ts` changes:

1. Wrap the `ConnectorRegistry` with `CachingRegistry` after all connectors are registered.
2. Register `RollupConnector` (exposes `gantri.daily_rollup`).
3. Construct + start the `RollupRefreshJob`.
4. The orchestrator receives the `CachingRegistry` instead of the raw one.

## System prompt updates

- Add `gantri.daily_rollup` to the catalog (section 6 Porter, or a new section).
- Routing rule: for "revenue / orders by day/week/month over a period" questions, prefer `gantri.daily_rollup` over `grafana.sql`.
- Note that the rollup excludes `Cancelled` / `Lost` orders (so it matches the "Order" total people expect on the Sales report).

## Out of scope for v1

- Per-customer rollup (would 100x the row count). Use `grafana.sql` for those.
- Real-time invalidation on Porter writes.
- Cache hit/miss metrics dashboard.
- Migrating existing `northbeam_cache` rows (we'll just let them age out naturally; the new code reads/writes under the renamed table).
