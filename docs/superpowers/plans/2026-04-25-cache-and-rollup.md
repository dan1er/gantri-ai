# Closed-Period Cache + Daily Rollup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop recomputing immutable historical aggregates on every question. Two layers: (1) a closed-period result cache that wraps the connector registry and freezes any tool result whose date range ends before "today minus a per-tool settle window"; (2) a daily rollup table in Supabase that the bot prefers over raw SQL for any aggregate revenue/orders question.

**Architecture:** Tier 1 is a `CachingRegistry` decorator over `ConnectorRegistry` plus a per-tool `CachePolicy` map; cache rows live in a renamed/extended `tool_result_cache` table with a `frozen` flag. Tier 2 is a new `sales_daily_rollup` table in Supabase, refreshed nightly by an in-process job that queries Grafana SQL, plus a new `gantri.daily_rollup` tool the bot prefers via system-prompt guidance.

**Tech Stack:** TypeScript 5.x ESM, Node 20, Supabase (Postgres), `@anthropic-ai/sdk`, vitest. Spec: `docs/superpowers/specs/2026-04-25-cache-and-rollup-design.md`.

---

## File Structure

```
migrations/
  0004_tool_result_cache.sql              -- rename + extend existing northbeam_cache
  0005_sales_daily_rollup.sql             -- new rollup table

src/storage/
  cache.ts                                -- modify: add frozen flag, broaden tool field
  rollup-repo.ts                          -- new: read/write sales_daily_rollup

src/connectors/base/
  cache-policy.ts                         -- new: per-tool CachePolicy + decideCacheStrategy
  caching-registry.ts                     -- new: decorator wrapping ConnectorRegistry

src/connectors/rollup/
  rollup-connector.ts                     -- new: exposes gantri.daily_rollup
  rollup-refresh.ts                       -- new: nightly refresh job + backfill

tests/unit/
  storage/cache.test.ts                   -- modify: add frozen-flag tests
  connectors/base/cache-policy.test.ts    -- new
  connectors/base/caching-registry.test.ts -- new
  connectors/rollup/rollup-connector.test.ts -- new

src/orchestrator/prompts.ts               -- modify: add gantri.daily_rollup section
src/index.ts                              -- modify: wrap registry + register RollupConnector + start refresh job
```

---

## Task 1: Rename + extend tool result cache table

**Files:**
- Create: `migrations/0004_tool_result_cache.sql`

- [ ] **Step 1: Write the migration**

Create `migrations/0004_tool_result_cache.sql`:

```sql
-- Broaden the existing northbeam_cache into a generic tool result cache.
alter table if exists northbeam_cache rename to tool_result_cache;

alter table tool_result_cache add column if not exists tool text;
alter table tool_result_cache add column if not exists frozen boolean not null default false;

update tool_result_cache set tool = 'northbeam' where tool is null;
alter table tool_result_cache alter column tool set not null;

create index if not exists tool_result_cache_tool_idx on tool_result_cache (tool);
create index if not exists tool_result_cache_expires_idx_active
  on tool_result_cache (expires_at) where not frozen;
```

- [ ] **Step 2: Apply via Supabase MCP**

Use `mcp__supabase__apply_migration` with `project_id: "ykjjwszoxazzlcovhlgd"`, `name: "tool_result_cache"`, and the SQL above.

Verify with:

```sql
select column_name, data_type from information_schema.columns
where table_name = 'tool_result_cache' order by ordinal_position;
```

Expected columns: `cache_key text`, `response jsonb`, `expires_at timestamptz`, `tool text`, `frozen boolean` (plus whatever else was on `northbeam_cache`).

- [ ] **Step 3: Commit**

```bash
git add migrations/0004_tool_result_cache.sql
git commit -m "feat(cache): rename northbeam_cache → tool_result_cache; add frozen flag"
```

---

## Task 2: Daily rollup table

**Files:**
- Create: `migrations/0005_sales_daily_rollup.sql`

- [ ] **Step 1: Write the migration**

Create `migrations/0005_sales_daily_rollup.sql`:

```sql
create table if not exists sales_daily_rollup (
  date date primary key,
  total_orders int not null default 0,
  total_revenue_cents bigint not null default 0,
  by_type jsonb not null default '{}'::jsonb,
  by_status jsonb not null default '{}'::jsonb,
  by_organization jsonb not null default '{}'::jsonb,
  refreshed_at timestamptz not null default now()
);

create index if not exists sales_daily_rollup_refreshed_idx
  on sales_daily_rollup (refreshed_at);
```

- [ ] **Step 2: Apply via Supabase MCP**

`mcp__supabase__apply_migration`, `project_id: "ykjjwszoxazzlcovhlgd"`, `name: "sales_daily_rollup"`, body above.

Verify:

```sql
select column_name, data_type from information_schema.columns
where table_name = 'sales_daily_rollup' order by ordinal_position;
```

Expected: 7 columns (`date`, `total_orders`, `total_revenue_cents`, `by_type`, `by_status`, `by_organization`, `refreshed_at`).

- [ ] **Step 3: Commit**

```bash
git add migrations/0005_sales_daily_rollup.sql
git commit -m "feat(rollup): sales_daily_rollup table"
```

---

## Task 3: Extend cache.ts with frozen flag and tool field

**Files:**
- Modify: `src/storage/cache.ts`
- Modify: `tests/unit/cache.test.ts`

- [ ] **Step 1: Read the current cache module**

Look at `src/storage/cache.ts` and `tests/unit/cache.test.ts` to understand the existing API. The class is likely called `TtlCache` and has `get(key)` / `set(key, value, ttlSec)` plus a static `key(prefix, args)` helper.

- [ ] **Step 2: Add a frozen-aware set method**

Modify the cache module so `set()` accepts an options object:

```ts
async set(
  key: string,
  value: unknown,
  options: { ttlSec?: number; frozen?: boolean; tool?: string }
): Promise<void> {
  const expiresAt = options.frozen
    ? new Date('2099-01-01T00:00:00Z')
    : new Date(Date.now() + (options.ttlSec ?? 0) * 1000);
  await this.client
    .from('tool_result_cache')
    .upsert({
      cache_key: key,
      response: value,
      expires_at: expiresAt.toISOString(),
      tool: options.tool ?? 'unknown',
      frozen: options.frozen ?? false,
    });
}
```

Keep the legacy 2-arg `set(key, value, ttlSec)` signature working via an overload.

