# Pipedrive Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Pipedrive connector exposing 11 tools (`pipedrive.list_directory`, `pipedrive.search`, `pipedrive.deal_timeseries`, `pipedrive.pipeline_snapshot`, `pipedrive.list_deals`, `pipedrive.deal_detail`, `pipedrive.organization_performance`, `pipedrive.organization_detail`, `pipedrive.lost_reasons_breakdown`, `pipedrive.activity_summary`, `pipedrive.user_performance`) for Gantri's B2B trade / wholesale CRM analytics.

**Architecture:** A `PipedriveApiClient` wraps Pipedrive's mixed v1 + v2 REST API (auth via `Authorization: api_token=<token>` header), with a 10-min in-memory cache for directory lookups (pipelines, stages, users, dealFields) and a generic `paginate<T>()` helper capped at 10 pages. A `PipedriveConnector` defines 11 tools that call the client, all using the shared `DateRangeArg` from `src/connectors/base/date-range.ts`, registered in `src/index.ts`, whitelisted for Live Reports, with output samples in `tool-output-shapes.ts`. No rollup table, no nightly job — every tool serves live.

**Tech Stack:** TypeScript, Zod, Vitest, Pipedrive REST API (v1 + v2), Supabase vault for `PIPEDRIVE_API_TOKEN`.

---

## File structure

| Type | Path | Responsibility |
|---|---|---|
| New | `src/connectors/pipedrive/client.ts` | HTTP client + 10-min directory cache + `paginate<T>()` helper + `PipedriveApiError` + typed responses |
| New | `src/connectors/pipedrive/connector.ts` | `PipedriveConnector` class, 11 tool definitions, custom-field hash → name resolver |
| New | `tests/unit/connectors/pipedrive/client.test.ts` | Auth, cache, pagination cap, retry, response parsing |
| New | `tests/unit/connectors/pipedrive/connector.test.ts` | All 11 tools with stubbed client, preset-string `dateRange`, edge cases |
| Modify | `src/index.ts` | Read `PIPEDRIVE_API_TOKEN` from vault, instantiate connector conditionally, register |
| Modify | `src/reports/live/spec.ts` | Add 11 tool names to `WHITELISTED_TOOLS` |
| Modify | `src/connectors/live-reports/tool-output-shapes.ts` | Add 11 sample outputs with `expectedTopLevelKeys` + `expectedArrayElementKeys` |
| Modify | `src/orchestrator/prompts.ts` | New `*5e. Pipedrive CRM` section with all 11 tool docs |
| Modify | `tests/unit/connectors/base/date-range-invariant.test.ts` | Import the new pipedrive module + add `PipedriveConnector` instance |

---

## Task 1: Vault + env wiring (no instantiation)

**Files:**
- Modify: `src/index.ts` — extend the vault `Promise.all` block to read `PIPEDRIVE_API_TOKEN`

- [ ] **Step 1: Read the existing vault block to confirm exact location**

Run: `grep -n "KLAVIYO_API_KEY\|GSC_OAUTH_REFRESH_TOKEN" /Users/danierestevez/Documents/work/gantri/gantri-ai-bot/src/index.ts`
Expected: matches around lines 59 (destructure) and 77/80 (the `readVaultSecret` calls inside the `Promise.all`).

- [ ] **Step 2: Add `pipedriveApiToken` to the destructured tuple**

In `src/index.ts`, find the existing line that destructures Klaviyo:
```ts
    klaviyoApiKey,
    gscOauthClientId, gscOauthClientSecret, gscOauthRefreshToken,
  ] = await Promise.all([
```

Change to:
```ts
    klaviyoApiKey,
    gscOauthClientId, gscOauthClientSecret, gscOauthRefreshToken,
    pipedriveApiToken,
  ] = await Promise.all([
```

- [ ] **Step 3: Add the `readVaultSecret` call**

Find the existing `readVaultSecret(supabase, 'GSC_OAUTH_REFRESH_TOKEN').catch(() => null),` line. Add after it:
```ts
    readVaultSecret(supabase, 'PIPEDRIVE_API_TOKEN').catch(() => null),
```

- [ ] **Step 4: Reference the var so the build doesn't fail with "declared but never used"**

Add right before the existing `const claude = new Anthropic(...)` line (around line 178):
```ts
  // Pipedrive connector wired in Task 13 — for now just touch the var so the
  // declaration above passes noUnusedLocals.
  void pipedriveApiToken;
```

- [ ] **Step 5: Typecheck + build**

Run: `npx tsc --noEmit`
Expected: PASS (no errors).

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat(pipedrive): read PIPEDRIVE_API_TOKEN from vault"
```

---

## Task 2: Client base — auth, paginate, error class, retry

**Files:**
- Create: `src/connectors/pipedrive/client.ts`
- Create: `tests/unit/connectors/pipedrive/client.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/connectors/pipedrive/client.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { PipedriveApiClient, PipedriveApiError } from '../../../../src/connectors/pipedrive/client.js';

describe('PipedriveApiClient core', () => {
  it('attaches Authorization: api_token=<token> header on every request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }),
    );
    const client = new PipedriveApiClient({ apiToken: 'tok_abc', fetchImpl });
    await client.listPipelines();
    const [, opts] = fetchImpl.mock.calls[0];
    expect(opts.headers.Authorization).toBe('api_token=tok_abc');
    expect(opts.headers.Accept).toBe('application/json');
  });

  it('does NOT put api_token in the URL query string (avoids token leakage to logs)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }),
    );
    const client = new PipedriveApiClient({ apiToken: 'tok_abc', fetchImpl });
    await client.listPipelines();
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).not.toMatch(/api_token=/);
  });

  it('throws PipedriveApiError on 4xx with status + body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 }),
    );
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    await expect(client.listPipelines()).rejects.toBeInstanceOf(PipedriveApiError);
    try { await client.listPipelines(); } catch (e) {
      expect((e as PipedriveApiError).status).toBe(401);
      expect((e as PipedriveApiError).body).toEqual({ success: false, error: 'Unauthorized' });
    }
  });

  it('retries once on 429 then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{ id: 1 }] }), { status: 200 }));
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl, retryDelayMs: 1 });
    const out = await client.listPipelines();
    expect(out).toEqual([{ id: 1 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries once on 5xx then throws if still failing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 503 }));
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl, retryDelayMs: 1 });
    await expect(client.listPipelines()).rejects.toBeInstanceOf(PipedriveApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it('paginate<T>() respects maxPages cap', async () => {
    let page = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      page += 1;
      return new Response(JSON.stringify({
        success: true,
        data: [{ id: page }],
        additional_data: { pagination: { more_items_in_collection: true, next_start: page * 100 } },
      }), { status: 200 });
    });
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    // listUsers uses paginate internally with maxPages=10 by default; force a small cap to assert.
    const result = await (client as unknown as { paginateForTest: (path: string, query: Record<string, string>, maxPages: number) => Promise<{ items: unknown[]; hasMore: boolean }> })
      .paginateForTest('/v1/users', {}, 3);
    expect(result.items.length).toBe(3);
    expect(result.hasMore).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/connectors/pipedrive/client.test.ts`
Expected: FAIL with "Cannot find module '../../../../src/connectors/pipedrive/client.js'".

- [ ] **Step 3: Create the directory + file**

Run: `mkdir -p /Users/danierestevez/Documents/work/gantri/gantri-ai-bot/src/connectors/pipedrive /Users/danierestevez/Documents/work/gantri/gantri-ai-bot/tests/unit/connectors/pipedrive`

Create `src/connectors/pipedrive/client.ts`:
```ts
import { logger } from '../../logger.js';

/**
 * Read-only client for Pipedrive's REST API. Uses a mix of v1 (aggregations,
 * metadata, search, activities) and v2 (entity reads) endpoints. Auth via
 * `Authorization: api_token=<token>` header — NEVER the `?api_token=` query
 * param, which leaks into request logs.
 *
 * Rate limits: token-budget based (~30K daily × seats). Each endpoint has a
 * token cost (timeline = 40 units). A 10-min in-memory cache for directory
 * lookups (pipelines, stages, users, dealFields) keeps us comfortably under
 * the budget for a single Live-Report refresh storm.
 */

export interface PipedriveApiConfig {
  /** Admin API token — read-only access is sufficient. */
  apiToken: string;
  /** Default `https://api.pipedrive.com`. */
  baseUrl?: string;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Backoff between the failed attempt and the single retry. Default 1000ms. */
  retryDelayMs?: number;
}

export class PipedriveApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'PipedriveApiError';
  }
}

/** v1 "additional_data.pagination" shape — offset-based. */
interface V1Pagination {
  start: number;
  limit: number;
  more_items_in_collection: boolean;
  next_start?: number;
}

interface V1Response<T> {
  success: boolean;
  data: T[] | null;
  additional_data?: { pagination?: V1Pagination };
}

/** v2 "additional_data.next_cursor" shape — cursor-based. */
interface V2Response<T> {
  success: boolean;
  data: T[] | null;
  additional_data?: { next_cursor?: string | null };
}

const DEFAULT_MAX_PAGES = 10;

export class PipedriveApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;
  /** Directory-only TTL cache. NOT used for aggregations / lists / details. */
  private readonly directoryCache = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly directoryTtlMs = 10 * 60 * 1000;

  constructor(private readonly cfg: PipedriveApiConfig) {
    this.baseUrl = cfg.baseUrl ?? 'https://api.pipedrive.com';
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.retryDelayMs = cfg.retryDelayMs ?? 1000;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `api_token=${this.cfg.apiToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }

  /** Single-attempt GET that throws on 4xx/5xx. The retry wrapper lives
   *  inside `request()`. */
  private async fetchOnce(url: string): Promise<Response> {
    return this.fetchImpl(url, { method: 'GET', headers: this.headers() });
  }

  /** GET with one retry on 429/5xx. `path` starts with `/`. */
  private async request<T>(path: string, query: Record<string, string | undefined> = {}): Promise<T> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') params.set(k, v);
    }
    const qs = params.toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
    const t0 = Date.now();
    let res = await this.fetchOnce(url);
    if (res.status === 429 || res.status >= 500) {
      logger.warn({ path, status: res.status }, 'pipedrive transient error — retrying once');
      await new Promise((r) => setTimeout(r, this.retryDelayMs));
      res = await this.fetchOnce(url);
    }
    const elapsed = Date.now() - t0;
    if (!res.ok) {
      let body: unknown = null;
      try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
      logger.warn({ path, status: res.status, elapsed, body }, 'pipedrive api error');
      throw new PipedriveApiError(`GET ${path} -> ${res.status}`, res.status, body);
    }
    const data = await res.json();
    logger.info({ path, status: res.status, elapsed }, 'pipedrive api ok');
    return data as T;
  }

  /** v1 offset-pagination walk. Caps at `maxPages`. Returns `{ items, hasMore }`
   *  so callers can flag truncation in tool output. */
  async paginateV1<T>(path: string, query: Record<string, string | undefined> = {}, maxPages = DEFAULT_MAX_PAGES): Promise<{ items: T[]; hasMore: boolean }> {
    const limit = '500';
    const out: T[] = [];
    let start = 0;
    let pages = 0;
    let hasMore = false;
    while (pages < maxPages) {
      const resp = await this.request<V1Response<T>>(path, { ...query, start: String(start), limit });
      const batch = resp.data ?? [];
      out.push(...batch);
      pages += 1;
      const pag = resp.additional_data?.pagination;
      if (!pag || !pag.more_items_in_collection) { hasMore = false; break; }
      hasMore = true;
      start = pag.next_start ?? start + Number(limit);
    }
    return { items: out, hasMore: pages >= maxPages && hasMore };
  }

  /** v2 cursor-pagination walk. Same return shape. */
  async paginateV2<T>(path: string, query: Record<string, string | undefined> = {}, maxPages = DEFAULT_MAX_PAGES): Promise<{ items: T[]; hasMore: boolean }> {
    const out: T[] = [];
    let cursor: string | null | undefined = undefined;
    let pages = 0;
    let hasMore = false;
    while (pages < maxPages) {
      const q: Record<string, string | undefined> = { ...query, limit: '500' };
      if (cursor) q.cursor = cursor;
      const resp = await this.request<V2Response<T>>(path, q);
      const batch = resp.data ?? [];
      out.push(...batch);
      pages += 1;
      cursor = resp.additional_data?.next_cursor;
      if (!cursor) { hasMore = false; break; }
      hasMore = true;
    }
    return { items: out, hasMore: pages >= maxPages && hasMore };
  }

  /** Test hook so we can exercise pagination caps directly. */
  async paginateForTest(path: string, query: Record<string, string>, maxPages: number): Promise<{ items: unknown[]; hasMore: boolean }> {
    return this.paginateV1<unknown>(path, query, maxPages);
  }

  // ---- Directory (cached 10 min) ---- //
  /** Stub used by tests; real implementations land in Task 3. */
  async listPipelines(): Promise<unknown[]> {
    const resp = await this.request<V1Response<unknown>>('/v1/pipelines');
    return resp.data ?? [];
  }

  /** Cached read-through helper. */
  protected async cacheGet<T>(key: string, factory: () => Promise<T>): Promise<T> {
    const hit = this.directoryCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value as T;
    const value = await factory();
    this.directoryCache.set(key, { value, expiresAt: Date.now() + this.directoryTtlMs });
    return value;
  }
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run tests/unit/connectors/pipedrive/client.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/connectors/pipedrive/client.ts tests/unit/connectors/pipedrive/client.test.ts
git commit -m "feat(pipedrive): client base — auth, paginate, retry, error class"
```

---

## Task 3: Client directory methods + 10-min cache

**Files:**
- Modify: `src/connectors/pipedrive/client.ts`
- Modify: `tests/unit/connectors/pipedrive/client.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `tests/unit/connectors/pipedrive/client.test.ts`:
```ts
describe('PipedriveApiClient directory + 10-min cache', () => {
  it('listPipelines roundtrips and caches across calls', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: [{ id: 1, name: 'Trade' }] }), { status: 200 }),
    );
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const a = await client.listPipelines();
    const b = await client.listPipelines();
    expect(a).toEqual([{ id: 1, name: 'Trade' }]);
    expect(b).toEqual(a);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // cached
  });

  it('listStages, listUsers, listDealFields each roundtrip independently', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/v1/stages')) return new Response(JSON.stringify({ success: true, data: [{ id: 11, name: 'Discovery', pipeline_id: 3 }] }), { status: 200 });
      if (url.includes('/v1/users')) return new Response(JSON.stringify({ success: true, data: [{ id: 7, name: 'Lana' }] }), { status: 200 });
      if (url.includes('/v1/dealFields')) return new Response(JSON.stringify({ success: true, data: [{ key: 'abc', name: 'Source' }] }), { status: 200 });
      return new Response('nope', { status: 404 });
    });
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    expect(await client.listStages()).toEqual([{ id: 11, name: 'Discovery', pipeline_id: 3 }]);
    expect(await client.listUsers()).toEqual([{ id: 7, name: 'Lana' }]);
    expect(await client.listDealFields()).toEqual([{ key: 'abc', name: 'Source' }]);
  });

  it('cache TTL expires (forced via clock injection)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: [{ id: 1 }] }), { status: 200 }),
    );
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    await client.listPipelines();
    now.mockReturnValue(1_000_000 + 11 * 60 * 1000); // +11 min — past TTL
    await client.listPipelines();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/connectors/pipedrive/client.test.ts -t "directory"`
Expected: FAIL — `listStages`, `listUsers`, `listDealFields` not defined; `listPipelines` does NOT cache yet.

- [ ] **Step 3: Implement the directory methods + caching**

Replace the stub `listPipelines()` and add the new methods. In `src/connectors/pipedrive/client.ts`, replace the body of `listPipelines` and add the rest below:
```ts
  /** TS shapes — only the fields tools actually surface. */
  // (place these interfaces near the top of the file, below the existing V1/V2 response types)
```

Add these interfaces near the top of the file (after `V2Response`):
```ts
export interface Pipeline { id: number; name: string; active: boolean; order_nr?: number; deal_probability?: number }
export interface Stage { id: number; name: string; pipeline_id: number; order_nr: number; active_flag?: boolean }
export interface User { id: number; name: string; email: string; active_flag: boolean; is_admin?: number }
export interface DealField { key: string; name: string; field_type: string; options?: Array<{ id: number | string; label: string }> }
```

Replace the stub `listPipelines()` and add the rest of the directory methods:
```ts
  // ---- Directory (cached 10 min) ---- //
  async listPipelines(): Promise<Pipeline[]> {
    return this.cacheGet('pipelines', async () => {
      const resp = await this.request<V1Response<Pipeline>>('/v1/pipelines');
      return resp.data ?? [];
    });
  }

  async listStages(): Promise<Stage[]> {
    return this.cacheGet('stages', async () => {
      const resp = await this.request<V1Response<Stage>>('/v1/stages');
      return resp.data ?? [];
    });
  }

  async listUsers(): Promise<User[]> {
    return this.cacheGet('users', async () => {
      const resp = await this.request<V1Response<User>>('/v1/users');
      return resp.data ?? [];
    });
  }

  async listDealFields(): Promise<DealField[]> {
    return this.cacheGet('dealFields', async () => {
      const resp = await this.request<V1Response<DealField>>('/v1/dealFields');
      return resp.data ?? [];
    });
  }
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run tests/unit/connectors/pipedrive/client.test.ts`
Expected: PASS (8 tests now).

- [ ] **Step 5: Commit**

```bash
git add src/connectors/pipedrive/client.ts tests/unit/connectors/pipedrive/client.test.ts
git commit -m "feat(pipedrive): directory methods + 10-min cache"
```

---

## Task 4: Client aggregation — dealsTimeline + dealsSummary

**Files:**
- Modify: `src/connectors/pipedrive/client.ts`
- Modify: `tests/unit/connectors/pipedrive/client.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `tests/unit/connectors/pipedrive/client.test.ts`:
```ts
describe('PipedriveApiClient aggregations', () => {
  it('dealsTimeline parses totals.{count, values, weighted_values, open_count, open_values, won_count, won_values}', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        period_start: '2026-01-01',
        period_count: 3,
        period_units: 'month',
        totals: {
          count: 30,
          values: { USD: 150000 },
          weighted_values: { USD: 75000 },
          open_count: 10, open_values: { USD: 50000 },
          won_count: 18, won_values: { USD: 90000 },
        },
        data: [
          { period_start: '2026-01-01', period_end: '2026-01-31', totals: {
            count: 12, values: { USD: 60000 }, weighted_values: { USD: 30000 },
            open_count: 4, open_values: { USD: 20000 },
            won_count: 7, won_values: { USD: 35000 },
          }, deals: [] },
          { period_start: '2026-02-01', period_end: '2026-02-28', totals: {
            count: 9, values: { USD: 45000 }, weighted_values: { USD: 22000 },
            open_count: 3, open_values: { USD: 15000 },
            won_count: 5, won_values: { USD: 25000 },
          }, deals: [] },
        ],
      },
    }), { status: 200 }));
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const out = await client.dealsTimeline({
      startDate: '2026-01-01', amount: 3, interval: 'month', fieldKey: 'won_time',
    });
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({
      period_start: '2026-01-01',
      count: 12,
      total_value_usd: 60000,
      weighted_value_usd: 30000,
      open_count: 4, open_value_usd: 20000,
      won_count: 7, won_value_usd: 35000,
    });
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/v1/deals/timeline');
    expect(String(url)).toContain('field_key=won_time');
    expect(String(url)).toContain('interval=month');
  });

  it('dealsSummary parses totals.{count, value, weighted_value} into flat shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        total_count: 157,
        total_currency_converted_value: 2481089,
        total_weighted_currency_converted_value: 1240500,
        values_total: { USD: { value: 2481089, count: 157, value_converted: 2481089 } },
      },
    }), { status: 200 }));
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const out = await client.dealsSummary({ status: 'open' });
    expect(out).toMatchObject({ count: 157, total_value_usd: 2481089, weighted_value_usd: 1240500 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/connectors/pipedrive/client.test.ts -t "aggregations"`
Expected: FAIL — `dealsTimeline` and `dealsSummary` not defined.

- [ ] **Step 3: Implement the aggregation methods**

Add to `src/connectors/pipedrive/client.ts`:
```ts
export interface TimelineBucket {
  period_start: string;
  period_end: string;
  count: number;
  total_value_usd: number;
  weighted_value_usd: number;
  open_count: number;
  open_value_usd: number;
  won_count: number;
  won_value_usd: number;
}

export interface DealsSummary {
  count: number;
  total_value_usd: number;
  weighted_value_usd: number;
}

interface RawTimelineTotals {
  count: number;
  values?: { USD?: number };
  weighted_values?: { USD?: number };
  open_count?: number;
  open_values?: { USD?: number };
  won_count?: number;
  won_values?: { USD?: number };
}

interface RawTimelinePeriod {
  period_start: string;
  period_end: string;
  totals: RawTimelineTotals;
}

export interface DealsTimelineOpts {
  startDate: string;        // YYYY-MM-DD
  amount: number;           // # of intervals
  interval: 'day' | 'week' | 'month' | 'quarter';
  fieldKey: 'add_time' | 'won_time' | 'close_time' | 'expected_close_date';
  pipelineId?: number;
  userId?: number;
  stageId?: number;
}

  // ---- Aggregation (NOT cached) ---- //
  async dealsTimeline(opts: DealsTimelineOpts): Promise<TimelineBucket[]> {
    const query: Record<string, string | undefined> = {
      start_date: opts.startDate,
      amount: String(opts.amount),
      interval: opts.interval,
      field_key: opts.fieldKey,
      pipeline_id: opts.pipelineId !== undefined ? String(opts.pipelineId) : undefined,
      user_id: opts.userId !== undefined ? String(opts.userId) : undefined,
      stage_id: opts.stageId !== undefined ? String(opts.stageId) : undefined,
      totals_convert_currency: 'USD',
    };
    const resp = await this.request<V1Response<RawTimelinePeriod> & { data: { data: RawTimelinePeriod[] } }>('/v1/deals/timeline', query);
    // /v1/deals/timeline returns data: { totals, data: [periods] } not data: [...]
    const periods = (resp.data as unknown as { data?: RawTimelinePeriod[] })?.data ?? [];
    return periods.map((p) => ({
      period_start: p.period_start,
      period_end: p.period_end,
      count: p.totals.count ?? 0,
      total_value_usd: p.totals.values?.USD ?? 0,
      weighted_value_usd: p.totals.weighted_values?.USD ?? 0,
      open_count: p.totals.open_count ?? 0,
      open_value_usd: p.totals.open_values?.USD ?? 0,
      won_count: p.totals.won_count ?? 0,
      won_value_usd: p.totals.won_values?.USD ?? 0,
    }));
  }

  async dealsSummary(opts: { status?: 'open' | 'won' | 'lost' | 'all_not_deleted'; pipelineId?: number; userId?: number }): Promise<DealsSummary> {
    const query: Record<string, string | undefined> = {
      status: opts.status,
      pipeline_id: opts.pipelineId !== undefined ? String(opts.pipelineId) : undefined,
      user_id: opts.userId !== undefined ? String(opts.userId) : undefined,
      totals_convert_currency: 'USD',
    };
    const resp = await this.request<{ success: boolean; data: { total_count: number; total_currency_converted_value: number; total_weighted_currency_converted_value: number } }>('/v1/deals/summary', query);
    return {
      count: resp.data?.total_count ?? 0,
      total_value_usd: resp.data?.total_currency_converted_value ?? 0,
      weighted_value_usd: resp.data?.total_weighted_currency_converted_value ?? 0,
    };
  }
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run tests/unit/connectors/pipedrive/client.test.ts -t "aggregations"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/connectors/pipedrive/client.ts tests/unit/connectors/pipedrive/client.test.ts
git commit -m "feat(pipedrive): dealsTimeline + dealsSummary aggregations"
```

---

## Task 5: Client list methods — deals, orgs, persons, activities

**Files:**
- Modify: `src/connectors/pipedrive/client.ts`
- Modify: `tests/unit/connectors/pipedrive/client.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `tests/unit/connectors/pipedrive/client.test.ts`:
```ts
describe('PipedriveApiClient list endpoints', () => {
  it('listDeals uses v2 cursor pagination + passes filters', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: [{ id: 816, title: 'KBM-Hogue', value: 24500, currency: 'USD', status: 'open', stage_id: 11, pipeline_id: 3, owner_id: { id: 7, name: 'Lana' }, person_id: { value: 12, name: 'Tasha' }, org_id: { value: 5, name: 'KBM-Hogue' }, add_time: '2026-04-01T00:00:00Z', custom_fields: {} }],
      additional_data: { next_cursor: null },
    }), { status: 200 }));
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const out = await client.listDeals({ status: 'open', pipelineId: 3, limit: 100 });
    expect(out.items.length).toBe(1);
    expect(out.hasMore).toBe(false);
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/v2/deals');
    expect(String(url)).toContain('status=open');
    expect(String(url)).toContain('pipeline_id=3');
  });

  it('listOrganizations uses v2 cursor pagination', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true, data: [{ id: 5, name: 'KBM-Hogue' }], additional_data: { next_cursor: null },
    }), { status: 200 }));
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const out = await client.listOrganizations({ ids: [5] });
    expect(out.items.length).toBe(1);
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/v2/organizations');
  });

  it('listPersons uses v2 cursor pagination', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true, data: [{ id: 12, name: 'Tasha' }], additional_data: { next_cursor: null },
    }), { status: 200 }));
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const out = await client.listPersons({});
    expect(out.items.length).toBe(1);
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/v2/persons');
  });

  it('listActivities uses v1 offset pagination + passes filters', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true, data: [{ id: 100, type: 'call', subject: 'Discovery call', user_id: 7, done: 1, due_date: '2026-04-15' }],
      additional_data: { pagination: { start: 0, limit: 500, more_items_in_collection: false } },
    }), { status: 200 }));
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const out = await client.listActivities({ startDate: '2026-04-01', endDate: '2026-04-30', userId: 7, type: 'call', done: 1 });
    expect(out.items.length).toBe(1);
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/v1/activities');
    expect(String(url)).toContain('user_id=7');
    expect(String(url)).toContain('type=call');
    expect(String(url)).toContain('done=1');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/connectors/pipedrive/client.test.ts -t "list endpoints"`
Expected: FAIL — `listDeals`, `listOrganizations`, `listPersons`, `listActivities` not defined.

- [ ] **Step 3: Implement the list methods**

Add to `src/connectors/pipedrive/client.ts`:
```ts
export interface Deal {
  id: number;
  title: string;
  value: number;
  currency: string;
  status: 'open' | 'won' | 'lost' | 'deleted';
  stage_id: number;
  pipeline_id: number;
  owner_id: number | { id: number; name: string };
  person_id: number | { value: number; name: string } | null;
  org_id: number | { value: number; name: string } | null;
  add_time?: string;
  update_time?: string;
  won_time?: string | null;
  lost_time?: string | null;
  close_time?: string | null;
  lost_reason?: string | null;
  expected_close_date?: string | null;
  custom_fields?: Record<string, unknown>;
}

export interface Organization {
  id: number;
  name: string;
  address?: string | null;
  web?: string | null;
  owner_id?: number | { id: number; name: string };
  add_time?: string;
}

export interface Person {
  id: number;
  name: string;
  emails?: Array<{ value: string; primary?: boolean }>;
  phones?: Array<{ value: string; primary?: boolean }>;
  org_id?: number | { value: number; name: string } | null;
}

export interface Activity {
  id: number;
  type: string;
  subject: string;
  user_id: number;
  done: 0 | 1;
  due_date?: string;
  add_time?: string;
  marked_as_done_time?: string;
  deal_id?: number | null;
  org_id?: number | null;
  person_id?: number | null;
}

export interface ListDealsOpts {
  status?: 'open' | 'won' | 'lost' | 'deleted' | 'all_not_deleted';
  pipelineId?: number;
  stageId?: number;
  ownerId?: number;
  orgId?: number;
  personId?: number;
  startDate?: string; // for filter_id-less window via since
  endDate?: string;
  sortBy?: 'value' | 'add_time' | 'update_time' | 'won_time';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
}

  async listDeals(opts: ListDealsOpts): Promise<{ items: Deal[]; hasMore: boolean }> {
    const query: Record<string, string | undefined> = {
      status: opts.status,
      pipeline_id: opts.pipelineId !== undefined ? String(opts.pipelineId) : undefined,
      stage_id: opts.stageId !== undefined ? String(opts.stageId) : undefined,
      owner_id: opts.ownerId !== undefined ? String(opts.ownerId) : undefined,
      org_id: opts.orgId !== undefined ? String(opts.orgId) : undefined,
      person_id: opts.personId !== undefined ? String(opts.personId) : undefined,
      sort_by: opts.sortBy,
      sort_direction: opts.sortOrder,
      // window via update_time / won_time happens in the connector (client-side filter);
      // v2 has no clean range filter on add_time today.
    };
    return this.paginateV2<Deal>('/v2/deals', query, 10);
  }

  async listOrganizations(opts: { ids?: number[]; ownerId?: number; }): Promise<{ items: Organization[]; hasMore: boolean }> {
    const query: Record<string, string | undefined> = {
      ids: opts.ids?.length ? opts.ids.join(',') : undefined,
      owner_id: opts.ownerId !== undefined ? String(opts.ownerId) : undefined,
    };
    return this.paginateV2<Organization>('/v2/organizations', query, 10);
  }

  async listPersons(opts: { ownerId?: number; orgId?: number }): Promise<{ items: Person[]; hasMore: boolean }> {
    const query: Record<string, string | undefined> = {
      owner_id: opts.ownerId !== undefined ? String(opts.ownerId) : undefined,
      org_id: opts.orgId !== undefined ? String(opts.orgId) : undefined,
    };
    return this.paginateV2<Person>('/v2/persons', query, 10);
  }

  async listActivities(opts: { startDate?: string; endDate?: string; userId?: number; type?: string; done?: 0 | 1 }): Promise<{ items: Activity[]; hasMore: boolean }> {
    const query: Record<string, string | undefined> = {
      start_date: opts.startDate,
      end_date: opts.endDate,
      user_id: opts.userId !== undefined ? String(opts.userId) : undefined,
      type: opts.type,
      done: opts.done !== undefined ? String(opts.done) : undefined,
    };
    return this.paginateV1<Activity>('/v1/activities', query, 10);
  }
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run tests/unit/connectors/pipedrive/client.test.ts -t "list endpoints"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/connectors/pipedrive/client.ts tests/unit/connectors/pipedrive/client.test.ts
git commit -m "feat(pipedrive): listDeals/orgs/persons/activities"
```

---

## Task 6: Client detail + search

**Files:**
- Modify: `src/connectors/pipedrive/client.ts`
- Modify: `tests/unit/connectors/pipedrive/client.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `tests/unit/connectors/pipedrive/client.test.ts`:
```ts
describe('PipedriveApiClient detail + search', () => {
  it('getDeal hits /v2/deals/{id}', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true, data: { id: 816, title: 'KBM-Hogue', value: 24500, currency: 'USD' },
    }), { status: 200 }));
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const out = await client.getDeal(816);
    expect(out.id).toBe(816);
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/v2/deals/816');
  });

  it('getOrganization hits /v2/organizations/{id}', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true, data: { id: 5, name: 'KBM-Hogue', address: '1 Main St', web: 'kbm.com' },
    }), { status: 200 }));
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const out = await client.getOrganization(5);
    expect(out.name).toBe('KBM-Hogue');
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/v2/organizations/5');
  });

  it('itemSearch hits /v1/itemSearch with query + entity filter', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        items: [
          { result_score: 0.92, item: { type: 'deal', id: 816, title: 'KBM-Hogue', value: 24500 } },
          { result_score: 0.71, item: { type: 'organization', id: 5, name: 'KBM-Hogue' } },
        ],
      },
    }), { status: 200 }));
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const out = await client.itemSearch({ term: 'KBM', itemTypes: ['deal', 'organization'], limit: 10 });
    expect(out.length).toBe(2);
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/v1/itemSearch');
    expect(String(url)).toContain('term=KBM');
    expect(String(url)).toContain('item_types=deal%2Corganization');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/connectors/pipedrive/client.test.ts -t "detail"`
Expected: FAIL — `getDeal`, `getOrganization`, `itemSearch` not defined.

- [ ] **Step 3: Implement the detail + search methods**

Add to `src/connectors/pipedrive/client.ts`:
```ts
export interface SearchHit {
  type: 'deal' | 'organization' | 'person';
  id: number;
  title: string;
  summary: string;
  score: number;
}

  async getDeal(id: number): Promise<Deal> {
    const resp = await this.request<{ success: boolean; data: Deal }>(`/v2/deals/${id}`);
    return resp.data;
  }

  async getOrganization(id: number): Promise<Organization> {
    const resp = await this.request<{ success: boolean; data: Organization }>(`/v2/organizations/${id}`);
    return resp.data;
  }

  async itemSearch(opts: { term: string; itemTypes?: Array<'deal' | 'organization' | 'person'>; limit?: number }): Promise<SearchHit[]> {
    const query: Record<string, string | undefined> = {
      term: opts.term,
      item_types: opts.itemTypes?.join(','),
      limit: opts.limit !== undefined ? String(opts.limit) : '10',
    };
    const resp = await this.request<{ success: boolean; data: { items: Array<{ result_score: number; item: { type: string; id: number; title?: string; name?: string; value?: number } }> } }>('/v1/itemSearch', query);
    const items = resp.data?.items ?? [];
    return items.map((h) => ({
      type: h.item.type as SearchHit['type'],
      id: h.item.id,
      title: h.item.title ?? h.item.name ?? '(unnamed)',
      summary: h.item.value !== undefined ? `value=${h.item.value}` : '',
      score: h.result_score,
    }));
  }
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run tests/unit/connectors/pipedrive/client.test.ts`
Expected: PASS (all client tests).