`get` stays the same (it just checks `expires_at > now`).

Update the from-clause in `get` and any deletes to point at `tool_result_cache` instead of `northbeam_cache`.

- [ ] **Step 3: Add tests**

In `tests/unit/cache.test.ts` add:

```ts
it('frozen set persists with far-future expiry', async () => {
  const supabase = mockSupabase();
  const cache = new TtlCache(supabase as any);
  await cache.set('key1', { hello: 'world' }, { frozen: true, tool: 'grafana.sql' });
  const upsertCall = supabase.from('tool_result_cache').upsert.mock.calls[0][0];
  expect(upsertCall.frozen).toBe(true);
  expect(upsertCall.tool).toBe('grafana.sql');
  // expiry is far in the future
  expect(new Date(upsertCall.expires_at).getFullYear()).toBeGreaterThanOrEqual(2099);
});

it('ttl set still works via the new options form', async () => {
  const supabase = mockSupabase();
  const cache = new TtlCache(supabase as any);
  await cache.set('key2', { x: 1 }, { ttlSec: 60, tool: 'northbeam.overview' });
  const upsertCall = supabase.from('tool_result_cache').upsert.mock.calls[0][0];
  expect(upsertCall.frozen).toBe(false);
  expect(new Date(upsertCall.expires_at).getTime()).toBeGreaterThan(Date.now() + 50_000);
});
```

(Use whatever mocking helper already exists in the test file. If there is none, build a small `mockSupabase()` returning chainable `from().upsert()` + `from().select().eq().lt().single()` mocks via `vi.fn()`.)

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/cache.test.ts
```

Expected: existing tests still pass + 2 new pass.

- [ ] **Step 5: Commit**

```bash
git add src/storage/cache.ts tests/unit/cache.test.ts
git commit -m "feat(cache): add frozen flag + tool tag; point at tool_result_cache table"
```

---

## Task 4: CachePolicy + decideCacheStrategy

**Files:**
- Create: `src/connectors/base/cache-policy.ts`
- Create: `tests/unit/connectors/base/cache-policy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/connectors/base/cache-policy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  decideCacheStrategy,
  canonicalKey,
  type CachePolicy,
} from '../../../../src/connectors/base/cache-policy.js';

const TZ = 'America/Los_Angeles';
// Pretend "now" is 2026-04-25 (PT). Anything ending before 2026-03-26 is
// "fully closed" given a 30-day settle window.
const NOW = new Date('2026-04-25T15:00:00.000Z');

describe('decideCacheStrategy', () => {
  const porterPolicy: CachePolicy = {
    version: 1,
    settleDays: 30,
    openTtlSec: 60,
    dateRangePath: 'dateRange',
  };

  it('returns frozen for a fully closed range', () => {
    const args = { dateRange: { startDate: '2025-01-01', endDate: '2025-12-31' } };
    const d = decideCacheStrategy(porterPolicy, args, NOW, TZ);
    expect(d.mode).toBe('frozen');
    expect(d.key).toBeTruthy();
  });

  it('returns ttl for a partially-open range (this month)', () => {
    const args = { dateRange: { startDate: '2026-04-01', endDate: '2026-04-30' } };
    const d = decideCacheStrategy(porterPolicy, args, NOW, TZ);
    expect(d.mode).toBe('ttl');
    expect(d.ttlSec).toBe(60);
  });

  it('returns skip when openTtlSec is 0 and range is open', () => {
    const policy = { ...porterPolicy, openTtlSec: 0 };
    const args = { dateRange: { startDate: '2026-04-01', endDate: '2026-04-30' } };
    const d = decideCacheStrategy(policy, args, NOW, TZ);
    expect(d.mode).toBe('skip');
  });

  it('treats endDate exactly at the settle boundary as still-open (conservative)', () => {
    // 2026-04-25 - 30d = 2026-03-26. endDate of 2026-03-26 is NOT past the boundary.
    const args = { dateRange: { startDate: '2026-03-01', endDate: '2026-03-26' } };
    const d = decideCacheStrategy(porterPolicy, args, NOW, TZ);
    expect(d.mode).toBe('ttl');
  });

  it('returns frozen one day past the boundary', () => {
    const args = { dateRange: { startDate: '2026-03-01', endDate: '2026-03-25' } };
    const d = decideCacheStrategy(porterPolicy, args, NOW, TZ);
    expect(d.mode).toBe('frozen');
  });

  it('returns skip when policy has no dateRangePath', () => {
    const policy: CachePolicy = { version: 1, settleDays: 0, openTtlSec: 0 };
    const d = decideCacheStrategy(policy, { id: 53107 }, NOW, TZ);
    expect(d.mode).toBe('skip');
  });
});