- [ ] **Step 5: Commit**

```bash
git add src/connectors/pipedrive/client.ts tests/unit/connectors/pipedrive/client.test.ts
git commit -m "feat(pipedrive): getDeal/getOrganization/itemSearch"
```

---

## Task 7: Connector skeleton + custom-field resolver

**Files:**
- Create: `src/connectors/pipedrive/connector.ts`
- Create: `tests/unit/connectors/pipedrive/connector.test.ts`

- [ ] **Step 1: Write the failing test for the custom-field resolver**

Create `tests/unit/connectors/pipedrive/connector.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { PipedriveConnector } from '../../../../src/connectors/pipedrive/connector.js';
import type { PipedriveApiClient, DealField } from '../../../../src/connectors/pipedrive/client.js';

function makeStub(over: Partial<Record<keyof PipedriveApiClient, unknown>> = {}): PipedriveApiClient {
  return {
    listPipelines: vi.fn().mockResolvedValue([]),
    listStages: vi.fn().mockResolvedValue([]),
    listUsers: vi.fn().mockResolvedValue([]),
    listDealFields: vi.fn().mockResolvedValue([]),
    dealsTimeline: vi.fn().mockResolvedValue([]),
    dealsSummary: vi.fn().mockResolvedValue({ count: 0, total_value_usd: 0, weighted_value_usd: 0 }),
    listDeals: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    listOrganizations: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    listPersons: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    listActivities: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    getDeal: vi.fn(),
    getOrganization: vi.fn(),
    itemSearch: vi.fn().mockResolvedValue([]),
    ...over,
  } as unknown as PipedriveApiClient;
}

describe('PipedriveConnector — skeleton', () => {
  it('exposes name "pipedrive" and tools array', () => {
    const conn = new PipedriveConnector({ client: makeStub() });
    expect(conn.name).toBe('pipedrive');
    expect(Array.isArray(conn.tools)).toBe(true);
  });

  it('resolveCustomFieldName maps a hash to the human name from listDealFields', async () => {
    const fields: DealField[] = [
      { key: '9539ba1ce1e5a79d39a30359e5c3e5b7a95ac082', name: 'Specifier', field_type: 'enum', options: [] },
      { key: '1f25ac373967eb662bc1128e1312a6cde5543fe2', name: 'Purchaser', field_type: 'enum', options: [] },
      { key: 'f21bb44b8b693a780b3e881a258257db8897b6d0', name: 'Source', field_type: 'enum', options: [{ id: 161, label: 'ICFF' }, { id: 162, label: 'Design Miami' }] },
    ];
    const stub = makeStub({ listDealFields: vi.fn().mockResolvedValue(fields) });
    const conn = new PipedriveConnector({ client: stub });
    const map = await conn.resolveCustomFieldNames();
    expect(map.get('9539ba1ce1e5a79d39a30359e5c3e5b7a95ac082')).toBe('Specifier');
    expect(map.get('f21bb44b8b693a780b3e881a258257db8897b6d0')).toBe('Source');
  });

  it('healthCheck pings listPipelines and reports ok with count', async () => {
    const stub = makeStub({ listPipelines: vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]) });
    const conn = new PipedriveConnector({ client: stub });
    const h = await conn.healthCheck();
    expect(h.ok).toBe(true);
    expect(h.detail).toMatch(/2 pipelines/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/connectors/pipedrive/connector.test.ts`
Expected: FAIL — Cannot find module connector.

- [ ] **Step 3: Create the connector skeleton**

Create `src/connectors/pipedrive/connector.ts`:
```ts
import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import { DateRangeArg, normalizeDateRange } from '../base/date-range.js';
import { logger } from '../../logger.js';
import {
  PipedriveApiClient,
  PipedriveApiError,
  type DealField,
  type Deal,
} from './client.js';

/**
 * Pipedrive CRM connector — read-only. 11 tools cover Gantri's full B2B
 * trade / wholesale CRM analytics surface (open pipeline value, deal
 * timeseries, top firms, lost-reason breakdown, rep leaderboards, activity
 * volume).
 *
 * Currency hard-coded to USD (Gantri's Pipedrive is single-currency). All
 * date-range tools use the shared `DateRangeArg` from `base/date-range.ts`
 * and call `normalizeDateRange()` before any logic. Pagination is capped
 * at 10 pages = ~5000 records — analytics tools that hit the cap return
 * `truncated: true` so the LLM can flag partial results.
 */

export interface PipedriveConnectorDeps {
  client: PipedriveApiClient;
}

export class PipedriveConnector implements Connector {
  readonly name = 'pipedrive';
  readonly tools: readonly ToolDef[];
  private readonly client: PipedriveApiClient;

  constructor(deps: PipedriveConnectorDeps) {
    this.client = deps.client;
    this.tools = this.buildTools();
  }

  async healthCheck() {
    try {
      const pipelines = await this.client.listPipelines();
      return { ok: true, detail: `${pipelines.length} pipelines` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Build a hash → human-name lookup from the dealFields catalog. The 3
   *  user-visible custom fields (Specifier/Purchaser/Source) live by hash;
   *  this resolver lets tools surface them by name without hard-coding hashes. */
  async resolveCustomFieldNames(): Promise<Map<string, string>> {
    const fields = await this.client.listDealFields();
    const map = new Map<string, string>();
    for (const f of fields) {
      // Hashed custom-field keys are 40-char hex; standard fields use short
      // names like 'value', 'title'. Only include hashed (custom) ones so
      // resolution can't accidentally rename a standard field.
      if (/^[a-f0-9]{40}$/.test(f.key)) map.set(f.key, f.name);
    }
    return map;
  }

  /** Resolve enum option ids inside a custom_fields blob.
   *  Example: input { f21bb44b...: 161 } → { Source: "ICFF" } */
  async resolveCustomFieldValues(deal: Deal): Promise<Record<string, unknown>> {
    const fields = await this.client.listDealFields();
    const out: Record<string, unknown> = {};
    const cf = deal.custom_fields ?? {};
    for (const f of fields) {
      if (!/^[a-f0-9]{40}$/.test(f.key)) continue;
      const raw = cf[f.key];
      if (raw === undefined || raw === null || raw === '') continue;
      if (Array.isArray(f.options) && f.options.length > 0) {
        const hit = f.options.find((o) => String(o.id) === String(raw));
        out[f.name] = hit?.label ?? raw;
      } else {
        out[f.name] = raw;
      }
    }
    return out;
  }

  private buildTools(): readonly ToolDef[] {
    // Tool definitions added in Tasks 8-12.
    return [];
  }
}

// Helper: registry-shaped error wrapper used by every tool.
export function pipedriveErrorResult(err: unknown) {
  if (err instanceof PipedriveApiError) {
    return { ok: false, error: { code: 'PIPEDRIVE_API_ERROR', status: err.status, message: err.message, body: err.body } };
  }
  const message = err instanceof Error ? err.message : String(err);
  logger.warn({ err: message }, 'pipedrive tool internal error');
  return { ok: false, error: { code: 'PIPEDRIVE_INTERNAL_ERROR', message } };
}

// Re-exported so tools defined in later tasks share schema utilities cleanly.
export { DateRangeArg, normalizeDateRange, z, zodToJsonSchema };
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run tests/unit/connectors/pipedrive/connector.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/connectors/pipedrive/connector.ts tests/unit/connectors/pipedrive/connector.test.ts
git commit -m "feat(pipedrive): connector skeleton + custom-field resolvers"
```

---

## Task 8: Tools group A — Discovery (`list_directory` + `search`)

**Files:**
- Modify: `src/connectors/pipedrive/connector.ts`
- Modify: `tests/unit/connectors/pipedrive/connector.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/connectors/pipedrive/connector.test.ts`:
```ts
describe('pipedrive.list_directory', () => {
  it('kind="pipelines" returns id/name/active rows', async () => {
    const stub = makeStub({ listPipelines: vi.fn().mockResolvedValue([
      { id: 1, name: 'Collection Trade & Wholesale', active: true },
      { id: 3, name: 'Wholesale (physical)', active: true },
    ]) });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.list_directory')!;
    const r = await tool.execute({ kind: 'pipelines' }) as any;
    expect(r.ok).toBe(true);
    expect(r.data.rows).toEqual([
      { id: 1, name: 'Collection Trade & Wholesale', active: true },
      { id: 3, name: 'Wholesale (physical)', active: true },
    ]);
  });

  it('kind="stages" decorates each stage with pipeline_name', async () => {
    const stub = makeStub({
      listPipelines: vi.fn().mockResolvedValue([{ id: 3, name: 'Wholesale (physical)', active: true }]),
      listStages: vi.fn().mockResolvedValue([
        { id: 11, name: 'Discovery', pipeline_id: 3, order_nr: 1 },
        { id: 12, name: 'Sample', pipeline_id: 3, order_nr: 2 },
      ]),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.list_directory')!;
    const r = await tool.execute({ kind: 'stages' }) as any;
    expect(r.ok).toBe(true);
    expect(r.data.rows[0]).toMatchObject({ id: 11, pipeline_id: 3, pipeline_name: 'Wholesale (physical)', name: 'Discovery', order_nr: 1 });
  });

  it('kind="users" returns only active users by default', async () => {
    const stub = makeStub({ listUsers: vi.fn().mockResolvedValue([
      { id: 1, name: 'Lana', email: 'lana@gantri.com', active_flag: true, is_admin: 1 },
      { id: 2, name: 'OldRep', email: 'old@gantri.com', active_flag: false },
    ]) });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.list_directory')!;
    const r = await tool.execute({ kind: 'users' }) as any;
    expect(r.data.rows.length).toBe(1);
    expect(r.data.rows[0].name).toBe('Lana');
  });

  it('kind="deal_fields" returns only user-visible custom fields', async () => {
    const stub = makeStub({ listDealFields: vi.fn().mockResolvedValue([
      { key: 'value', name: 'Value', field_type: 'monetary' }, // standard, excluded
      { key: '9539ba1ce1e5a79d39a30359e5c3e5b7a95ac082', name: 'Specifier', field_type: 'enum' },
    ]) });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.list_directory')!;
    const r = await tool.execute({ kind: 'deal_fields' }) as any;
    expect(r.data.rows.length).toBe(1);
    expect(r.data.rows[0].name).toBe('Specifier');
  });

  it('kind="source_options" dereferences the Source enum', async () => {
    const stub = makeStub({ listDealFields: vi.fn().mockResolvedValue([
      { key: 'f21bb44b8b693a780b3e881a258257db8897b6d0', name: 'Source', field_type: 'enum', options: [{ id: 161, label: 'ICFF' }, { id: 162, label: 'Design Miami' }] },
    ]) });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.list_directory')!;
    const r = await tool.execute({ kind: 'source_options' }) as any;
    expect(r.data.rows).toEqual([{ id: 161, label: 'ICFF' }, { id: 162, label: 'Design Miami' }]);
  });
});

describe('pipedrive.search', () => {
  it('passes query + entity filter to itemSearch', async () => {
    const stub = makeStub({ itemSearch: vi.fn().mockResolvedValue([
      { type: 'deal', id: 816, title: 'KBM-Hogue', summary: 'value=24500', score: 0.92 },
    ]) });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.search')!;
    const r = await tool.execute({ query: 'KBM', entity: 'deals', limit: 10 }) as any;
    expect(r.ok).toBe(true);
    expect(r.data.rows[0]).toMatchObject({ type: 'deal', id: 816, name: 'KBM-Hogue' });
    expect((stub.itemSearch as any)).toHaveBeenCalledWith(expect.objectContaining({ term: 'KBM', itemTypes: ['deal'], limit: 10 }));
  });

  it('entity="all" passes itemTypes=undefined (search across all types)', async () => {
    const stub = makeStub({ itemSearch: vi.fn().mockResolvedValue([]) });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.search')!;
    await tool.execute({ query: 'foo', entity: 'all', limit: 10 });
    const callArgs = (stub.itemSearch as any).mock.calls[0][0];
    expect(callArgs.itemTypes).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/connectors/pipedrive/connector.test.ts -t "list_directory|search"`
Expected: FAIL — tools not registered yet.

- [ ] **Step 3: Implement the two tools**

Replace `private buildTools(): readonly ToolDef[] { return []; }` in `src/connectors/pipedrive/connector.ts` with:
```ts
  private buildTools(): readonly ToolDef[] {
    return [
      this.toolListDirectory(),
      this.toolSearch(),
    ];
  }

  // ============================================================
  // Group A — Discovery / lookup
  // ============================================================

  private toolListDirectory(): ToolDef {
    const Args = z.object({
      kind: z.enum(['pipelines', 'stages', 'users', 'deal_fields', 'source_options']).describe(
        'Which directory to fetch. The LLM should call this BEFORE any tool that filters by id/name.',
      ),
    });
    type A = z.infer<typeof Args>;
    return {
      name: 'pipedrive.list_directory',
      description: [
        'Returns the small static directories the LLM needs to map names → ids before calling other Pipedrive tools (pipelines/stages/users/deal_fields/source_options). Cached 10 min server-side.',
        'For "stages": each row carries `pipeline_id` AND `pipeline_name` so you can disambiguate cross-pipeline stages with the same label (Pipeline 1 and Pipeline 2 both have a stage called "Opportunity").',
        'For "deal_fields": only user-visible CUSTOM fields are returned (Specifier, Purchaser, Source). Standard fields (value/title/etc) are excluded.',
        'For "source_options": the dereferenced Source enum (ICFF, Design Miami, Neocon, …) so you can pass `sourceOptionId` to other tools.',
      ].join(' '),
      schema: Args as z.ZodType<A>,
      jsonSchema: zodToJsonSchema(Args),
      execute: async (rawArgs) => {
        const args = rawArgs as A;
        try {
          if (args.kind === 'pipelines') {
            const items = await this.client.listPipelines();
            return { ok: true, data: { kind: 'pipelines', rows: items.map((p) => ({ id: p.id, name: p.name, active: !!p.active })) } };
          }
          if (args.kind === 'stages') {
            const [stages, pipelines] = await Promise.all([this.client.listStages(), this.client.listPipelines()]);
            const nameById = new Map(pipelines.map((p) => [p.id, p.name] as const));
            return { ok: true, data: { kind: 'stages', rows: stages.map((s) => ({ id: s.id, pipeline_id: s.pipeline_id, pipeline_name: nameById.get(s.pipeline_id) ?? null, name: s.name, order_nr: s.order_nr })) } };
          }
          if (args.kind === 'users') {
            const users = await this.client.listUsers();
            return { ok: true, data: { kind: 'users', rows: users.filter((u) => u.active_flag).map((u) => ({ id: u.id, name: u.name, email: u.email, active: u.active_flag, is_admin: !!u.is_admin })) } };
          }
          if (args.kind === 'deal_fields') {
            const fields = await this.client.listDealFields();
            const customs = fields.filter((f) => /^[a-f0-9]{40}$/.test(f.key));
            return { ok: true, data: { kind: 'deal_fields', rows: customs.map((f) => ({ key: f.key, name: f.name, type: f.field_type, options: f.options ?? null })) } };
          }
          // source_options
          const fields = await this.client.listDealFields();
          const source = fields.find((f) => f.name === 'Source');
          return { ok: true, data: { kind: 'source_options', rows: source?.options ?? [] } };
        } catch (err) { return pipedriveErrorResult(err); }
      },
    };
  }

  private toolSearch(): ToolDef {
    const Args = z.object({
      query: z.string().min(1).describe('Substring or fuzzy search term — Pipedrive\'s native /v1/itemSearch.'),
      entity: z.enum(['all', 'deals', 'persons', 'organizations']).default('all').describe(
        'Restrict results to one entity type. "all" searches across deals + persons + orgs.',
      ),
      limit: z.number().int().min(1).max(100).default(10),
    });
    type A = z.infer<typeof Args>;
    return {
      name: 'pipedrive.search',
      description: [
        'Fuzzy substring search across Pipedrive deals, persons, and organizations via /v1/itemSearch. Returns minimal records with id, type, name, and a short summary.',
        'Use this to RESOLVE a name a user mentioned ("KBM-Hogue", "Bilotti", "Wirecutter") into the numeric id you need for `deal_detail`, `organization_detail`, etc. Optional `entity` to restrict the search.',
      ].join(' '),
      schema: Args as z.ZodType<A>,
      jsonSchema: zodToJsonSchema(Args),
      execute: async (rawArgs) => {
        const args = rawArgs as A;
        try {
          const itemTypes = args.entity === 'all' ? undefined :
            args.entity === 'deals' ? ['deal'] as const :
            args.entity === 'organizations' ? ['organization'] as const :
            ['person'] as const;
          const hits = await this.client.itemSearch({ term: args.query, itemTypes: itemTypes ? [...itemTypes] : undefined, limit: args.limit });
          return { ok: true, data: { query: args.query, count: hits.length, rows: hits.map((h) => ({ type: h.type, id: h.id, name: h.title, summary: h.summary, score: h.score })) } };
        } catch (err) { return pipedriveErrorResult(err); }
      },
    };
  }
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run tests/unit/connectors/pipedrive/connector.test.ts`
Expected: PASS (all connector tests so far).

- [ ] **Step 5: Commit**

```bash
git add src/connectors/pipedrive/connector.ts tests/unit/connectors/pipedrive/connector.test.ts
git commit -m "feat(pipedrive): tools list_directory + search"
```

---

## Task 9: Tools group B — `deal_timeseries` + `pipeline_snapshot`

**Files:**
- Modify: `src/connectors/pipedrive/connector.ts`
- Modify: `tests/unit/connectors/pipedrive/connector.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/connectors/pipedrive/connector.test.ts`:
```ts
describe('pipedrive.deal_timeseries', () => {
  it('returns rows with key/count/totalValueUsd/wonValueUsd/openValueUsd/weighted', async () => {
    const stub = makeStub({
      dealsTimeline: vi.fn().mockResolvedValue([
        { period_start: '2026-01-01', period_end: '2026-01-31', count: 12, total_value_usd: 60000, weighted_value_usd: 30000, open_count: 4, open_value_usd: 20000, won_count: 7, won_value_usd: 35000 },
        { period_start: '2026-02-01', period_end: '2026-02-28', count: 9, total_value_usd: 45000, weighted_value_usd: 22000, open_count: 3, open_value_usd: 15000, won_count: 5, won_value_usd: 25000 },
      ]),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.deal_timeseries')!;
    const r = await tool.execute({ dateRange: { startDate: '2026-01-01', endDate: '2026-02-28' }, granularity: 'month', dateField: 'won_time' }) as any;
    expect(r.period).toEqual({ startDate: '2026-01-01', endDate: '2026-02-28' });
    expect(r.granularity).toBe('month');
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ key: '2026-01-01', count: 12, totalValueUsd: 60000, wonCount: 7, wonValueUsd: 35000, openCount: 4, openValueUsd: 20000, weightedValueUsd: 30000 });
  });

  it('accepts dateRange as a preset string', async () => {
    const stub = makeStub({ dealsTimeline: vi.fn().mockResolvedValue([]) });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.deal_timeseries')!;
    const out = await tool.execute({ dateRange: 'last_30_days', granularity: 'month', dateField: 'won_time' }) as any;
    expect(out.rows).toEqual([]);
    expect(out.period.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('accepts JSON-stringified-object dateRange (defense-in-depth — registry preprocess)', async () => {
    const stub = makeStub({ dealsTimeline: vi.fn().mockResolvedValue([]) });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.deal_timeseries')!;
    // The registry's preprocess handles this for execute() in real code; the
    // tool itself should at least accept the post-parse object form.
    await expect(tool.execute({ dateRange: { startDate: '2026-01-01', endDate: '2026-01-31' }, granularity: 'month', dateField: 'won_time' })).resolves.toBeDefined();
  });
});

describe('pipedrive.pipeline_snapshot', () => {
  it('groups paginated /v2/deals client-side by stage_id with names from listStages', async () => {
    const stub = makeStub({
      listStages: vi.fn().mockResolvedValue([
        { id: 11, name: 'Discovery', pipeline_id: 3, order_nr: 1 },
        { id: 12, name: 'Sample', pipeline_id: 3, order_nr: 2 },
      ]),
      listPipelines: vi.fn().mockResolvedValue([{ id: 3, name: 'Wholesale (physical)', active: true }]),
      listDeals: vi.fn().mockResolvedValue({ items: [
        { id: 1, title: 'A', value: 1000, currency: 'USD', status: 'open', stage_id: 11, pipeline_id: 3, owner_id: 7, person_id: null, org_id: null },
        { id: 2, title: 'B', value: 2500, currency: 'USD', status: 'open', stage_id: 11, pipeline_id: 3, owner_id: 7, person_id: null, org_id: null },
        { id: 3, title: 'C', value: 5000, currency: 'USD', status: 'open', stage_id: 12, pipeline_id: 3, owner_id: 7, person_id: null, org_id: null },
      ], hasMore: false }),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.pipeline_snapshot')!;
    const r = await tool.execute({ pipelineId: 3, status: 'open' }) as any;
    expect(r.ok).toBe(true);
    expect(r.data.rows).toEqual([
      { stageId: 11, stageName: 'Discovery', pipelineId: 3, pipelineName: 'Wholesale (physical)', count: 2, totalValueUsd: 3500 },
      { stageId: 12, stageName: 'Sample', pipelineId: 3, pipelineName: 'Wholesale (physical)', count: 1, totalValueUsd: 5000 },
    ]);
    expect(r.data.truncated).toBe(false);
  });

  it('flags truncated:true when listDeals.hasMore=true', async () => {
    const stub = makeStub({
      listStages: vi.fn().mockResolvedValue([{ id: 11, name: 'Discovery', pipeline_id: 3, order_nr: 1 }]),
      listPipelines: vi.fn().mockResolvedValue([{ id: 3, name: 'X', active: true }]),
      listDeals: vi.fn().mockResolvedValue({ items: [{ id: 1, title: 'A', value: 100, currency: 'USD', status: 'open', stage_id: 11, pipeline_id: 3, owner_id: 7, person_id: null, org_id: null }], hasMore: true }),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.pipeline_snapshot')!;
    const r = await tool.execute({ pipelineId: 3, status: 'open' }) as any;
    expect(r.data.truncated).toBe(true);
    expect(r.data.note).toMatch(/truncated|partial|cap/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/connectors/pipedrive/connector.test.ts -t "deal_timeseries|pipeline_snapshot"`
Expected: FAIL.

- [ ] **Step 3: Implement the two tools**

In `src/connectors/pipedrive/connector.ts`, extend `buildTools()`:
```ts
  private buildTools(): readonly ToolDef[] {
    return [
      this.toolListDirectory(),
      this.toolSearch(),
      this.toolDealTimeseries(),
      this.toolPipelineSnapshot(),
    ];
  }
```

Then add both methods after `toolSearch()`:
```ts
  // ============================================================
  // Group B — Server-aggregated time-series
  // ============================================================

  private toolDealTimeseries(): ToolDef {
    const Args = z.object({
      dateRange: DateRangeArg,
      granularity: z.enum(['day', 'week', 'month', 'quarter']).default('month').describe('Bucket size — passed straight to /v1/deals/timeline `interval`.'),
      dateField: z.enum(['add_time', 'won_time', 'close_time', 'expected_close_date']).default('won_time').describe('Which timestamp anchors each deal to a bucket. Default `won_time` (revenue recognition view).'),
      pipelineId: z.number().int().optional(),
      ownerId: z.number().int().optional(),
      stageId: z.number().int().optional(),
      sourceOptionId: z.number().int().optional().describe('Filter by Source enum option id (use `pipedrive.list_directory` kind="source_options" to discover).'),
    });
    type A = z.infer<typeof Args>;
    return {
      name: 'pipedrive.deal_timeseries',
      description: [
        'Per-bucket counts and total/won/open value over a date range, server-aggregated by Pipedrive\'s /v1/deals/timeline. Filterable by pipeline, owner, stage, and Source enum option.',
        'Output rows: { key, count, totalValueUsd, wonCount, wonValueUsd, openCount, openValueUsd, weightedValueUsd }. `key` = period_start (YYYY-MM-DD). All amounts USD.',
        'Use for "monthly won-deal value YTD", "deals created per week in Q1", "ICFF leads converted by month".',
      ].join(' '),
      schema: Args as z.ZodType<A>,
      jsonSchema: zodToJsonSchema(Args),
      execute: async (rawArgs) => {
        const args = rawArgs as A;
        try {
          const { startDate, endDate } = normalizeDateRange(args.dateRange);
          // Compute # of buckets between start and end for the chosen granularity.
          const amount = bucketsBetween(startDate, endDate, args.granularity);
          const buckets = await this.client.dealsTimeline({
            startDate, amount, interval: args.granularity, fieldKey: args.dateField,
            pipelineId: args.pipelineId, userId: args.ownerId, stageId: args.stageId,
          });
          // sourceOptionId is not natively supported by /v1/deals/timeline as
          // a query param — so we surface it as a known limitation in the
          // note rather than silently ignore it.
          const sourceNote = args.sourceOptionId !== undefined
            ? `sourceOptionId filter not honored by /v1/deals/timeline; use pipedrive.list_deals + group client-side instead.`
            : null;
          return {
            period: { startDate, endDate },
            granularity: args.granularity,
            rows: buckets.map((b) => ({
              key: b.period_start,
              count: b.count,
              totalValueUsd: b.total_value_usd,
              wonCount: b.won_count,
              wonValueUsd: b.won_value_usd,
              openCount: b.open_count,
              openValueUsd: b.open_value_usd,
              weightedValueUsd: b.weighted_value_usd,
            })),
            note: sourceNote ?? undefined,
          };
        } catch (err) { return pipedriveErrorResult(err); }
      },
    };
  }

  private toolPipelineSnapshot(): ToolDef {
    const Args = z.object({
      pipelineId: z.number().int().optional().describe('Restrict to one pipeline. Omit to aggregate all pipelines.'),
      ownerId: z.number().int().optional(),
      status: z.enum(['open', 'won', 'lost', 'all']).default('open'),
    });
    type A = z.infer<typeof Args>;
    return {
      name: 'pipedrive.pipeline_snapshot',
      description: [
        'Point-in-time stage funnel: count + total value per stage in a pipeline (or all 4 pipelines). Hits /v2/deals filtered by status, then groups client-side by stage_id.',
        'Output rows: { stageId, stageName, pipelineId, pipelineName, count, totalValueUsd } — sorted by pipelineId then stage order_nr (so the funnel reads top-to-bottom).',
        'Returns `truncated: true` if the underlying scan hit the 10-page (~5000 deal) cap. Use for "open deals by stage now", "Made pipeline funnel", "stuck deals — biggest count by stage".',
      ].join(' '),
      schema: Args as z.ZodType<A>,
      jsonSchema: zodToJsonSchema(Args),
      execute: async (rawArgs) => {
        const args = rawArgs as A;
        try {
          const [stages, pipelines, dealsRes] = await Promise.all([
            this.client.listStages(),
            this.client.listPipelines(),
            this.client.listDeals({
              status: args.status === 'all' ? 'all_not_deleted' : args.status,
              pipelineId: args.pipelineId,
              ownerId: args.ownerId,
              limit: 500,
            }),
          ]);
          const pipelineNameById = new Map(pipelines.map((p) => [p.id, p.name] as const));
          const stageById = new Map(stages.map((s) => [s.id, s] as const));
          const counts = new Map<number, { count: number; total: number }>();
          for (const d of dealsRes.items) {
            const e = counts.get(d.stage_id) ?? { count: 0, total: 0 };
            e.count += 1;
            e.total += Number(d.value) || 0;
            counts.set(d.stage_id, e);
          }
          const rows = [...counts.entries()].map(([stageId, agg]) => {
            const s = stageById.get(stageId);
            return {
              stageId,
              stageName: s?.name ?? `stage_${stageId}`,
              pipelineId: s?.pipeline_id ?? 0,
              pipelineName: s ? (pipelineNameById.get(s.pipeline_id) ?? null) : null,
              count: agg.count,
              totalValueUsd: round2(agg.total),
            };
          }).sort((a, b) => (a.pipelineId - b.pipelineId) || ((stageById.get(a.stageId)?.order_nr ?? 0) - (stageById.get(b.stageId)?.order_nr ?? 0)));
          return {
            ok: true,
            data: {
              status: args.status,
              pipelineId: args.pipelineId ?? null,
              ownerId: args.ownerId ?? null,
              dealCount: dealsRes.items.length,
              truncated: dealsRes.hasMore,
              note: dealsRes.hasMore ? 'Result truncated at 10-page (≈5000-deal) scan cap. Re-call with `pipelineId` to narrow.' : undefined,
              rows,
            },
          };
        } catch (err) { return pipedriveErrorResult(err); }
      },
    };
  }
```

Add the helpers near the bottom of the file:
```ts
function round2(n: number): number { return Math.round(n * 100) / 100; }

/** Number of buckets of size `interval` between two YYYY-MM-DD dates,
 *  inclusive on both ends. Used to compute the `amount` arg /v1/deals/timeline
 *  expects (it counts intervals from `start_date`). */
function bucketsBetween(start: string, end: string, interval: 'day' | 'week' | 'month' | 'quarter'): number {
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const s = new Date(Date.UTC(sy, sm - 1, sd));
  const e = new Date(Date.UTC(ey, em - 1, ed));
  const days = Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
  if (interval === 'day') return Math.max(1, days);
  if (interval === 'week') return Math.max(1, Math.ceil(days / 7));
  if (interval === 'month') return Math.max(1, (ey - sy) * 12 + (em - sm) + 1);
  // quarter
  const sq = Math.floor((sm - 1) / 3); const eq = Math.floor((em - 1) / 3);
  return Math.max(1, (ey - sy) * 4 + (eq - sq) + 1);
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run tests/unit/connectors/pipedrive/connector.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/pipedrive/connector.ts tests/unit/connectors/pipedrive/connector.test.ts
git commit -m "feat(pipedrive): tools deal_timeseries + pipeline_snapshot"
```

---

## Task 10: Tools group C — `list_deals` + `deal_detail` (custom field resolution)

**Files:**
- Modify: `src/connectors/pipedrive/connector.ts`
- Modify: `tests/unit/connectors/pipedrive/connector.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/connectors/pipedrive/connector.test.ts`:
```ts
describe('pipedrive.list_deals', () => {
  it('returns rows with custom-field hashes resolved (Source label)', async () => {
    const stub = makeStub({
      listDealFields: vi.fn().mockResolvedValue([
        { key: 'f21bb44b8b693a780b3e881a258257db8897b6d0', name: 'Source', field_type: 'enum', options: [{ id: 161, label: 'ICFF' }] },
        { key: '9539ba1ce1e5a79d39a30359e5c3e5b7a95ac082', name: 'Specifier', field_type: 'varchar' },
      ]),
      listDeals: vi.fn().mockResolvedValue({ items: [
        { id: 816, title: 'KBM-Hogue', value: 24500, currency: 'USD', status: 'open', stage_id: 11, pipeline_id: 3, owner_id: { id: 7, name: 'Lana' }, person_id: { value: 12, name: 'Tasha' }, org_id: { value: 5, name: 'KBM-Hogue' }, add_time: '2026-04-01', won_time: null, lost_time: null, lost_reason: null, expected_close_date: '2026-05-15', custom_fields: { 'f21bb44b8b693a780b3e881a258257db8897b6d0': 161, '9539ba1ce1e5a79d39a30359e5c3e5b7a95ac082': 'AcmeArch' } },
      ], hasMore: false }),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.list_deals')!;
    const r = await tool.execute({ dateRange: 'last_30_days', limit: 50 }) as any;
    expect(r.data.rows[0]).toMatchObject({
      id: 816, title: 'KBM-Hogue', valueUsd: 24500, ownerId: 7, ownerName: 'Lana',
      orgId: 5, orgName: 'KBM-Hogue', personId: 12, personName: 'Tasha',
      sourceLabel: 'ICFF', specifierOrgName: 'AcmeArch',
    });
  });

  it('passes status, pipelineId, sourceOptionId filters through to client + filters client-side for source', async () => {
    const stub = makeStub({
      listDealFields: vi.fn().mockResolvedValue([
        { key: 'f21bb44b8b693a780b3e881a258257db8897b6d0', name: 'Source', field_type: 'enum', options: [{ id: 161, label: 'ICFF' }, { id: 162, label: 'Design Miami' }] },
      ]),
      listDeals: vi.fn().mockResolvedValue({ items: [
        { id: 1, title: 'A', value: 100, currency: 'USD', status: 'won', stage_id: 11, pipeline_id: 3, owner_id: 7, person_id: null, org_id: null, custom_fields: { 'f21bb44b8b693a780b3e881a258257db8897b6d0': 161 } },
        { id: 2, title: 'B', value: 200, currency: 'USD', status: 'won', stage_id: 11, pipeline_id: 3, owner_id: 7, person_id: null, org_id: null, custom_fields: { 'f21bb44b8b693a780b3e881a258257db8897b6d0': 162 } },
      ], hasMore: false }),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.list_deals')!;
    const r = await tool.execute({ status: 'won', pipelineId: 3, sourceOptionId: 161, limit: 50 }) as any;
    expect((stub.listDeals as any)).toHaveBeenCalledWith(expect.objectContaining({ status: 'won', pipelineId: 3 }));
    // Client-side filter on sourceOptionId keeps only deal 1.
    expect(r.data.rows.map((d: any) => d.id)).toEqual([1]);
  });
});

describe('pipedrive.deal_detail', () => {
  it('joins person + org + activity + product details with resolved custom fields', async () => {
    const stub = makeStub({
      getDeal: vi.fn().mockResolvedValue({ id: 816, title: 'KBM-Hogue', value: 24500, currency: 'USD', status: 'open', stage_id: 11, pipeline_id: 3, owner_id: { id: 7, name: 'Lana' }, person_id: { value: 12, name: 'Tasha' }, org_id: { value: 5, name: 'KBM-Hogue' }, custom_fields: { 'f21bb44b8b693a780b3e881a258257db8897b6d0': 161 } }),
      listDealFields: vi.fn().mockResolvedValue([
        { key: 'f21bb44b8b693a780b3e881a258257db8897b6d0', name: 'Source', field_type: 'enum', options: [{ id: 161, label: 'ICFF' }] },
      ]),
      getOrganization: vi.fn().mockResolvedValue({ id: 5, name: 'KBM-Hogue', address: '1 Main St', web: 'kbm.com' }),
      listActivities: vi.fn().mockResolvedValue({ items: [
        { id: 100, type: 'call', subject: 'Discovery call', user_id: 7, done: 1, due_date: '2026-04-15', deal_id: 816 },
      ], hasMore: false }),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.deal_detail')!;
    const r = await tool.execute({ dealId: 816 }) as any;
    expect(r.ok).toBe(true);
    expect(r.data.id).toBe(816);
    expect(r.data.orgDetail).toMatchObject({ id: 5, name: 'KBM-Hogue', address: '1 Main St', web: 'kbm.com' });
    expect(r.data.lastActivity).toMatchObject({ type: 'call', subject: 'Discovery call', done: true });
    expect(r.data.customFields).toMatchObject({ Source: 'ICFF' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/connectors/pipedrive/connector.test.ts -t "list_deals|deal_detail"`