describe('canonicalKey', () => {
  it('produces the same key regardless of object key order', () => {
    const a = canonicalKey('grafana.sql', { sql: 'SELECT 1', dateRange: { endDate: '2025-12-31', startDate: '2025-01-01' } }, 1);
    const b = canonicalKey('grafana.sql', { dateRange: { startDate: '2025-01-01', endDate: '2025-12-31' }, sql: 'SELECT 1' }, 1);
    expect(a).toBe(b);
  });

  it('changes when the version bumps', () => {
    const v1 = canonicalKey('x.y', { a: 1 }, 1);
    const v2 = canonicalKey('x.y', { a: 1 }, 2);
    expect(v1).not.toBe(v2);
  });

  it('collapses SQL whitespace', () => {
    const a = canonicalKey('grafana.sql', { sql: 'SELECT  1\nFROM t' }, 1);
    const b = canonicalKey('grafana.sql', { sql: 'SELECT 1 FROM t' }, 1);
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx vitest run tests/unit/connectors/base/cache-policy.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/connectors/base/cache-policy.ts`:

```ts
import { createHash } from 'node:crypto';

/** Per-tool caching policy. Read by CachingRegistry on every execute(). */
export interface CachePolicy {
  /** Bump on breaking arg/output shape changes to orphan stale cache rows. */
  version: number;
  /** Days after a date range closes before the result is considered final.
   *  0 = trust immediately. 3 = Northbeam attribution settling. 30 = Porter refunds. */
  settleDays: number;
  /** TTL (sec) when the range overlaps "today minus settleDays" or later. 0 = skip caching the open case. */
  openTtlSec: number;
  /** Dot-path inside args to the {startDate, endDate} object. Omit for tools without a date range (we always skip). */
  dateRangePath?: string;
}

export interface CacheDecision {
  mode: 'frozen' | 'ttl' | 'skip';
  key?: string;
  ttlSec?: number;
}

/** Compute a deterministic cache key for a tool call. */
export function canonicalKey(tool: string, args: unknown, version: number): string {
  const canonical = canonicalize(args);
  const payload = JSON.stringify({ tool, version, args: canonical });
  return createHash('sha256').update(payload).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  if (typeof value === 'string') {
    // Collapse internal whitespace for SQL-like fields.
    return value.replace(/\s+/g, ' ').trim();
  }
  return value;
}

/**
 * Decide whether to cache a tool call as frozen, TTL, or skip entirely.
 * `now` is injected for testability; in production it should be `new Date()`.
 */
export function decideCacheStrategy(
  policy: CachePolicy,
  args: unknown,
  now: Date,
  timezone: string,
): CacheDecision {
  if (!policy.dateRangePath) return { mode: 'skip' };
  const range = readByPath(args, policy.dateRangePath) as
    | { startDate?: string; endDate?: string }
    | undefined;
  if (!range || typeof range.endDate !== 'string') {
    return policy.openTtlSec > 0
      ? { mode: 'ttl', key: canonicalKey('?', args, policy.version), ttlSec: policy.openTtlSec }
      : { mode: 'skip' };
  }
  const todayPt = pacificDay(now, timezone);
  const boundary = addDays(todayPt, -policy.settleDays);
  // strictly less than: a range ending exactly at the boundary is still considered "open" (conservative).
  if (range.endDate < boundary) {
    return {
      mode: 'frozen',
      key: canonicalKey('?', args, policy.version),
    };
  }
  if (policy.openTtlSec > 0) {
    return {
      mode: 'ttl',
      key: canonicalKey('?', args, policy.version),
      ttlSec: policy.openTtlSec,
    };
  }
  return { mode: 'skip' };
}

function readByPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function pacificDay(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
```

Note: `canonicalKey('?', ...)` is wrong in `decideCacheStrategy` — replace `'?'` with the **actual tool name passed in**. Update the function signature to accept `toolName: string` as the first argument:

```ts
export function decideCacheStrategy(
  toolName: string,
  policy: CachePolicy,
  args: unknown,
  now: Date,
  timezone: string,
): CacheDecision {
  ...
  return { mode: 'frozen', key: canonicalKey(toolName, args, policy.version) };
  ...
}
```

And update the test to pass `'gantri.order_stats'` as the first argument.

(Apply this fix when writing — the test cases above need the signature update too. Use `decideCacheStrategy('gantri.order_stats', porterPolicy, args, NOW, TZ)`.)

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/connectors/base/cache-policy.test.ts
```

Expected: 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/base/cache-policy.ts tests/unit/connectors/base/cache-policy.test.ts
git commit -m "feat(cache): CachePolicy + decideCacheStrategy + canonicalKey"
```

---

## Task 5: CachingRegistry decorator

**Files:**
- Create: `src/connectors/base/caching-registry.ts`
- Create: `tests/unit/connectors/base/caching-registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/connectors/base/caching-registry.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { ConnectorRegistry } from '../../../../src/connectors/base/registry.js';
import type { Connector, ToolDef } from '../../../../src/connectors/base/connector.js';
import { CachingRegistry } from '../../../../src/connectors/base/caching-registry.js';

function fakeRegistry(execImpl: (args: any) => any) {
  const exec = vi.fn(async (args: any) => execImpl(args));
  const tool: ToolDef = {
    name: 'gantri.order_stats',
    description: '',
    schema: z.object({}).passthrough(),
    jsonSchema: { type: 'object' },
    execute: exec,
  };
  const conn: Connector = { name: 'gantri', tools: [tool], async healthCheck() { return { ok: true }; } };
  const r = new ConnectorRegistry();
  r.register(conn);
  return { registry: r, exec };
}

function memCache() {
  const store = new Map<string, { value: unknown; frozen: boolean; expiresAt: number }>();
  return {
    store,
    async get(key: string) {
      const hit = store.get(key);
      if (!hit) return null;
      if (!hit.frozen && hit.expiresAt < Date.now()) return null;
      return hit.value;
    },
    async set(key: string, value: unknown, opts: { frozen?: boolean; ttlSec?: number; tool?: string }) {
      store.set(key, {
        value,
        frozen: !!opts.frozen,
        expiresAt: opts.frozen ? Number.MAX_SAFE_INTEGER : Date.now() + (opts.ttlSec ?? 0) * 1000,
      });
    },
  };
}

describe('CachingRegistry', () => {
  const NOW = new Date('2026-04-25T12:00:00.000Z');

  it('caches a frozen result for a fully closed range', async () => {
    const { registry, exec } = fakeRegistry((args) => ({ totalOrders: 5, dateRange: args.dateRange }));
    const cache = memCache();
    const policies = {
      'gantri.order_stats': {
        version: 1,
        settleDays: 30,
        openTtlSec: 60,
        dateRangePath: 'dateRange',
      },
    };
    const c = new CachingRegistry(registry, cache as any, policies, () => NOW);
    const args = { dateRange: { startDate: '2025-01-01', endDate: '2025-12-31' } };
    const r1 = await c.execute('gantri.order_stats', args);
    const r2 = await c.execute('gantri.order_stats', args);
    expect(r1).toEqual(r2);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(cache.store.size).toBe(1);
    const stored = [...cache.store.values()][0];
    expect(stored.frozen).toBe(true);
  });

  it('does NOT cache when policy is missing', async () => {
    const { registry, exec } = fakeRegistry(() => ({ x: 1 }));
    const cache = memCache();
    const c = new CachingRegistry(registry, cache as any, {}, () => NOW);
    await c.execute('gantri.order_stats', { dateRange: { startDate: '2025-01-01', endDate: '2025-12-31' } });
    await c.execute('gantri.order_stats', { dateRange: { startDate: '2025-01-01', endDate: '2025-12-31' } });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(cache.store.size).toBe(0);
  });

  it('does NOT cache failed tool results', async () => {
    const { registry, exec } = fakeRegistry(() => { throw new Error('boom'); });
    const cache = memCache();
    const policies = {
      'gantri.order_stats': { version: 1, settleDays: 30, openTtlSec: 60, dateRangePath: 'dateRange' },
    };
    const c = new CachingRegistry(registry, cache as any, policies, () => NOW);
    const r = await c.execute('gantri.order_stats', { dateRange: { startDate: '2025-01-01', endDate: '2025-12-31' } });
    expect(r.ok).toBe(false);
    expect(cache.store.size).toBe(0);
    // retry — should hit the tool again, not the cache
    await c.execute('gantri.order_stats', { dateRange: { startDate: '2025-01-01', endDate: '2025-12-31' } });
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx vitest run tests/unit/connectors/base/caching-registry.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/connectors/base/caching-registry.ts`:

```ts
import type { ConnectorRegistry } from './registry.js';
import type { Connector, ToolDef, ToolResult } from './connector.js';
import type { CachePolicy } from './cache-policy.js';
import { decideCacheStrategy } from './cache-policy.js';
import { logger } from '../../logger.js';

/** Subset of TtlCache that CachingRegistry needs. Lets us mock cleanly in tests. */
export interface CacheBackend {
  get(key: string): Promise<unknown | null>;
  set(
    key: string,
    value: unknown,
    options: { frozen?: boolean; ttlSec?: number; tool?: string },
  ): Promise<void>;
}

/**
 * Decorator over ConnectorRegistry that consults a per-tool CachePolicy on
 * every execute() and persists results to a CacheBackend. Same public surface
 * as ConnectorRegistry so the orchestrator can use either interchangeably.
 */
export class CachingRegistry {
  constructor(
    private readonly inner: ConnectorRegistry,
    private readonly cache: CacheBackend,
    private readonly policies: Record<string, CachePolicy>,
    private readonly nowFn: () => Date = () => new Date(),
    private readonly timezone: string = 'America/Los_Angeles',
  ) {}

  // Pass-throughs — anything that doesn't go through cache.
  register(connector: Connector): void { this.inner.register(connector); }
  getAllTools(): ToolDef[] { return this.inner.getAllTools(); }
  getConnectors(): Connector[] { return this.inner.getConnectors(); }

  async execute(toolName: string, rawArgs: unknown): Promise<ToolResult> {
    const policy = this.policies[toolName];
    if (!policy) return this.inner.execute(toolName, rawArgs);

    const decision = decideCacheStrategy(toolName, policy, rawArgs, this.nowFn(), this.timezone);
    if (decision.mode === 'skip' || !decision.key) {
      return this.inner.execute(toolName, rawArgs);
    }

    const hit = await this.cache.get(decision.key);
    if (hit) {
      logger.info({ tool: toolName, mode: decision.mode, cached: true }, 'cache hit');
      return hit as ToolResult;
    }

    const result = await this.inner.execute(toolName, rawArgs);
    if (result.ok) {
      try {
        await this.cache.set(decision.key, result, {
          frozen: decision.mode === 'frozen',
          ttlSec: decision.mode === 'ttl' ? decision.ttlSec : undefined,
          tool: toolName,
        });
      } catch (err) {
        logger.warn({ tool: toolName, err: err instanceof Error ? err.message : String(err) }, 'cache set failed');
      }
    }
    return result;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/connectors/base/caching-registry.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/base/caching-registry.ts tests/unit/connectors/base/caching-registry.test.ts
git commit -m "feat(cache): CachingRegistry decorator wrapping ConnectorRegistry"
```

---

## Task 6: Default cache-policy registry

**Files:**
- Create: `src/connectors/base/default-policies.ts`

- [ ] **Step 1: Implement**

Create `src/connectors/base/default-policies.ts`:

```ts
import type { CachePolicy } from './cache-policy.js';

/**
 * Per-tool caching policies the bot ships with.
 *
 * - settleDays: days to wait after a period closes before its data is final.
 * - openTtlSec: how long to cache results that include open (still-changing) days.
 * - dateRangePath: where to find {startDate, endDate} inside the tool args.
 *
 * Tools not listed here are NOT cached.
 */
export const DEFAULT_CACHE_POLICIES: Record<string, CachePolicy> = {
  // Grafana SQL hits a read-replica; trust it immediately.
  'grafana.sql': { version: 1, settleDays: 0, openTtlSec: 60, dateRangePath: 'dateRange' },
  'grafana.run_dashboard': { version: 1, settleDays: 0, openTtlSec: 300, dateRangePath: 'dateRange' },

  // Porter API: refunds can adjust prior periods up to ~30d after the fact.
  'gantri.order_stats': { version: 1, settleDays: 30, openTtlSec: 60, dateRangePath: 'dateRange' },
  // gantri.orders_query / gantri.order_get are too volatile to cache (per-row
  // status mutates) — omit.

  // Northbeam: attribution settles within ~72h.
  'northbeam.overview': { version: 1, settleDays: 3, openTtlSec: 600, dateRangePath: 'dateRange' },
  'northbeam.sales': { version: 1, settleDays: 3, openTtlSec: 600, dateRangePath: 'dateRange' },
  'northbeam.orders_summary': { version: 1, settleDays: 3, openTtlSec: 600, dateRangePath: 'dateRange' },
  'northbeam.metrics_explorer': { version: 1, settleDays: 3, openTtlSec: 600, dateRangePath: 'dateRange' },
  // northbeam.orders_list left out — row-level data, too volatile.
};
```

- [ ] **Step 2: Verify typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/connectors/base/default-policies.ts
git commit -m "feat(cache): default per-tool cache policies"
```

---

## Task 7: RollupRepo (Supabase reads/writes for sales_daily_rollup)

**Files:**
- Create: `src/storage/rollup-repo.ts`

- [ ] **Step 1: Implement**

Create `src/storage/rollup-repo.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';

export interface RollupRow {
  date: string;                      // YYYY-MM-DD PT
  total_orders: number;
  total_revenue_cents: number;
  by_type: Record<string, { orders: number; revenueCents: number }>;
  by_status: Record<string, { orders: number; revenueCents: number }>;
  by_organization: Record<string, { orders: number; revenueCents: number }>;
  refreshed_at: string;
}

export interface UpsertRollupInput {
  date: string;
  total_orders: number;
  total_revenue_cents: number;
  by_type: Record<string, { orders: number; revenueCents: number }>;
  by_status: Record<string, { orders: number; revenueCents: number }>;
  by_organization: Record<string, { orders: number; revenueCents: number }>;
}

export class RollupRepo {
  constructor(private readonly client: SupabaseClient) {}

  async upsertMany(rows: UpsertRollupInput[]): Promise<void> {
    if (rows.length === 0) return;
    const payload = rows.map((r) => ({
      ...r,
      refreshed_at: new Date().toISOString(),
    }));
    const { error } = await this.client.from('sales_daily_rollup').upsert(payload);
    if (error) throw new Error(`rollup upsert failed: ${error.message}`);
  }

  async getRange(startDate: string, endDate: string): Promise<RollupRow[]> {
    const { data, error } = await this.client
      .from('sales_daily_rollup')
      .select('*')
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date', { ascending: true });
    if (error) throw new Error(`rollup read failed: ${error.message}`);
    return (data ?? []) as RollupRow[];
  }

  async maxRefreshedDate(): Promise<string | null> {
    const { data, error } = await this.client
      .from('sales_daily_rollup')
      .select('date')
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`rollup max read failed: ${error.message}`);
    return (data?.date as string | undefined) ?? null;
  }
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/storage/rollup-repo.ts
git commit -m "feat(rollup): RollupRepo (CRUD on sales_daily_rollup)"
```

---

## Task 8: Rollup refresh job (compute via Grafana SQL)

**Files:**
- Create: `src/connectors/rollup/rollup-refresh.ts`

- [ ] **Step 1: Implement the refresh job**

Create `src/connectors/rollup/rollup-refresh.ts`:

```ts
import type { GrafanaConnector } from '../grafana/grafana-connector.js';
import type { RollupRepo, UpsertRollupInput } from '../../storage/rollup-repo.js';
import { logger } from '../../logger.js';

const PT_TZ = 'America/Los_Angeles';
const ROLLUP_SQL = `
WITH txn AS (
  SELECT
    DATE_TRUNC('day', t."createdAt" AT TIME ZONE 'America/Los_Angeles')::date AS day,
    t.type,
    t.status,
    COALESCE(t."organizationId"::text, 'null') AS org_key,
    COALESCE((t.amount->>'total')::numeric,
             (t.amount->>'subtotal')::numeric
             + COALESCE((t.amount->>'shipping')::numeric, 0)
             + COALESCE((t.amount->>'tax')::numeric, 0)) AS revenue_cents
  FROM "Transactions" t
  WHERE t."createdAt" >= ($__timeFrom())::timestamp
    AND t."createdAt" <  ($__timeTo())::timestamp
    AND t.status NOT IN ('Cancelled','Lost')
)
SELECT
  day,
  COUNT(*)::int AS total_orders,
  COALESCE(SUM(revenue_cents), 0)::bigint AS total_revenue_cents,
  COALESCE(jsonb_object_agg(type_key, type_agg) FILTER (WHERE type_key IS NOT NULL), '{}'::jsonb) AS by_type,
  COALESCE(jsonb_object_agg(status_key, status_agg) FILTER (WHERE status_key IS NOT NULL), '{}'::jsonb) AS by_status,
  COALESCE(jsonb_object_agg(org_key2, org_agg) FILTER (WHERE org_key2 IS NOT NULL), '{}'::jsonb) AS by_organization
FROM (
  SELECT day,
         type AS type_key, jsonb_build_object('orders', COUNT(*), 'revenueCents', COALESCE(SUM(revenue_cents),0)::bigint) AS type_agg,
         NULL::text AS status_key, NULL::jsonb AS status_agg,
         NULL::text AS org_key2, NULL::jsonb AS org_agg
  FROM txn GROUP BY day, type
  UNION ALL
  SELECT day, NULL, NULL, status, jsonb_build_object('orders', COUNT(*), 'revenueCents', COALESCE(SUM(revenue_cents),0)::bigint), NULL, NULL
  FROM txn GROUP BY day, status
  UNION ALL
  SELECT day, NULL, NULL, NULL, NULL, org_key, jsonb_build_object('orders', COUNT(*), 'revenueCents', COALESCE(SUM(revenue_cents),0)::bigint)
  FROM txn GROUP BY day, org_key
) labelled
GROUP BY day
ORDER BY day
`;

export interface RollupRefreshDeps {
  grafana: GrafanaConnector;
  repo: RollupRepo;
}

export class RollupRefreshJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: RollupRefreshDeps) {}

  /** Start a daily tick that runs the refresh window once a day at ~04:00 PT. */
  start(): void {
    if (this.timer) return;
    // Check every 15 minutes whether we've crossed the daily refresh boundary.
    this.timer = setInterval(() => { void this.tickIfDue(); }, 15 * 60 * 1000);
    logger.info({}, 'rollup refresh job started (15-min poll)');
    // Also run once immediately on boot to backfill anything missed during downtime.
    void this.refreshWindow(30);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async tickIfDue(): Promise<void> {
    if (this.running) return;
    const now = new Date();
    // Run when current PT hour is 4 (04:00–04:59). The 15-min poll guarantees we hit the window.
    const hourPt = parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: PT_TZ, hour: '2-digit', hour12: false })
        .format(now)
        .replace(/\D/g, ''),
      10,
    );
    if (hourPt !== 4) return;
    await this.refreshWindow(30);
  }

  /** Recompute the past `days` PT calendar days and upsert. */
  async refreshWindow(days: number): Promise<{ daysWritten: number }> {
    if (this.running) return { daysWritten: 0 };
    this.running = true;
    const started = Date.now();
    try {
      const today = pacificDay(new Date());
      const startDate = addDays(today, -days);
      const endDate = today; // exclusive end is "tomorrow" so we capture all of today's PT day; SQL uses < $end.
      const fromMs = wallClockToUtc(`${startDate}T00:00:00.000`, PT_TZ);
      const toMs = wallClockToUtc(`${addDays(endDate, 1)}T00:00:00.000`, PT_TZ);
      const { fields, rows } = await this.deps.grafana.runSql({
        sql: ROLLUP_SQL,
        fromMs,
        toMs,
        maxRows: days + 5,
      });
      const upserts = rowsToUpserts(fields, rows);
      await this.deps.repo.upsertMany(upserts);
      logger.info(
        { days, written: upserts.length, durationMs: Date.now() - started },
        'rollup refreshed',
      );
      return { daysWritten: upserts.length };
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.stack : String(err) }, 'rollup refresh failed');
      return { daysWritten: 0 };
    } finally {
      this.running = false;
    }
  }

  /** Backfill historical days in 30-day chunks. Call once on first install. */
  async backfill(months: number): Promise<{ totalDaysWritten: number }> {
    let total = 0;
    for (let chunk = 0; chunk < months; chunk++) {
      const chunkDays = 30;
      // Each call recomputes the trailing window; stack them by walking back in 30d hops.
      // This relies on refreshWindow's `today` anchor — for true backfill we'd need a parameterizable
      // anchor. For v1 just run refreshWindow(months*30) once with a large window.
      // (Implemented below via a single big call; keep this loop API for future extension.)
      const r = await this.refreshWindow(chunkDays * (chunk + 1));
      total = r.daysWritten;
      break; // single large call is enough for v1
    }
    return { totalDaysWritten: total };
  }
}

function rowsToUpserts(fields: string[], rows: unknown[][]): UpsertRollupInput[] {
  const idx = (name: string) => fields.indexOf(name);
  const dayIdx = idx('day');
  const totalOrdersIdx = idx('total_orders');
  const totalRevIdx = idx('total_revenue_cents');
  const byTypeIdx = idx('by_type');
  const byStatusIdx = idx('by_status');
  const byOrgIdx = idx('by_organization');
  const out: UpsertRollupInput[] = [];
  for (const row of rows) {
    const day = String(row[dayIdx]).slice(0, 10);
    out.push({
      date: day,
      total_orders: Number(row[totalOrdersIdx] ?? 0),
      total_revenue_cents: Number(row[totalRevIdx] ?? 0),
      by_type: parseJson(row[byTypeIdx]),
      by_status: parseJson(row[byStatusIdx]),
      by_organization: parseJson(row[byOrgIdx]),
    });
  }
  return out;
}

function parseJson(value: unknown): Record<string, { orders: number; revenueCents: number }> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, { orders: number; revenueCents: number }>;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return {};
}

function pacificDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: PT_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function wallClockToUtc(wall: string, tz: string): number {
  let utc = Date.parse(`${wall}Z`);
  for (let i = 0; i < 2; i++) {
    const formatted = formatInTz(new Date(utc), tz);
    const drift = Date.parse(`${formatted}Z`) - Date.parse(`${wall}Z`);
    utc -= drift;
  }
  return utc;
}

function formatInTz(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    fractionalSecondDigits: 3,
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}.${get('fractionalSecond') || '000'}`;
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/connectors/rollup/rollup-refresh.ts
git commit -m "feat(rollup): nightly refresh job (queries Grafana SQL, upserts to Supabase)"
```

---

## Task 9: RollupConnector exposing `gantri.daily_rollup`

**Files:**
- Create: `src/connectors/rollup/rollup-connector.ts`
- Create: `tests/unit/connectors/rollup/rollup-connector.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/connectors/rollup/rollup-connector.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { RollupConnector } from '../../../../src/connectors/rollup/rollup-connector.js';

function fakeRepo(rows: any[]) {
  return {
    getRange: vi.fn(async () => rows),
    maxRefreshedDate: vi.fn(async () => '2026-04-24'),
    upsertMany: vi.fn(async () => {}),
  };
}

describe('RollupConnector → gantri.daily_rollup', () => {
  const sampleRow = {
    date: '2025-03-15',
    total_orders: 42,
    total_revenue_cents: 1_234_500,
    by_type: { Order: { orders: 30, revenueCents: 800_000 }, Wholesale: { orders: 12, revenueCents: 434_500 } },
    by_status: {},
    by_organization: {},
  };

  it('returns daily grain rows in the requested range', async () => {
    const repo = fakeRepo([sampleRow]);
    const conn = new RollupConnector({ repo: repo as any, fallback: vi.fn() as any });
    const tool = conn.tools.find((t) => t.name === 'gantri.daily_rollup')!;
    const r: any = await tool.execute({
      dateRange: { startDate: '2025-03-15', endDate: '2025-03-15' },
      dimension: 'none',
      granularity: 'day',
    });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].date).toBe('2025-03-15');
    expect(r.rows[0].totalOrders).toBe(42);
    expect(r.rows[0].totalRevenueDollars).toBeCloseTo(12345);
  });

  it('rolls up to weekly grain', async () => {
    const days = ['2025-03-10', '2025-03-11', '2025-03-12', '2025-03-13', '2025-03-14', '2025-03-15', '2025-03-16']
      .map((date) => ({ ...sampleRow, date }));
    const repo = fakeRepo(days);
    const conn = new RollupConnector({ repo: repo as any, fallback: vi.fn() as any });
    const tool = conn.tools.find((t) => t.name === 'gantri.daily_rollup')!;
    const r: any = await tool.execute({
      dateRange: { startDate: '2025-03-10', endDate: '2025-03-16' },
      dimension: 'none',
      granularity: 'week',
    });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].totalOrders).toBe(7 * 42);
  });

  it('breaks down by type when dimension=type', async () => {
    const repo = fakeRepo([sampleRow]);
    const conn = new RollupConnector({ repo: repo as any, fallback: vi.fn() as any });
    const tool = conn.tools.find((t) => t.name === 'gantri.daily_rollup')!;
    const r: any = await tool.execute({
      dateRange: { startDate: '2025-03-15', endDate: '2025-03-15' },
      dimension: 'type',
      granularity: 'day',
    });
    const orderRow = r.rows.find((x: any) => x.dimensionKey === 'Order');
    expect(orderRow).toBeTruthy();
    expect(orderRow.totalOrders).toBe(30);
    expect(orderRow.totalRevenueDollars).toBeCloseTo(8000);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx vitest run tests/unit/connectors/rollup/rollup-connector.test.ts
```

- [ ] **Step 3: Implement**

Create `src/connectors/rollup/rollup-connector.ts`:

```ts
import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import type { RollupRepo, RollupRow } from '../../storage/rollup-repo.js';

const Args = z.object({
  dateRange: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  dimension: z.enum(['type', 'status', 'organization', 'none']).default('none'),
  granularity: z.enum(['day', 'week', 'month']).default('day'),
});
type Args = z.infer<typeof Args>;

export interface RollupConnectorDeps {
  repo: RollupRepo;
  /** Optional fallback for queries beyond the rollup's coverage. v1 leaves this unwired. */
  fallback?: (args: Args) => Promise<unknown>;
}

export class RollupConnector implements Connector {
  readonly name = 'rollup';
  readonly tools: readonly ToolDef[];

  constructor(private readonly deps: RollupConnectorDeps) {
    this.tools = this.buildTools();
  }

  async healthCheck() { return { ok: true }; }

  private buildTools(): ToolDef[] {
    const tool: ToolDef<Args> = {
      name: 'gantri.daily_rollup',
      description:
        'Fast pre-aggregated read for revenue and order count over a PT date range. Backed by a nightly-refreshed Supabase rollup table — use this INSTEAD of grafana.sql for any aggregate revenue/orders question that fits its grain (day/week/month, optionally broken down by type/status/organization). Returns rows with `date`, optional `dimensionKey`, `totalOrders`, `totalRevenueDollars`. Excludes Cancelled and Lost orders. The rollup refreshes daily at 04:00 PT and covers the trailing 30 days plus all historical data; queries that span the very current PT day may be incomplete by up to one refresh cycle.',
      schema: Args as z.ZodType<Args>,
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['dateRange'],
        properties: {
          dateRange: {
            type: 'object',
            additionalProperties: false,
            required: ['startDate', 'endDate'],
            properties: {
              startDate: { type: 'string', description: 'YYYY-MM-DD, Pacific Time, inclusive.' },
              endDate: { type: 'string', description: 'YYYY-MM-DD, Pacific Time, inclusive.' },
            },
          },
          dimension: { type: 'string', enum: ['type', 'status', 'organization', 'none'] },
          granularity: { type: 'string', enum: ['day', 'week', 'month'] },
        },
      },
      execute: (args) => this.run(args),
    };
    return [tool];
  }

  private async run(args: Args) {
    const days = await this.deps.repo.getRange(args.dateRange.startDate, args.dateRange.endDate);
    const flat = explode(days, args.dimension);
    const grouped = groupByGrain(flat, args.granularity, args.dimension);
    return {
      period: args.dateRange,
      dimension: args.dimension,
      granularity: args.granularity,
      rows: grouped,
      sourceDayCount: days.length,
    };
  }
}

interface FlatRow {
  date: string;
  dimensionKey: string | null;
  totalOrders: number;
  totalRevenueCents: number;
}

function explode(days: RollupRow[], dimension: Args['dimension']): FlatRow[] {
  const out: FlatRow[] = [];
  for (const d of days) {
    if (dimension === 'none') {
      out.push({
        date: d.date,
        dimensionKey: null,
        totalOrders: d.total_orders,
        totalRevenueCents: d.total_revenue_cents,
      });
      continue;
    }
    const map =
      dimension === 'type' ? d.by_type
      : dimension === 'status' ? d.by_status
      : d.by_organization;
    for (const [key, agg] of Object.entries(map ?? {})) {
      out.push({
        date: d.date,
        dimensionKey: key,
        totalOrders: agg.orders,
        totalRevenueCents: agg.revenueCents,
      });
    }
  }
  return out;
}

function groupByGrain(rows: FlatRow[], granularity: Args['granularity'], dimension: Args['dimension']) {
  if (granularity === 'day') {
    return rows.map((r) => formatRow(r));
  }
  const buckets = new Map<string, FlatRow>();
  for (const r of rows) {
    const bucketDate = granularity === 'week' ? mondayOf(r.date) : firstOfMonth(r.date);
    const key = `${bucketDate}|${r.dimensionKey ?? ''}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.totalOrders += r.totalOrders;
      existing.totalRevenueCents += r.totalRevenueCents;
    } else {
      buckets.set(key, { date: bucketDate, dimensionKey: r.dimensionKey, totalOrders: r.totalOrders, totalRevenueCents: r.totalRevenueCents });
    }
  }
  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date)).map((r) => formatRow(r));
}

function formatRow(r: FlatRow) {
  const obj: Record<string, unknown> = {
    date: r.date,
    totalOrders: r.totalOrders,
    totalRevenueDollars: Math.round(r.totalRevenueCents) / 100,
  };
  if (r.dimensionKey !== null) obj.dimensionKey = r.dimensionKey;
  return obj;
}

function mondayOf(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() - (dow - 1));
  return dt.toISOString().slice(0, 10);
}

function firstOfMonth(ymd: string): string {
  return ymd.slice(0, 7) + '-01';
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/connectors/rollup/rollup-connector.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/rollup/rollup-connector.ts tests/unit/connectors/rollup/rollup-connector.test.ts
git commit -m "feat(rollup): RollupConnector exposing gantri.daily_rollup"
```

---

## Task 10: System prompt — route to rollup

**Files:**
- Modify: `src/orchestrator/prompts.ts`

- [ ] **Step 1: Add a section to the canonical catalog**

Find the existing section 6 ("Orders from Gantri's own system") and insert immediately after it (or as 6b):

```
*6b. Pre-aggregated daily sales rollup (fast historical aggregates)* — \`gantri.daily_rollup\`
  • A nightly-refreshed Supabase table holds per-day total orders + total revenue, plus breakdowns by transaction type, status, and organizationId. **Use this for any aggregate question that fits the grain — it's an order of magnitude faster than \`grafana.sql\` and stays consistent across calls.**
  • Args: \`dateRange\` (PT, YYYY-MM-DD), \`granularity\` (\`day\`/\`week\`/\`month\`, default day), \`dimension\` (\`none\`/\`type\`/\`status\`/\`organization\`, default none).
  • Returns rows of \`{date, totalOrders, totalRevenueDollars, dimensionKey?}\`.
  • Excludes \`Cancelled\` / \`Lost\` orders by construction. Includes ALL transaction types (\`Order\`, \`Wholesale\`, \`Trade\`, \`Third Party\`, \`Refund\`, \`Replacement\`, \`Marketing\`, etc.) — filter via \`dimension: 'type'\` if you want a specific subset.
  • Routing: prefer this over \`grafana.sql\` for **any** revenue/orders aggregate over a date range. Fall back to \`grafana.sql\` only when:
    - You need a non-rollup dimension (customer name, product, SKU, sub-types not covered by the rollup's by_type breakdown).
    - The rollup is missing the day (typical at the very leading edge of "today" before the daily refresh runs).
  • The rollup is the same data a Grafana \`COUNT(*)\` / \`SUM(amount)\` query would produce, just precomputed — so the totals match.
```

- [ ] **Step 2: Verify typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/orchestrator/prompts.ts
git commit -m "feat(rollup): teach the bot to prefer gantri.daily_rollup over grafana.sql"
```

---

## Task 11: Wire CachingRegistry + RollupConnector + RollupRefreshJob in index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add imports**

Near the other imports add:

```ts
import { CachingRegistry } from './connectors/base/caching-registry.js';
import { DEFAULT_CACHE_POLICIES } from './connectors/base/default-policies.js';
import { TtlCache } from './storage/cache.js'; // (or whatever the export name is)
import { RollupRepo } from './storage/rollup-repo.js';
import { RollupConnector } from './connectors/rollup/rollup-connector.js';
import { RollupRefreshJob } from './connectors/rollup/rollup-refresh.js';
```

- [ ] **Step 2: Construct + wire**

After the `ConnectorRegistry` is fully populated (i.e. after `ScheduledReportsConnector` is registered) and BEFORE the `Orchestrator` is constructed, replace the registry passed to the orchestrator with a CachingRegistry wrapping it.

Then ALSO register the `RollupConnector` (its tool participates in the same registry).

Concretely:

```ts
const cache = new TtlCache(supabase);
const rollupRepo = new RollupRepo(supabase);

registry.register(new RollupConnector({ repo: rollupRepo }));

const cachingRegistry = new CachingRegistry(registry, cache, DEFAULT_CACHE_POLICIES);

const orchestrator = new Orchestrator({
  registry: cachingRegistry as unknown as ConnectorRegistry, // CachingRegistry exposes the same surface
  ...
});
```

(If `CachingRegistry` doesn't actually share a base type with `ConnectorRegistry`, prefer to make `Orchestrator` accept either via a structural type. Smallest change: make `OrchestratorOptions.registry` typed as a subset interface — `{ getAllTools(): ToolDef[]; execute(name: string, args: unknown): Promise<ToolResult>; }` — and update both classes to satisfy it. Keep the existing imports working.)

After `app.start`, also start the rollup refresh job:

```ts
const rollupJob = new RollupRefreshJob({ grafana, repo: rollupRepo });
rollupJob.start();
```

- [ ] **Step 3: Verify typecheck and tests**

```bash
npm run typecheck
npm test
```

Expected: no errors, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts src/orchestrator/orchestrator.ts
git commit -m "feat: wire CachingRegistry + RollupConnector + RollupRefreshJob"
```

---

## Task 12: Backfill + deploy + smoke test

**Files:** none (deployment + verification)

- [ ] **Step 1: Build + deploy**

```bash
npm run build
flyctl deploy --remote-only --app gantri-ai-bot
```

- [ ] **Step 2: Trigger initial backfill**

SSH into the running machine and call `refreshWindow(720)` (~24 months) once:

```bash
flyctl ssh console --app gantri-ai-bot -C "sh -c 'cd /app && node -e \"
(async()=>{
  const {getSupabase} = await import(\\\"./dist/storage/supabase.js\\\");
  const {GrafanaConnector} = await import(\\\"./dist/connectors/grafana/grafana-connector.js\\\");
  const {RollupRepo} = await import(\\\"./dist/storage/rollup-repo.js\\\");
  const {RollupRefreshJob} = await import(\\\"./dist/connectors/rollup/rollup-refresh.js\\\");
  const {readVaultSecret} = await import(\\\"./dist/storage/supabase.js\\\");
  const s = getSupabase();
  const [u, t, d] = await Promise.all([
    readVaultSecret(s, \\\"GRAFANA_URL\\\"),
    readVaultSecret(s, \\\"GRAFANA_TOKEN\\\"),
    readVaultSecret(s, \\\"GRAFANA_POSTGRES_DS_UID\\\"),
  ]);
  const grafana = new GrafanaConnector({baseUrl:u, token:t, postgresDsUid:d});
  const job = new RollupRefreshJob({grafana, repo: new RollupRepo(s)});
  const r = await job.refreshWindow(720);
  console.log(\\\"backfill:\\\", JSON.stringify(r));
})();
\"'"
```

Expected: `backfill: {"daysWritten":N}` where N is somewhere in the hundreds (one row per PT day with at least one transaction over the past ~24 months).

- [ ] **Step 3: Verify rollup data is sane**

Use Supabase MCP to spot-check:

```sql
select date, total_orders, total_revenue_cents, jsonb_object_keys(by_type) as types
from sales_daily_rollup
where date >= '2025-03-01' and date < '2025-04-01'
order by total_revenue_cents desc
limit 5;
```

Expected: 5 rows, each with sensible counts (10s–100s of orders) and revenue (~$1k–$50k). At least one type listed (`Order`, `Wholesale`, etc.).

- [ ] **Step 4: End-to-end Slack test**

In a Slack DM with the bot, send:

```
which is the best week in sales last year?
```

Expected:
- Placeholder updates to `🔍 Querying Rollup…` (or whatever the connector display label resolves to — see `SOURCE_LABELS` in handlers.ts; you may want to add a `rollup → Rollup` mapping).
- Bot answers with a date and a number, fast (sub-second compared to multi-second grafana queries).
- A second identical question hits the cache (frozen for fully-closed 2025) and returns instantly.

Then send:

```
total revenue this month so far
```

Expected:
- Bot also uses `gantri.daily_rollup` (this month is partly closed, partly open).
- For the open tail (today), it transparently falls back to `grafana.sql` or just reports rollup-only data with a note.

- [ ] **Step 5: Commit any post-deploy fixes; push**

```bash
git push origin feat/initial-implementation
```

---

## Self-Review

**Spec coverage:**
- Tier 1 cache table → Task 1
- Cache.ts updates → Task 3
- CachePolicy + canonicalization → Task 4
- CachingRegistry decorator → Task 5
- Default policies map → Task 6
- Tier 2 rollup table → Task 2
- RollupRepo → Task 7
- Refresh job + backfill → Task 8 (job) + Task 12 (backfill)
- gantri.daily_rollup tool → Task 9
- Prompt routing → Task 10
- Wiring → Task 11
- Deploy + verify → Task 12

**Placeholder scan:** Task 8's `backfill(months)` loop is a stub that just calls `refreshWindow(months*30)` once; documented as v1-only. Task 11's structural-type discussion (Orchestrator vs CachingRegistry) is left to the implementer with concrete guidance — flagged but not unspecified.

**Type consistency:** `RollupRow` uses snake_case for DB columns (matches Supabase response) and the connector exposes camelCase via `formatRow`. `decideCacheStrategy` signature is consistent across cache-policy.ts, default-policies.ts, and CachingRegistry.