Expected: FAIL.

- [ ] **Step 3: Implement the two tools**

Extend `buildTools()` in `src/connectors/pipedrive/connector.ts`:
```ts
  private buildTools(): readonly ToolDef[] {
    return [
      this.toolListDirectory(),
      this.toolSearch(),
      this.toolDealTimeseries(),
      this.toolPipelineSnapshot(),
      this.toolListDeals(),
      this.toolDealDetail(),
    ];
  }
```

Add the two methods after `toolPipelineSnapshot()`:
```ts
  // ============================================================
  // Group C — Deal-level
  // ============================================================

  private toolListDeals(): ToolDef {
    const Args = z.object({
      dateRange: DateRangeArg.optional(),
      dateField: z.enum(['add_time', 'won_time', 'close_time', 'update_time']).default('update_time'),
      status: z.enum(['open', 'won', 'lost', 'deleted', 'all_not_deleted']).default('all_not_deleted'),
      pipelineId: z.number().int().optional(),
      stageId: z.number().int().optional(),
      ownerId: z.number().int().optional(),
      orgId: z.number().int().optional(),
      personId: z.number().int().optional(),
      sourceOptionId: z.number().int().optional(),
      search: z.string().optional().describe('Substring filter on deal title — applied client-side after fetch.'),
      sortBy: z.enum(['value', 'add_time', 'update_time', 'won_time']).default('value'),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
      limit: z.number().int().min(1).max(500).default(50),
    });
    type A = z.infer<typeof Args>;
    return {
      name: 'pipedrive.list_deals',
      description: [
        'Cursor-paginated list of deals with the analytical fields. Hard cap of 500/call.',
        'Output rows: { id, title, status, valueUsd, pipelineId, stageId, ownerId, ownerName, orgId, orgName, personId, personName, addTime, wonTime, lostTime, lostReason, sourceLabel, specifierOrgName, purchaserOrgName, expectedCloseDate }.',
        'Use for "top 20 open deals by value", "lost deals last month with reasons", "all deals from ICFF source". Filter by status/pipeline/stage/owner/org/person/sourceOptionId.',
      ].join(' '),
      schema: Args as z.ZodType<A>,
      jsonSchema: zodToJsonSchema(Args),
      execute: async (rawArgs) => {
        const args = rawArgs as A;
        try {
          const range = args.dateRange ? normalizeDateRange(args.dateRange) : null;
          const [dealsRes, fields] = await Promise.all([
            this.client.listDeals({
              status: args.status,
              pipelineId: args.pipelineId,
              stageId: args.stageId,
              ownerId: args.ownerId,
              orgId: args.orgId,
              personId: args.personId,
              startDate: range?.startDate,
              endDate: range?.endDate,
              sortBy: args.sortBy,
              sortOrder: args.sortOrder,
              limit: args.limit,
            }),
            this.client.listDealFields(),
          ]);
          const sourceField = fields.find((f) => f.name === 'Source');
          const specifierField = fields.find((f) => f.name === 'Specifier');
          const purchaserField = fields.find((f) => f.name === 'Purchaser');
          const sourceOptions = new Map<string | number, string>((sourceField?.options ?? []).map((o) => [o.id, o.label] as const));

          let rows = dealsRes.items.map((d) => {
            const cf = d.custom_fields ?? {};
            const sourceRaw = sourceField ? cf[sourceField.key] : undefined;
            const sourceLabel = sourceRaw !== undefined && sourceRaw !== null ? sourceOptions.get(sourceRaw as string | number) ?? String(sourceRaw) : null;
            const specifierOrgName = specifierField ? (cf[specifierField.key] ?? null) : null;
            const purchaserOrgName = purchaserField ? (cf[purchaserField.key] ?? null) : null;
            const owner = typeof d.owner_id === 'object' && d.owner_id !== null ? d.owner_id : { id: d.owner_id as number, name: null as string | null };
            const person = typeof d.person_id === 'object' && d.person_id !== null ? d.person_id : null;
            const org = typeof d.org_id === 'object' && d.org_id !== null ? d.org_id : null;
            // Client-side date filter (until v2 supports range query natively).
            if (range) {
              const tsStr = (d as Record<string, unknown>)[args.dateField] as string | undefined;
              if (tsStr) {
                const ymd = tsStr.slice(0, 10);
                if (ymd < range.startDate || ymd > range.endDate) return null;
              }
            }
            // Client-side filter on sourceOptionId since v2 doesn't expose it.
            if (args.sourceOptionId !== undefined && Number(sourceRaw) !== args.sourceOptionId) return null;
            // Client-side title substring search.
            if (args.search && !d.title.toLowerCase().includes(args.search.toLowerCase())) return null;
            return {
              id: d.id,
              title: d.title,
              status: d.status,
              valueUsd: round2(Number(d.value) || 0),
              pipelineId: d.pipeline_id,
              stageId: d.stage_id,
              ownerId: owner.id,
              ownerName: owner.name,
              orgId: org?.value ?? null,
              orgName: org?.name ?? null,
              personId: person?.value ?? null,
              personName: person?.name ?? null,
              addTime: d.add_time ?? null,
              wonTime: d.won_time ?? null,
              lostTime: d.lost_time ?? null,
              lostReason: d.lost_reason ?? null,
              sourceLabel,
              specifierOrgName,
              purchaserOrgName,
              expectedCloseDate: d.expected_close_date ?? null,
            };
          }).filter((r): r is NonNullable<typeof r> => r !== null);
          rows = rows.slice(0, args.limit);
          return {
            ok: true,
            data: {
              dateRange: range,
              count: rows.length,
              truncated: dealsRes.hasMore,
              note: dealsRes.hasMore ? 'Underlying scan hit the 10-page cap; tighten filters to ensure totals are exhaustive.' : undefined,
              rows,
            },
          };
        } catch (err) { return pipedriveErrorResult(err); }
      },
    };
  }

  private toolDealDetail(): ToolDef {
    const Args = z.object({ dealId: z.number().int().positive() });
    type A = z.infer<typeof Args>;
    return {
      name: 'pipedrive.deal_detail',
      description: [
        'Single deal with all fields, custom fields resolved to human names + linked person + org + last activity.',
        'Output extends list_deals row with: personDetail{name, emails, phones}, orgDetail{name, address, web}, lastActivity{type, subject, dueDate, done}, products[{name, qty, priceUsd}], notesCount, activitiesCount, doneActivitiesCount, customFields{...}.',
      ].join(' '),
      schema: Args as z.ZodType<A>,
      jsonSchema: zodToJsonSchema(Args),
      execute: async (rawArgs) => {
        const args = rawArgs as A;
        try {
          const deal = await this.client.getDeal(args.dealId);
          const orgIdNum = typeof deal.org_id === 'object' && deal.org_id !== null ? deal.org_id.value : (deal.org_id as number | null);
          const [orgDetail, activitiesRes, customFields] = await Promise.all([
            orgIdNum ? this.client.getOrganization(orgIdNum).catch(() => null) : Promise.resolve(null),
            this.client.listActivities({}).then((res) => ({ items: res.items.filter((a) => a.deal_id === args.dealId), hasMore: res.hasMore })).catch(() => ({ items: [], hasMore: false })),
            this.resolveCustomFieldValues(deal),
          ]);
          const activities = activitiesRes.items;
          const lastActivity = activities.length > 0 ? activities[activities.length - 1] : null;
          const owner = typeof deal.owner_id === 'object' && deal.owner_id !== null ? deal.owner_id : { id: deal.owner_id as number, name: null as string | null };
          const person = typeof deal.person_id === 'object' && deal.person_id !== null ? deal.person_id : null;
          const org = typeof deal.org_id === 'object' && deal.org_id !== null ? deal.org_id : null;
          return {
            ok: true,
            data: {
              id: deal.id,
              title: deal.title,
              status: deal.status,
              valueUsd: round2(Number(deal.value) || 0),
              pipelineId: deal.pipeline_id,
              stageId: deal.stage_id,
              ownerId: owner.id,
              ownerName: owner.name,
              orgId: org?.value ?? orgIdNum,
              orgName: org?.name ?? orgDetail?.name ?? null,
              personId: person?.value ?? null,
              personName: person?.name ?? null,
              addTime: deal.add_time ?? null,
              wonTime: deal.won_time ?? null,
              lostTime: deal.lost_time ?? null,
              lostReason: deal.lost_reason ?? null,
              expectedCloseDate: deal.expected_close_date ?? null,
              orgDetail: orgDetail ? { id: orgDetail.id, name: orgDetail.name, address: orgDetail.address ?? null, web: orgDetail.web ?? null } : null,
              lastActivity: lastActivity ? { type: lastActivity.type, subject: lastActivity.subject, dueDate: lastActivity.due_date ?? null, done: lastActivity.done === 1 } : null,
              activitiesCount: activities.length,
              doneActivitiesCount: activities.filter((a) => a.done === 1).length,
              customFields,
            },
          };
        } catch (err) { return pipedriveErrorResult(err); }
      },
    };
  }
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run tests/unit/connectors/pipedrive/connector.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/pipedrive/connector.ts tests/unit/connectors/pipedrive/connector.test.ts
git commit -m "feat(pipedrive): tools list_deals + deal_detail with custom fields"
```

---

## Task 11: Tools group D — `organization_performance` + `organization_detail`

**Files:**
- Modify: `src/connectors/pipedrive/connector.ts`
- Modify: `tests/unit/connectors/pipedrive/connector.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/connectors/pipedrive/connector.test.ts`:
```ts
describe('pipedrive.organization_performance', () => {
  it('groups won/open deals by org_id with names + lastDealTime', async () => {
    const stub = makeStub({
      listDeals: vi.fn().mockResolvedValue({ items: [
        { id: 1, title: 'A', value: 1000, currency: 'USD', status: 'won', stage_id: 11, pipeline_id: 3, owner_id: 7, person_id: null, org_id: { value: 5, name: 'KBM-Hogue' }, won_time: '2026-04-10', add_time: '2026-04-01' },
        { id: 2, title: 'B', value: 2000, currency: 'USD', status: 'won', stage_id: 11, pipeline_id: 3, owner_id: 7, person_id: null, org_id: { value: 5, name: 'KBM-Hogue' }, won_time: '2026-04-15', add_time: '2026-04-02' },
        { id: 3, title: 'C', value: 5000, currency: 'USD', status: 'open', stage_id: 12, pipeline_id: 3, owner_id: 7, person_id: null, org_id: { value: 6, name: 'Bilotti' }, add_time: '2026-04-05' },
      ], hasMore: false }),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.organization_performance')!;
    const r = await tool.execute({ dateRange: 'last_30_days', topN: 25, metric: 'won_value' }) as any;
    expect(r.data.rows[0]).toMatchObject({ orgId: 5, orgName: 'KBM-Hogue', wonCount: 2, wonValueUsd: 3000 });
    expect(r.data.rows[1]).toMatchObject({ orgId: 6, orgName: 'Bilotti', openCount: 1, openValueUsd: 5000 });
  });

  it('flags truncated when listDeals.hasMore is true', async () => {
    const stub = makeStub({ listDeals: vi.fn().mockResolvedValue({ items: [], hasMore: true }) });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.organization_performance')!;
    const r = await tool.execute({ dateRange: 'last_30_days', topN: 25, metric: 'won_value' }) as any;
    expect(r.data.truncated).toBe(true);
  });
});

describe('pipedrive.organization_detail', () => {
  it('returns org + deals + persons (activities omitted by default)', async () => {
    const stub = makeStub({
      getOrganization: vi.fn().mockResolvedValue({ id: 5, name: 'KBM-Hogue', address: '1 Main St', web: 'kbm.com' }),
      listDeals: vi.fn().mockResolvedValue({ items: [
        { id: 1, title: 'A', value: 1000, currency: 'USD', status: 'open', stage_id: 11, pipeline_id: 3, owner_id: 7, person_id: null, org_id: { value: 5, name: 'KBM-Hogue' } },
      ], hasMore: false }),
      listPersons: vi.fn().mockResolvedValue({ items: [
        { id: 12, name: 'Tasha', emails: [{ value: 't@kbm.com', primary: true }], phones: [], org_id: { value: 5, name: 'KBM-Hogue' } },
      ], hasMore: false }),
      listDealFields: vi.fn().mockResolvedValue([]),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.organization_detail')!;
    const r = await tool.execute({ orgId: 5 }) as any;
    expect(r.data.org.name).toBe('KBM-Hogue');
    expect(r.data.deals).toHaveLength(1);
    expect(r.data.persons).toHaveLength(1);
    expect(r.data.activities).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/connectors/pipedrive/connector.test.ts -t "organization_performance|organization_detail"`
Expected: FAIL.

- [ ] **Step 3: Implement the two tools**

Extend `buildTools()`:
```ts
  private buildTools(): readonly ToolDef[] {
    return [
      this.toolListDirectory(),
      this.toolSearch(),
      this.toolDealTimeseries(),
      this.toolPipelineSnapshot(),
      this.toolListDeals(),
      this.toolDealDetail(),
      this.toolOrganizationPerformance(),
      this.toolOrganizationDetail(),
    ];
  }
```

Add the two methods after `toolDealDetail()`:
```ts
  // ============================================================
  // Group D — Organization analysis
  // ============================================================

  private toolOrganizationPerformance(): ToolDef {
    const Args = z.object({
      dateRange: DateRangeArg,
      topN: z.number().int().min(1).max(100).default(25),
      metric: z.enum(['won_value', 'won_count', 'open_value']).default('won_value'),
    });
    type A = z.infer<typeof Args>;
    return {
      name: 'pipedrive.organization_performance',
      description: [
        'Top organizations by contribution over a window. Hybrid: paginates /v2/deals, groups client-side by org_id, joins names from the deal\'s embedded org_id.',
        'Capped at ~5000 deals scanned (10 pages). Returns `truncated: true` when the cap is hit.',
        'Output rows: { orgId, orgName, dealCount, totalValueUsd, wonCount, wonValueUsd, openCount, openValueUsd, lastDealTime }.',
        'Use for "top firms by trade revenue YTD", "customer concentration analysis", "repeat buyers in Q1".',
      ].join(' '),
      schema: Args as z.ZodType<A>,
      jsonSchema: zodToJsonSchema(Args),
      execute: async (rawArgs) => {
        const args = rawArgs as A;
        try {
          const { startDate, endDate } = normalizeDateRange(args.dateRange);
          const dealsRes = await this.client.listDeals({
            status: 'all_not_deleted',
            startDate, endDate,
            limit: 500,
          });
          const byOrg = new Map<number, {
            orgId: number; orgName: string | null;
            dealCount: number; totalValueUsd: number;
            wonCount: number; wonValueUsd: number;
            openCount: number; openValueUsd: number;
            lastDealTime: string | null;
          }>();
          for (const d of dealsRes.items) {
            const org = typeof d.org_id === 'object' && d.org_id !== null ? d.org_id : null;
            if (!org) continue; // skip orphan deals — they can't be grouped
            const ts = d.won_time ?? d.add_time ?? null;
            // window check (client-side, since v2 deals lacks server-side range filter)
            if (ts) {
              const ymd = ts.slice(0, 10);
              if (ymd < startDate || ymd > endDate) continue;
            }
            const e = byOrg.get(org.value) ?? {
              orgId: org.value, orgName: org.name,
              dealCount: 0, totalValueUsd: 0,
              wonCount: 0, wonValueUsd: 0,
              openCount: 0, openValueUsd: 0,
              lastDealTime: null,
            };
            e.dealCount += 1;
            e.totalValueUsd += Number(d.value) || 0;
            if (d.status === 'won') { e.wonCount += 1; e.wonValueUsd += Number(d.value) || 0; }
            if (d.status === 'open') { e.openCount += 1; e.openValueUsd += Number(d.value) || 0; }
            if (ts && (!e.lastDealTime || ts > e.lastDealTime)) e.lastDealTime = ts;
            byOrg.set(org.value, e);
          }
          const sortKey = args.metric === 'won_value' ? 'wonValueUsd' : args.metric === 'won_count' ? 'wonCount' : 'openValueUsd';
          const rows = [...byOrg.values()]
            .map((r) => ({ ...r, totalValueUsd: round2(r.totalValueUsd), wonValueUsd: round2(r.wonValueUsd), openValueUsd: round2(r.openValueUsd) }))
            .sort((a, b) => (b[sortKey] as number) - (a[sortKey] as number))
            .slice(0, args.topN);
          return {
            ok: true,
            data: {
              dateRange: { startDate, endDate },
              metric: args.metric,
              orgCount: byOrg.size,
              truncated: dealsRes.hasMore,
              note: dealsRes.hasMore ? 'Result truncated at 10-page (≈5000-deal) scan cap.' : undefined,
              rows,
            },
          };
        } catch (err) { return pipedriveErrorResult(err); }
      },
    };
  }

  private toolOrganizationDetail(): ToolDef {
    const Args = z.object({
      orgId: z.number().int().positive(),
      includeDeals: z.boolean().default(true),
      includePersons: z.boolean().default(true),
      includeActivities: z.boolean().default(false),
    });
    type A = z.infer<typeof Args>;
    return {
      name: 'pipedrive.organization_detail',
      description: [
        'Single org with deals, contacts, and optionally activities. Useful for account-context lookups: "tell me about Rarify — who\'s our contact, what\'s open, last interaction".',
        'Output: { org: {id, name, address, web, ...}, deals?: [list_deals row, max 50], persons?: [{id, name, emails, phones}, max 50], activities?: [{id, type, subject, due, done, ownerName}, max 50] }.',
      ].join(' '),
      schema: Args as z.ZodType<A>,
      jsonSchema: zodToJsonSchema(Args),
      execute: async (rawArgs) => {
        const args = rawArgs as A;
        try {
          const orgPromise = this.client.getOrganization(args.orgId);
          const dealsPromise = args.includeDeals ? this.client.listDeals({ orgId: args.orgId, limit: 50 }) : Promise.resolve({ items: [], hasMore: false });
          const personsPromise = args.includePersons ? this.client.listPersons({ orgId: args.orgId }) : Promise.resolve({ items: [], hasMore: false });
          const activitiesPromise = args.includeActivities ? this.client.listActivities({}) : Promise.resolve({ items: [], hasMore: false });
          const [org, dealsRes, personsRes, activitiesRes, users] = await Promise.all([orgPromise, dealsPromise, personsPromise, activitiesPromise, this.client.listUsers()]);
          const userById = new Map(users.map((u) => [u.id, u.name] as const));

          const data: Record<string, unknown> = {
            org: { id: org.id, name: org.name, address: org.address ?? null, web: org.web ?? null },
          };
          if (args.includeDeals) {
            data.deals = dealsRes.items.slice(0, 50).map((d) => ({ id: d.id, title: d.title, status: d.status, valueUsd: round2(Number(d.value) || 0), stageId: d.stage_id, pipelineId: d.pipeline_id }));
          }
          if (args.includePersons) {
            data.persons = personsRes.items.slice(0, 50).map((p) => ({ id: p.id, name: p.name, emails: p.emails ?? [], phones: p.phones ?? [] }));
          }
          if (args.includeActivities) {
            data.activities = activitiesRes.items.slice(0, 50).map((a) => ({ id: a.id, type: a.type, subject: a.subject, due: a.due_date ?? null, done: a.done === 1, ownerName: userById.get(a.user_id) ?? null }));
          }
          return { ok: true, data };
        } catch (err) { return pipedriveErrorResult(err); }
      },
    };
  }
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run tests/unit/connectors/pipedrive/connector.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/pipedrive/connector.ts tests/unit/connectors/pipedrive/connector.test.ts
git commit -m "feat(pipedrive): tools organization_performance + organization_detail"
```

---

## Task 12: Tools group E — `lost_reasons_breakdown` + `activity_summary` + `user_performance`

**Files:**
- Modify: `src/connectors/pipedrive/connector.ts`
- Modify: `tests/unit/connectors/pipedrive/connector.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/connectors/pipedrive/connector.test.ts`:
```ts
describe('pipedrive.lost_reasons_breakdown', () => {
  it('groups lost deals by reason with percentOfTotal', async () => {
    const stub = makeStub({
      listDeals: vi.fn().mockResolvedValue({ items: [
        { id: 1, title: 'A', value: 1000, currency: 'USD', status: 'lost', stage_id: 11, pipeline_id: 3, owner_id: 7, person_id: null, org_id: null, lost_reason: 'Budget', lost_time: '2026-04-10' },
        { id: 2, title: 'B', value: 2000, currency: 'USD', status: 'lost', stage_id: 11, pipeline_id: 3, owner_id: 7, person_id: null, org_id: null, lost_reason: 'Budget', lost_time: '2026-04-15' },
        { id: 3, title: 'C', value: 5000, currency: 'USD', status: 'lost', stage_id: 12, pipeline_id: 3, owner_id: 7, person_id: null, org_id: null, lost_reason: 'Timing', lost_time: '2026-04-20' },
      ], hasMore: false }),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.lost_reasons_breakdown')!;
    const r = await tool.execute({ dateRange: 'last_30_days', groupBy: 'reason', topN: 25 }) as any;
    expect(r.data.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'Budget', count: 2, totalValueUsd: 3000 }),
      expect.objectContaining({ reason: 'Timing', count: 1, totalValueUsd: 5000 }),
    ]));
    const total = r.data.rows.reduce((s: number, r: any) => s + r.percentOfTotal, 0);
    expect(total).toBeCloseTo(100, 0);
  });
});

describe('pipedrive.activity_summary', () => {
  it('aggregates activities by month with byType + byUser breakdowns', async () => {
    const stub = makeStub({
      listActivities: vi.fn().mockResolvedValue({ items: [
        { id: 1, type: 'call', subject: 'a', user_id: 7, done: 1, due_date: '2026-04-05', marked_as_done_time: '2026-04-05 10:00:00' },
        { id: 2, type: 'meeting', subject: 'b', user_id: 7, done: 1, due_date: '2026-04-10', marked_as_done_time: '2026-04-10 10:00:00' },
        { id: 3, type: 'call', subject: 'c', user_id: 8, done: 1, due_date: '2026-04-12', marked_as_done_time: '2026-04-12 10:00:00' },
      ], hasMore: false }),
      listUsers: vi.fn().mockResolvedValue([{ id: 7, name: 'Lana', email: 'l@g.com', active_flag: true }, { id: 8, name: 'Max', email: 'm@g.com', active_flag: true }]),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.activity_summary')!;
    const r = await tool.execute({ dateRange: { startDate: '2026-04-01', endDate: '2026-04-30' }, granularity: 'month', status: 'done' }) as any;
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].count).toBe(3);
    expect(r.rows[0].byType).toMatchObject({ call: 2, meeting: 1 });
    expect(r.rows[0].byUser.find((u: any) => u.userName === 'Lana').count).toBe(2);
  });
});

describe('pipedrive.user_performance', () => {
  it('returns per-user won_value with rank sorted desc', async () => {
    const stub = makeStub({
      listUsers: vi.fn().mockResolvedValue([
        { id: 7, name: 'Lana', email: 'l@g.com', active_flag: true },
        { id: 8, name: 'Max', email: 'm@g.com', active_flag: true },
      ]),
      dealsTimeline: vi.fn().mockImplementation(async (opts) => {
        if (opts.userId === 7) return [{ period_start: '2026-04-01', period_end: '2026-04-30', count: 3, total_value_usd: 9000, weighted_value_usd: 4500, open_count: 0, open_value_usd: 0, won_count: 3, won_value_usd: 9000 }];
        if (opts.userId === 8) return [{ period_start: '2026-04-01', period_end: '2026-04-30', count: 1, total_value_usd: 1500, weighted_value_usd: 1000, open_count: 0, open_value_usd: 0, won_count: 1, won_value_usd: 1500 }];
        return [];
      }),
    });
    const conn = new PipedriveConnector({ client: stub });
    const tool = conn.tools.find((t) => t.name === 'pipedrive.user_performance')!;
    const r = await tool.execute({ dateRange: 'last_30_days', metric: 'won_value', topN: 10 }) as any;
    expect(r.data.rows).toEqual([
      { userId: 7, userName: 'Lana', value: 9000, rank: 1 },
      { userId: 8, userName: 'Max', value: 1500, rank: 2 },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/connectors/pipedrive/connector.test.ts -t "lost_reasons_breakdown|activity_summary|user_performance"`
Expected: FAIL.

- [ ] **Step 3: Implement the three tools**

Extend `buildTools()` to its final form:
```ts
  private buildTools(): readonly ToolDef[] {
    return [
      this.toolListDirectory(),
      this.toolSearch(),
      this.toolDealTimeseries(),
      this.toolPipelineSnapshot(),
      this.toolListDeals(),
      this.toolDealDetail(),
      this.toolOrganizationPerformance(),
      this.toolOrganizationDetail(),
      this.toolLostReasonsBreakdown(),
      this.toolActivitySummary(),
      this.toolUserPerformance(),
    ];
  }
```

Add the three methods after `toolOrganizationDetail()`:
```ts
  // ============================================================
  // Group E — Lost reasons + productivity
  // ============================================================

  private toolLostReasonsBreakdown(): ToolDef {
    const Args = z.object({
      dateRange: DateRangeArg,
      pipelineId: z.number().int().optional(),
      groupBy: z.enum(['reason', 'reason_and_stage']).default('reason'),
      topN: z.number().int().min(1).max(100).default(25),
    });
    type A = z.infer<typeof Args>;
    return {
      name: 'pipedrive.lost_reasons_breakdown',
      description: [
        'Group lost deals by `lost_reason` (and optionally last stage) over a window. Paginates /v2/deals?status=lost, aggregates client-side. Capped at 10 pages.',
        'Output rows: { reason, count, totalValueUsd, percentOfTotal, ...stageBreakdown if groupBy="reason_and_stage" }.',
        'Use for "why did we lose Q1 deals", "lost reasons in Wholesale physical pipeline last quarter".',
      ].join(' '),
      schema: Args as z.ZodType<A>,
      jsonSchema: zodToJsonSchema(Args),
      execute: async (rawArgs) => {
        const args = rawArgs as A;
        try {
          const { startDate, endDate } = normalizeDateRange(args.dateRange);
          const [dealsRes, stages] = await Promise.all([
            this.client.listDeals({ status: 'lost', pipelineId: args.pipelineId, startDate, endDate, limit: 500 }),
            args.groupBy === 'reason_and_stage' ? this.client.listStages() : Promise.resolve([]),
          ]);
          const stageNameById = new Map(stages.map((s) => [s.id, s.name] as const));
          const buckets = new Map<string, { reason: string; count: number; total: number; byStage: Map<number, { count: number; total: number }> }>();
          for (const d of dealsRes.items) {
            const ts = d.lost_time ?? d.update_time ?? d.add_time ?? null;
            if (ts) { const ymd = ts.slice(0, 10); if (ymd < startDate || ymd > endDate) continue; }
            const reason = d.lost_reason ?? '(unspecified)';
            const e = buckets.get(reason) ?? { reason, count: 0, total: 0, byStage: new Map() };
            e.count += 1;
            e.total += Number(d.value) || 0;
            const sb = e.byStage.get(d.stage_id) ?? { count: 0, total: 0 };
            sb.count += 1; sb.total += Number(d.value) || 0;
            e.byStage.set(d.stage_id, sb);
            buckets.set(reason, e);
          }
          const totalCount = [...buckets.values()].reduce((s, b) => s + b.count, 0) || 1;
          const rows = [...buckets.values()]
            .map((b) => {
              const base: Record<string, unknown> = {
                reason: b.reason,
                count: b.count,
                totalValueUsd: round2(b.total),
                percentOfTotal: round2((b.count / totalCount) * 100),
              };
              if (args.groupBy === 'reason_and_stage') {
                base.stageBreakdown = [...b.byStage.entries()].map(([sid, agg]) => ({ stageId: sid, stageName: stageNameById.get(sid) ?? `stage_${sid}`, count: agg.count, totalValueUsd: round2(agg.total) }));
              }
              return base;
            })
            .sort((a, b) => (b.count as number) - (a.count as number))
            .slice(0, args.topN);
          return {
            ok: true,
            data: {
              dateRange: { startDate, endDate },
              groupBy: args.groupBy,
              totalLostDeals: totalCount,
              truncated: dealsRes.hasMore,
              note: dealsRes.hasMore ? 'Result truncated at 10-page scan cap.' : undefined,
              rows,
            },
          };
        } catch (err) { return pipedriveErrorResult(err); }
      },
    };
  }

  private toolActivitySummary(): ToolDef {
    const Args = z.object({
      dateRange: DateRangeArg,
      granularity: z.enum(['day', 'week', 'month']).default('month'),
      userId: z.number().int().optional(),
      type: z.enum(['call', 'meeting', 'email', 'task', 'all']).default('all'),
      status: z.enum(['done', 'pending', 'all']).default('done'),
    });
    type A = z.infer<typeof Args>;
    return {
      name: 'pipedrive.activity_summary',
      description: [
        'Volume of activities by user/type/status over a window. Paginates /v1/activities with filters, aggregates client-side. Capped at 5000 activities.',
        'Output rows: { key, count, byType: {call, meeting, email, task}, byUser: [{userId, userName, count}] }. `key` is YYYY-MM-DD (day), week-start (week), or YYYY-MM (month).',
        'Use for "how many calls did Max log in March", "pending activities by user", "meeting count trend last 6 months".',
      ].join(' '),
      schema: Args as z.ZodType<A>,
      jsonSchema: zodToJsonSchema(Args),
      execute: async (rawArgs) => {
        const args = rawArgs as A;
        const { startDate, endDate } = normalizeDateRange(args.dateRange);
        const [activitiesRes, users] = await Promise.all([
          this.client.listActivities({
            startDate, endDate,
            userId: args.userId,
            type: args.type === 'all' ? undefined : args.type,
            done: args.status === 'all' ? undefined : (args.status === 'done' ? 1 : 0),
          }),
          this.client.listUsers(),
        ]);
        const userById = new Map(users.map((u) => [u.id, u.name] as const));
        const buckets = new Map<string, { count: number; byType: Record<string, number>; byUser: Map<number, number> }>();
        for (const a of activitiesRes.items) {
          const ts = a.marked_as_done_time ?? a.due_date ?? a.add_time;
          if (!ts) continue;
          const ymd = ts.slice(0, 10);
          const key = args.granularity === 'month' ? ymd.slice(0, 7) : args.granularity === 'week' ? weekStart(ymd) : ymd;
          const e = buckets.get(key) ?? { count: 0, byType: {}, byUser: new Map() };
          e.count += 1;
          e.byType[a.type] = (e.byType[a.type] ?? 0) + 1;
          e.byUser.set(a.user_id, (e.byUser.get(a.user_id) ?? 0) + 1);
          buckets.set(key, e);
        }
        const rows = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, agg]) => ({
          key,
          count: agg.count,
          byType: agg.byType,
          byUser: [...agg.byUser.entries()].map(([uid, cnt]) => ({ userId: uid, userName: userById.get(uid) ?? `user_${uid}`, count: cnt })).sort((a, b) => b.count - a.count),
        }));
        return {
          period: { startDate, endDate },
          granularity: args.granularity,
          totalActivities: activitiesRes.items.length,
          truncated: activitiesRes.hasMore,
          rows,
          note: activitiesRes.hasMore ? 'Activity scan hit the 10-page cap; tighten date range or filter by user/type.' : undefined,
        };
      },
    };
  }

  private toolUserPerformance(): ToolDef {
    const Args = z.object({
      dateRange: DateRangeArg,
      metric: z.enum(['won_value', 'won_count', 'activities_done', 'avg_deal_value']).default('won_value'),
      topN: z.number().int().min(1).max(50).default(10),
    });
    type A = z.infer<typeof Args>;
    return {
      name: 'pipedrive.user_performance',
      description: [
        'Sales rep leaderboard for the window. For deal metrics, calls /v1/deals/timeline?user_id=… per active user (cached directory). For activity metric, paginates /v1/activities and groups.',
        'Output rows: { userId, userName, value, rank } where `value` is the requested metric.',
        'Use for "top performer last quarter by won revenue", "who closed the most deals in March", "best avg deal size by rep".',
      ].join(' '),
      schema: Args as z.ZodType<A>,
      jsonSchema: zodToJsonSchema(Args),
      execute: async (rawArgs) => {
        const args = rawArgs as A;
        try {
          const { startDate, endDate } = normalizeDateRange(args.dateRange);
          const users = (await this.client.listUsers()).filter((u) => u.active_flag);
          const amount = bucketsBetween(startDate, endDate, 'month');
          if (args.metric === 'activities_done') {
            const activitiesRes = await this.client.listActivities({ startDate, endDate, done: 1 });
            const counts = new Map<number, number>();
            for (const a of activitiesRes.items) counts.set(a.user_id, (counts.get(a.user_id) ?? 0) + 1);
            const rows = users.map((u) => ({ userId: u.id, userName: u.name, value: counts.get(u.id) ?? 0 }))
              .sort((a, b) => b.value - a.value).slice(0, args.topN)
              .map((r, i) => ({ ...r, rank: i + 1 }));
            return { ok: true, data: { dateRange: { startDate, endDate }, metric: args.metric, rows } };
          }
          const perUser = await Promise.all(users.map(async (u) => {
            const buckets = await this.client.dealsTimeline({ startDate, amount, interval: 'month', fieldKey: 'won_time', userId: u.id });
            const wonCount = buckets.reduce((s, b) => s + b.won_count, 0);
            const wonValue = buckets.reduce((s, b) => s + b.won_value_usd, 0);
            const totalCount = buckets.reduce((s, b) => s + b.count, 0);
            const totalValue = buckets.reduce((s, b) => s + b.total_value_usd, 0);
            const value =
              args.metric === 'won_value' ? round2(wonValue) :
              args.metric === 'won_count' ? wonCount :
              totalCount > 0 ? round2(totalValue / totalCount) : 0;
            return { userId: u.id, userName: u.name, value };
          }));
          const rows = perUser.sort((a, b) => b.value - a.value).slice(0, args.topN).map((r, i) => ({ ...r, rank: i + 1 }));
          return { ok: true, data: { dateRange: { startDate, endDate }, metric: args.metric, rows } };
        } catch (err) { return pipedriveErrorResult(err); }
      },
    };
  }
```

Add the `weekStart` helper near `bucketsBetween`:
```ts
function weekStart(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  const daysSinceMonday = (dow + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - daysSinceMonday);
  return dt.toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run tests/unit/connectors/pipedrive/connector.test.ts`
Expected: PASS — all connector tests for the 11 tools.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/pipedrive/connector.ts tests/unit/connectors/pipedrive/connector.test.ts
git commit -m "feat(pipedrive): tools lost_reasons + activity_summary + user_performance"
```

---

## Task 13: Wire-up + Live Reports + prompts

**Files:**
- Modify: `src/index.ts`
- Modify: `src/reports/live/spec.ts`
- Modify: `src/connectors/live-reports/tool-output-shapes.ts`
- Modify: `src/orchestrator/prompts.ts`
- Modify: `tests/unit/connectors/base/date-range-invariant.test.ts`

- [ ] **Step 1: Instantiate the connector in `src/index.ts`**

In `src/index.ts`, find:
```ts
  if (klaviyoApiKey) {
    const klaviyoClient = new KlaviyoApiClient({ apiKey: klaviyoApiKey });
    registry.register(new KlaviyoConnector({ client: klaviyoClient }));
    logger.info('klaviyo connector registered');
  } else {
    logger.warn('klaviyo not configured (KLAVIYO_API_KEY missing) — skipping registration');
  }
```

Add immediately after that block:
```ts
  if (pipedriveApiToken) {
    const pipedriveClient = new PipedriveApiClient({ apiToken: pipedriveApiToken });
    registry.register(new PipedriveConnector({ client: pipedriveClient }));
    logger.info('pipedrive connector registered');
  } else {
    logger.warn('pipedrive not configured (PIPEDRIVE_API_TOKEN missing) — skipping registration');
  }
```

Add the imports near the other connector imports (after the `KlaviyoApiClient` line):
```ts
import { PipedriveConnector } from './connectors/pipedrive/connector.js';
import { PipedriveApiClient } from './connectors/pipedrive/client.js';
```

Remove the `void pipedriveApiToken;` placeholder added in Task 1.

- [ ] **Step 2: Whitelist all 11 tools in `src/reports/live/spec.ts`**

In `src/reports/live/spec.ts` find the closing `]);` of `WHITELISTED_TOOLS`. Right before it, after the `// Google Search Console (SEO)` block, insert:
```ts
  // Pipedrive CRM (B2B trade / wholesale)
  'pipedrive.activity_summary',
  'pipedrive.deal_detail',
  'pipedrive.deal_timeseries',
  'pipedrive.list_deals',
  'pipedrive.list_directory',
  'pipedrive.lost_reasons_breakdown',
  'pipedrive.organization_detail',
  'pipedrive.organization_performance',
  'pipedrive.pipeline_snapshot',
  'pipedrive.search',
  'pipedrive.user_performance',
```

- [ ] **Step 3: Add output shapes for all 11 tools in `tool-output-shapes.ts`**

In `src/connectors/live-reports/tool-output-shapes.ts`, find the end of the `gsc.inspect_url` entry. Right before the final `'grafana.sql'` entry (which sits at the very bottom), insert:
```ts
  // ---------- Pipedrive CRM ----------
  'pipedrive.list_directory': {
    summary: 'Static directory lookup for Pipedrive (pipelines/stages/users/deal_fields/source_options). { kind, rows: [...] }. Stages rows include `pipeline_name` so you can disambiguate cross-pipeline collisions. Cached server-side for 10 min.',
    example: {
      kind: 'pipelines',
      rows: [
        { id: 1, name: 'Collection Pipeline-Trade & Wholesale', active: true },
        { id: 3, name: 'Wholesale (physical/inventory)', active: true },
      ],
    },
    expectedTopLevelKeys: ['kind', 'rows'],
  },
  'pipedrive.search': {
    summary: 'Fuzzy search across deals/persons/orgs via /v1/itemSearch. { query, count, rows: [{ type, id, name, summary, score }] }. Use to resolve a name → id before calling other tools.',
    example: {
      query: 'KBM',
      count: 1,
      rows: [{ type: 'deal', id: 816, name: 'KBM-Hogue', summary: 'value=24500', score: 0.92 }],
    },
    expectedTopLevelKeys: ['query', 'count', 'rows'],
    expectedArrayElementKeys: { rows: ['type', 'id', 'name', 'summary', 'score'] },
  },
  'pipedrive.deal_timeseries': {
    summary: 'Per-bucket counts and total/won/open value, server-aggregated by /v1/deals/timeline. { period, granularity, rows: [{ key, count, totalValueUsd, wonCount, wonValueUsd, openCount, openValueUsd, weightedValueUsd }], note? }. `key` is the bucket period_start (YYYY-MM-DD). All amounts USD.',
    example: {
      period: { startDate: '2026-01-01', endDate: '2026-03-31' },
      granularity: 'month',
      rows: [
        { key: '2026-01-01', count: 12, totalValueUsd: 60000, wonCount: 7, wonValueUsd: 35000, openCount: 4, openValueUsd: 20000, weightedValueUsd: 30000 },
        { key: '2026-02-01', count: 9, totalValueUsd: 45000, wonCount: 5, wonValueUsd: 25000, openCount: 3, openValueUsd: 15000, weightedValueUsd: 22000 },
      ],
    },
    expectedTopLevelKeys: ['period', 'granularity', 'rows'],
    expectedArrayElementKeys: { rows: ['key', 'count', 'totalValueUsd', 'wonCount', 'wonValueUsd', 'openCount', 'openValueUsd', 'weightedValueUsd'] },
  },
  'pipedrive.pipeline_snapshot': {
    summary: 'Point-in-time stage funnel — counts + total value per stage. Top-level: { status, pipelineId, ownerId, dealCount, truncated, rows, note? }. Each row: { stageId, stageName, pipelineId, pipelineName, count, totalValueUsd } sorted by pipelineId then stage order.',
    example: {
      status: 'open',
      pipelineId: 3,
      ownerId: null,
      dealCount: 47,
      truncated: false,
      rows: [
        { stageId: 11, stageName: 'Discovery', pipelineId: 3, pipelineName: 'Wholesale (physical)', count: 12, totalValueUsd: 30000 },
        { stageId: 12, stageName: 'Sample', pipelineId: 3, pipelineName: 'Wholesale (physical)', count: 8, totalValueUsd: 41000 },
      ],
    },
    expectedTopLevelKeys: ['status', 'pipelineId', 'ownerId', 'dealCount', 'truncated', 'rows'],
    expectedArrayElementKeys: { rows: ['stageId', 'stageName', 'pipelineId', 'pipelineName', 'count', 'totalValueUsd'] },
  },
  'pipedrive.list_deals': {
    summary: 'Cursor-paginated list of deals. { dateRange, count, truncated, rows: [{ id, title, status, valueUsd, pipelineId, stageId, ownerId, ownerName, orgId, orgName, personId, personName, addTime, wonTime, lostTime, lostReason, sourceLabel, specifierOrgName, purchaserOrgName, expectedCloseDate }], note? }. Custom fields are pre-resolved (sourceLabel from the Source enum, specifier/purchaser from text fields).',
    example: {
      dateRange: { startDate: '2026-04-01', endDate: '2026-04-27' },
      count: 1,
      truncated: false,
      rows: [
        { id: 816, title: 'KBM-Hogue restaurant', status: 'open', valueUsd: 24500, pipelineId: 3, stageId: 11, ownerId: 7, ownerName: 'Lana', orgId: 5, orgName: 'KBM-Hogue', personId: 12, personName: 'Tasha Bilotti', addTime: '2026-04-01', wonTime: null, lostTime: null, lostReason: null, sourceLabel: 'ICFF', specifierOrgName: 'AcmeArch', purchaserOrgName: null, expectedCloseDate: '2026-05-15' },
      ],
    },
    expectedTopLevelKeys: ['dateRange', 'count', 'truncated', 'rows'],
    expectedArrayElementKeys: { rows: ['id', 'title', 'status', 'valueUsd', 'pipelineId', 'stageId', 'ownerId', 'ownerName', 'orgId', 'orgName', 'personId', 'personName', 'addTime', 'wonTime', 'lostTime', 'lostReason', 'sourceLabel', 'specifierOrgName', 'purchaserOrgName', 'expectedCloseDate'] },
  },
  'pipedrive.deal_detail': {
    summary: 'Single deal with everything joined. Top-level: scalar deal fields PLUS orgDetail, lastActivity, activitiesCount, doneActivitiesCount, customFields. customFields keys are the human field names (Source/Specifier/Purchaser).',
    example: {
      id: 816, title: 'KBM-Hogue restaurant', status: 'open', valueUsd: 24500,
      pipelineId: 3, stageId: 11, ownerId: 7, ownerName: 'Lana',
      orgId: 5, orgName: 'KBM-Hogue', personId: 12, personName: 'Tasha Bilotti',
      addTime: '2026-04-01', wonTime: null, lostTime: null, lostReason: null, expectedCloseDate: '2026-05-15',
      orgDetail: { id: 5, name: 'KBM-Hogue', address: '1 Main St, NYC', web: 'kbm.com' },
      lastActivity: { type: 'call', subject: 'Discovery', dueDate: '2026-04-15', done: true },
      activitiesCount: 4, doneActivitiesCount: 3,
      customFields: { Source: 'ICFF', Specifier: 'AcmeArch' },
    },
    expectedTopLevelKeys: ['id', 'title', 'status', 'valueUsd', 'pipelineId', 'stageId', 'ownerId', 'ownerName', 'orgId', 'orgName', 'personId', 'personName', 'addTime', 'wonTime', 'lostTime', 'lostReason', 'expectedCloseDate', 'orgDetail', 'lastActivity', 'activitiesCount', 'doneActivitiesCount', 'customFields'],
  },
  'pipedrive.organization_performance': {
    summary: 'Top organizations by contribution over a window. { dateRange, metric, orgCount, truncated, rows: [{ orgId, orgName, dealCount, totalValueUsd, wonCount, wonValueUsd, openCount, openValueUsd, lastDealTime }], note? }. Sorted desc by the requested metric.',
    example: {
      dateRange: { startDate: '2026-01-01', endDate: '2026-04-27' },
      metric: 'won_value',
      orgCount: 1,
      truncated: false,
      rows: [
        { orgId: 5, orgName: 'KBM-Hogue', dealCount: 3, totalValueUsd: 75000, wonCount: 2, wonValueUsd: 50000, openCount: 1, openValueUsd: 25000, lastDealTime: '2026-04-22' },
      ],
    },
    expectedTopLevelKeys: ['dateRange', 'metric', 'orgCount', 'truncated', 'rows'],
    expectedArrayElementKeys: { rows: ['orgId', 'orgName', 'dealCount', 'totalValueUsd', 'wonCount', 'wonValueUsd', 'openCount', 'openValueUsd', 'lastDealTime'] },
  },
  'pipedrive.organization_detail': {
    summary: 'Single org with deals, contacts, optionally activities. { org, deals?, persons?, activities? }. Deal/person/activity arrays cap at 50.',
    example: {
      org: { id: 5, name: 'KBM-Hogue', address: '1 Main St', web: 'kbm.com' },
      deals: [{ id: 816, title: 'KBM-Hogue restaurant', status: 'open', valueUsd: 24500, stageId: 11, pipelineId: 3 }],
      persons: [{ id: 12, name: 'Tasha Bilotti', emails: [{ value: 'tasha@kbm.com', primary: true }], phones: [] }],
    },
    expectedTopLevelKeys: ['org'],
  },
  'pipedrive.lost_reasons_breakdown': {
    summary: 'Group lost deals by `lost_reason` (and optionally last stage). { dateRange, groupBy, totalLostDeals, truncated, rows: [{ reason, count, totalValueUsd, percentOfTotal, stageBreakdown? }], note? }. percentOfTotal sums to ~100.',
    example: {
      dateRange: { startDate: '2026-01-01', endDate: '2026-03-31' },
      groupBy: 'reason',
      totalLostDeals: 18,
      truncated: false,
      rows: [
        { reason: 'Budget', count: 8, totalValueUsd: 24000, percentOfTotal: 44.44 },
        { reason: 'Timing', count: 5, totalValueUsd: 18000, percentOfTotal: 27.78 },
        { reason: '(unspecified)', count: 5, totalValueUsd: 9000, percentOfTotal: 27.78 },
      ],
    },
    expectedTopLevelKeys: ['dateRange', 'groupBy', 'totalLostDeals', 'truncated', 'rows'],
    expectedArrayElementKeys: { rows: ['reason', 'count', 'totalValueUsd', 'percentOfTotal'] },
  },
  'pipedrive.activity_summary': {
    summary: 'Activity volume by user/type/status, bucketed daily/weekly/monthly. { period, granularity, totalActivities, truncated, rows: [{ key, count, byType: {call, meeting, email, task}, byUser: [{ userId, userName, count }] }], note? }. `key` follows the granularity (YYYY-MM for monthly, YYYY-MM-DD for daily/weekly).',
    example: {
      period: { startDate: '2026-04-01', endDate: '2026-04-30' },
      granularity: 'month',
      totalActivities: 3,
      truncated: false,
      rows: [
        { key: '2026-04', count: 3, byType: { call: 2, meeting: 1 }, byUser: [{ userId: 7, userName: 'Lana', count: 2 }, { userId: 8, userName: 'Max', count: 1 }] },
      ],
    },
    expectedTopLevelKeys: ['period', 'granularity', 'totalActivities', 'truncated', 'rows'],
    expectedArrayElementKeys: { rows: ['key', 'count', 'byType', 'byUser'] },
  },
  'pipedrive.user_performance': {
    summary: 'Sales-rep leaderboard. { dateRange, metric, rows: [{ userId, userName, value, rank }] }. `value` is the metric requested (won_value | won_count | activities_done | avg_deal_value). Sorted desc by value.',
    example: {
      dateRange: { startDate: '2026-01-01', endDate: '2026-03-31' },
      metric: 'won_value',
      rows: [
        { userId: 7, userName: 'Lana', value: 90000, rank: 1 },
        { userId: 8, userName: 'Max', value: 45000, rank: 2 },
      ],
    },
    expectedTopLevelKeys: ['dateRange', 'metric', 'rows'],
    expectedArrayElementKeys: { rows: ['userId', 'userName', 'value', 'rank'] },
  },
```

- [ ] **Step 4: Add the Pipedrive prompt section in `prompts.ts`**

In `src/orchestrator/prompts.ts`, find the `*5d. Google Search Console …` block (around line 135). Right before it (so the order is 5b Impact → 5c Klaviyo → 5d Pipedrive → 5e GSC), insert a new section. (We'll renumber GSC to 5e for cleanliness.)

Replace `*5d. Google Search Console (SEO / search visibility)*` with `*5e. Google Search Console (SEO / search visibility)*` and insert this NEW block right before it:
```ts
*5d. Pipedrive CRM (B2B trade & wholesale)* — \`pipedrive.list_directory\`, \`pipedrive.search\`, \`pipedrive.deal_timeseries\`, \`pipedrive.pipeline_snapshot\`, \`pipedrive.list_deals\`, \`pipedrive.deal_detail\`, \`pipedrive.organization_performance\`, \`pipedrive.organization_detail\`, \`pipedrive.lost_reasons_breakdown\`, \`pipedrive.activity_summary\`, \`pipedrive.user_performance\`
  • **What lives in Pipedrive**: Gantri's B2B trade / wholesale CRM. 4 active pipelines (Collection Trade & Wholesale, Made Trade & Wholesale, Wholesale physical, Wholesale dropship), ~157 open deals (~$2.5M open value as of April 2026), 9 active users (Chelsea, Francisco, Holland, Jennifer, Lana, Max, Michael, Stephanie, Zuzanna). All deals are USD.
  • **Trigger words**: "Pipedrive", "deal", "deals", "trade", "wholesale", "specifier", "purchaser", "ICFF", "Design Miami", "Neocon", "BDNY", "won", "lost", "pipeline", "stage", "funnel", "rep", "Lana", "trade firm", "B2B customer".
  • **\`pipedrive.list_directory\`** — call this FIRST when the user mentions a pipeline/stage/user/source by name. Resolves names → ids. Stages carry \`pipeline_name\` for disambiguation (Pipeline 1 + 2 share stage names like "Opportunity"/"Quoted").
  • **\`pipedrive.search\`** — fuzzy substring search across deals/persons/orgs. Use to resolve "KBM-Hogue", "Bilotti", "Wirecutter", etc. into ids before calling \`deal_detail\` / \`organization_detail\`.
  • **\`pipedrive.deal_timeseries\`** — server-aggregated counts + USD values per time bucket via /v1/deals/timeline. Args: \`dateRange\`, \`granularity\` (day|week|month|quarter, default month), \`dateField\` (add_time|won_time|close_time|expected_close_date, default won_time), optional \`pipelineId\`/\`ownerId\`/\`stageId\`. Use for "monthly won-deal value YTD", "deals created per week in Q1", "ICFF leads converted by month".
  • **\`pipedrive.pipeline_snapshot\`** — point-in-time funnel: count + total value per stage. Args: optional \`pipelineId\`, optional \`ownerId\`, \`status\` (open|won|lost|all, default open). Use for "open deals by stage now", "Made pipeline funnel", "stuck deals — biggest count by stage".
  • **\`pipedrive.list_deals\`** — cursor-paginated list with all analytical fields. Hard cap 500/call. Filter by status, pipeline, stage, owner, org, person, sourceOptionId. Custom fields pre-resolved (sourceLabel, specifierOrgName, purchaserOrgName). Use for "top 20 open deals by value", "lost deals last month with reasons".
  • **\`pipedrive.deal_detail\`** — single deal with all fields including resolved custom fields, linked person + org, last activity. Use for "show me deal 816", "context on the KBM-Hogue deal".
  • **\`pipedrive.organization_performance\`** — top orgs by won_value/won_count/open_value over a window. Use for "top firms by trade revenue YTD", "customer concentration", "repeat buyers in Q1".
  • **\`pipedrive.organization_detail\`** — single org with deals + contacts + optional activities. Use for "tell me about Rarify — who's our contact, what's open".
  • **\`pipedrive.lost_reasons_breakdown\`** — lost deals grouped by \`lost_reason\` (optionally + stage). Use for "why did we lose Q1 deals", "lost reasons in Wholesale physical pipeline last quarter".
  • **\`pipedrive.activity_summary\`** — call/meeting/email/task volume by user/type/status. Use for "how many calls did Max log in March", "meeting trend last 6 months".
  • **\`pipedrive.user_performance\`** — sales-rep leaderboard for the window (won_value, won_count, activities_done, avg_deal_value). Use for "top performer last quarter", "who closed the most deals in March".
  • **Custom fields**: 3 user-visible — Specifier (firm acting as project specifier), Purchaser (firm placing the order), Source (enum: ICFF, Design Miami, Neocon, Holland, Steph, Opensend, Gantri Trade Sign Up, Shop Walk In, Rep Group NY, Rep Group SF, Inbound Email, BDNY, Shop Events, Max, Other). Filter \`pipedrive.list_deals\` by sourceOptionId; the source LABEL is also pre-resolved as \`sourceLabel\` on each row.
  • **Cross-pipeline pitfalls**: Pipeline 1 (Collection) and Pipeline 2 (Made) share stage names ("Opportunity", "Quoted", "Booked"). Pipeline 3 (Wholesale physical) and Pipeline 4 (Wholesale dropship) share "Contact Made"/"Discovery"/"Goals". When the user mentions a stage name, ALWAYS pass \`pipelineId\` too — otherwise the filter is ambiguous.
  • **Truncation flag**: tools that paginate /v2/deals or /v1/activities return \`truncated: true\` when the 10-page (≈5000-record) cap is hit. Surface that to the user; suggest narrowing the date range or filtering by pipeline/owner.
  • **Pipedrive vs Northbeam**: NB does not see B2B trade pipeline data. Use Pipedrive for "open pipeline value", "deals by stage", "rep performance"; use NB for "ad-attributed revenue", "ROAS by channel".
`;
```

Make sure to keep the existing `*5d. Google Search Console …` paragraph intact, just renamed to `*5e.`.

- [ ] **Step 5: Update the date-range invariant test to import Pipedrive**

In `tests/unit/connectors/base/date-range-invariant.test.ts`, find the existing imports at the top:
```ts
import * as klaviyo from '../../../../src/connectors/klaviyo/connector.js';
```

After it, add:
```ts
import * as pipedrive from '../../../../src/connectors/pipedrive/connector.js';
```

Find the `inspectionEntries` array. After the klaviyo entry:
```ts
  { moduleName: 'klaviyo', mod: klaviyo, instances: [
    new klaviyo.KlaviyoConnector({} as never),
  ]},
```

Add:
```ts
  { moduleName: 'pipedrive', mod: pipedrive, instances: [
    new pipedrive.PipedriveConnector({} as never),
  ]},
```

- [ ] **Step 6: Run the full validation suite**

Run: `npx vitest run`
Expected: PASS — including the date-range invariant generating new cases for every Pipedrive tool that takes `dateRange`.

Run: `npx tsc --noEmit`
Expected: PASS.

Run: `npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/reports/live/spec.ts src/connectors/live-reports/tool-output-shapes.ts src/orchestrator/prompts.ts tests/unit/connectors/base/date-range-invariant.test.ts
git commit -m "feat(pipedrive): wire-up + Live Reports whitelist + prompts"
```

---

## Task 14: Validation + smoke test

**Files:**
- No code changes — verification only.

- [ ] **Step 1: Confirm Supabase vault has the secret**

Run:
```bash
echo "Manual step: confirm via mcp__supabase__execute_sql on project ykjjwszoxazzlcovhlgd that the vault contains a row with name='PIPEDRIVE_API_TOKEN'. If not, insert it: SELECT vault.create_secret('<actual_token_from_lana>', 'PIPEDRIVE_API_TOKEN');"
```

Expected: secret present (or inserted in this step). Document the new key under `reference_gantri_ai_bot_deploy.md` MEMORY entry.

- [ ] **Step 2: Run the full unit suite**

Run: `npx vitest run`
Expected: All tests PASS, including:
- `tests/unit/connectors/pipedrive/client.test.ts` (≥10 tests)
- `tests/unit/connectors/pipedrive/connector.test.ts` (≥15 tests)
- `tests/unit/connectors/base/date-range-invariant.test.ts` — the auto-generated cases for every Pipedrive tool with `dateRange` PASS for all three input shapes.

- [ ] **Step 3: Run the date-range invariant in isolation**

Run: `npx vitest run tests/unit/connectors/base/date-range-invariant.test.ts`
Expected: PASS. Each whitelisted Pipedrive tool generates 3 new cases (preset string / object literal / JSON-stringified object).

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: PASS, no errors.

- [ ] **Step 5: Deploy**

Run: `fly deploy`
Expected: "Machine ... is now in a good state". Watch for `pipedrive connector registered` in the boot logs.

- [ ] **Step 6: Hit /healthz and /readyz**

Run:
```bash
curl -sS https://gantri-ai-bot.fly.dev/healthz
curl -sS https://gantri-ai-bot.fly.dev/readyz
```
Expected: `/healthz` returns `{"ok":true}`. `/readyz` exercises NB + GP + GF (Pipedrive isn't in the readyz set today; that's intentional — readyz is for boot-critical connectors).

- [ ] **Step 7: Smoke test from Slack — one tool per category**

DM the bot from Danny's account in this exact order. After each, capture the response in a scratch note (expected vs actual):

1. **Discovery — `list_directory`**: `"What pipelines are in Pipedrive?"` → expect 4 rows (Collection, Made, Wholesale physical, Wholesale dropship).
2. **Discovery — `search`**: `"Find KBM-Hogue in Pipedrive"` → expect ≥1 row with `type: deal`.
3. **Aggregation — `deal_timeseries`**: `"Monthly won-deal value YTD in Pipedrive"` → expect rows for 2026-01-01 / 02-01 / 03-01 / 04-01 with non-zero `wonValueUsd`.
4. **Aggregation — `pipeline_snapshot`**: `"Open Pipedrive funnel for Wholesale physical pipeline"` → rows by stage with totals.
5. **Deal — `list_deals`**: `"Top 10 open Pipedrive deals by value"` → expect 10 rows sorted desc.
6. **Deal — `deal_detail`**: pick a `dealId` from step 5, ask `"Detail on Pipedrive deal <id>"` → expect orgDetail/lastActivity/customFields populated.
7. **Org — `organization_performance`**: `"Top 10 Pipedrive firms by won revenue YTD"` → rows sorted desc.
8. **Org — `organization_detail`**: pick orgId from step 7, ask `"Tell me about Pipedrive org <id>"` → expect deals + persons.
9. **Lost — `lost_reasons_breakdown`**: `"Why did we lose Pipedrive deals in Q1?"` → rows by reason.
10. **Activity — `activity_summary`**: `"How many activities did Pipedrive users log in April?"` → byUser breakdown.
11. **Productivity — `user_performance`**: `"Top Pipedrive performer YTD by won value"` → rows sorted desc with rank.

Acceptance: each call returns a sensible (non-error) response within ~5s. If any tool errors, capture the response body and grep Fly logs for `pipedrive api error`.

- [ ] **Step 8: Build a Live Report touching one Pipedrive tool**

DM the bot: `"Build a live report titled 'Pipedrive Pipeline Snapshot' showing the open-deal funnel by stage for the Wholesale physical pipeline."`

Expected: the bot replies with a published-report URL. Open it, confirm a chart/table renders with stage rows.

If the live-reports compiler refuses to load, the most likely cause is a missing entry in `tool-output-shapes.ts` — re-check Task 13 step 3.

- [ ] **Step 9: Commit any deploy-driven follow-ups**

If steps 7–8 surfaced fixes, commit them with a focused message (e.g., `fix(pipedrive): map deal value to USD when currency missing`). Otherwise skip — there's nothing to commit, the deploy succeeded.

- [ ] **Step 10: Notify stakeholder**

Reply on the original thread that drove this work (the Pipedrive connector design discussion) with: shipped tools list, sample Slack queries, and the live-report URL from step 8.

---

## Self-review

**1. Spec coverage:**

| Spec section | Task |
|---|---|
| Goal: 11 tools | Tasks 8–12 cover all 11 |
| Tenant facts: 4 pipelines, USD-only, custom fields, source enum | Task 8 (`list_directory` exposes pipelines/stages/source_options); Task 7 (custom-field resolver by hash) |
| API surface: v1 + v2 mix | Tasks 4 (v1 timeline/summary), 5 (v2 deals/orgs/persons + v1 activities), 6 (v2 deal/org details + v1 itemSearch) |
| Auth: header, never query param | Task 2 |
| Rate limit: retry once on 429 | Task 2 |
| Date format: ISO 8601 → PT bucketing | Task 9 (timeseries), 12 (activity_summary uses weekStart/YMD slice) |
| Architecture: no rollup table, all live | Confirmed — no migrations, no job class |
| Client design (constructor + 14 methods) | Tasks 2–6 |
| Error handling table | Task 2 (PipedriveApiError, retry, 4xx/5xx); pagination cap surfaces `truncated:true` (Tasks 9, 10, 11, 12) |
| Custom field resolution by hash → name | Task 7 (`resolveCustomFieldValues`), Task 10 (list_deals + deal_detail use it) |
| Tool 1 list_directory | Task 8 |
| Tool 2 search | Task 8 |
| Tool 3 deal_timeseries | Task 9 |
| Tool 4 pipeline_snapshot | Task 9 |
| Tool 5 list_deals | Task 10 |
| Tool 6 deal_detail | Task 10 |
| Tool 7 organization_performance | Task 11 |
| Tool 8 organization_detail | Task 11 |
| Tool 9 lost_reasons_breakdown | Task 12 |
| Tool 10 activity_summary | Task 12 |
| Tool 11 user_performance | Task 12 |
| Test: client cache 1-fetch-for-2-calls | Task 3 |
| Test: 10-min TTL expiration | Task 3 |
| Test: pagination respects maxPages | Task 2 |
| Test: 401 throws | Task 2 |
| Test: 429 retry | Task 2 |
| Test: dealsTimeline shape parsing | Task 4 |
| Test: every tool happy path with stubbed client | Tasks 8–12 |
| Test: every dateRange tool accepts preset string | Tasks 9, 10, 11, 12 + invariant test (Task 13) |
| Live Reports whitelist (all 11) | Task 13 step 2 |
| Output samples (all 11) | Task 13 step 3 |
| LLM prompt docs (new section) | Task 13 step 4 |
| Validation: full suite + invariant + typecheck + build | Task 14 steps 2–4 |
| Smoke: one tool per category against real API | Task 14 step 7 |

**Gaps**: none. Spec ↔ task mapping is 1:1.

Notable scope decisions documented inline:
- `deal_timeseries` doesn't natively accept `sourceOptionId` (Pipedrive's /v1/deals/timeline doesn't expose it). The tool emits a `note` instead of silently ignoring. The LLM is told to fall back to `list_deals` + client-side group when source-filtering is required.
- `list_deals` does client-side date filtering (v2 has no clean range filter on `add_time`). Pagination is bounded so the worst case is 5000 deals + a YMD compare per row.
- `deal_detail` activities filter is client-side (v1 /activities lacks `deal_id` server filter in our hot path). It's bounded by the 10-page cap.

**2. Placeholder scan**: searched for "TBD", "TODO", "implement later", "fill in details", "appropriate error handling", "similar to Task". None present. Every step has actual code or actual command.

**3. Type consistency**: spot-checked across tasks:
- `Deal.value`: number on the wire, coerced via `Number(d.value) || 0` in every consumer (Tasks 9, 10, 11, 12). ✓
- `Deal.org_id`: union `number | { value, name } | null` — every tool that reads it does the `typeof === 'object'` guard (Tasks 10, 11). ✓
- `Stage.pipeline_id`: number on the wire, used as Map key in Tasks 8, 9. ✓
- `TimelineBucket` field names (`total_value_usd`, `won_value_usd`, etc.) match between client (Task 4) and connector usage (Tasks 9, 12). ✓
- `paginate` return type `{ items, hasMore }` consistent everywhere. ✓
- `pipedriveErrorResult` returns `{ ok: false, error: { code, ... } }` matching the registry's `ToolResult` contract. ✓
- `PipedriveConnectorDeps` shape matches the date-range invariant test stub (`{} as never`). ✓
- Tool names in `WHITELISTED_TOOLS` (Task 13 step 2) match the `name` strings in each tool definition (Tasks 8–12). ✓
- Output sample top-level keys in Task 13 step 3 match what the tool actually returns in Tasks 8–12. ✓
