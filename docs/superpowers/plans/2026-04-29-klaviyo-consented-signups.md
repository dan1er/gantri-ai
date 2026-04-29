# Klaviyo Consented Signups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `klaviyo.consented_signups` tool that returns counts of profiles created in a window AND currently subscribed to email marketing, with daily/weekly/monthly granularity, backed by a nightly rollup table.

**Architecture:** A nightly job paginates Klaviyo's `/api/profiles` for all profiles since 2020, buckets by Pacific Time day, counts total signups and currently-consented signups per day, and upserts into `klaviyo_signups_daily`. A whitelisted Live-Reports tool reads the rollup, aggregates day → week/month in JS, and returns `{rows, rollup_freshness, note}`. Drift-tolerant: counts for past months can decrease as profiles unsubscribe (matches the upstream puller behavior Lana validates against).

**Tech Stack:** TypeScript, Supabase (Postgres), Klaviyo Profiles API (revision 2026-04-15), Vitest, Pino logger.

---

## File Structure

| Type | Path | Responsibility |
|---|---|---|
| New | `migrations/0012_klaviyo_signups_daily.sql` | Rollup table + index |
| New | `src/storage/repositories/klaviyo-signup-rollup.ts` | DB access (upsertManyDays, getRange, latestDay, count) |
| Extend | `src/connectors/klaviyo/client.ts` | Add `KlaviyoProfileAttrs` interface, `searchProfilesByCreatedRange()`, internal `paginateUnbounded<T>()` helper |
| New | `src/connectors/klaviyo/signup-rollup-job.ts` | Job class with `start/stop/run/tickIfDue` |
| Extend | `src/connectors/klaviyo/connector.ts` | Add `klaviyo.consented_signups` tool, migrate connector to shared `DateRangeArg` |
| Extend | `src/index.ts` | Instantiate repo + job, wire job into startup, pass repo into KlaviyoConnector |
| Extend | `src/reports/live/spec.ts` | Whitelist `klaviyo.consented_signups` |
| Extend | `src/orchestrator/prompts.ts` | Document the tool |
| New | `tests/unit/storage/klaviyo-signup-rollup.test.ts` | Repo unit tests |
| New | `tests/unit/connectors/klaviyo/signup-rollup-job.test.ts` | Job unit tests |
| Extend | `tests/unit/connectors/klaviyo/connector.test.ts` | Tool unit tests |
| Extend | `tests/unit/connectors/klaviyo/client.test.ts` (create if missing) | Client unit tests for new method |

---

## Task 1: Migration — `klaviyo_signups_daily` table

**Files:**
- Create: `migrations/0012_klaviyo_signups_daily.sql`

- [ ] **Step 1: Write the SQL**

Create `migrations/0012_klaviyo_signups_daily.sql`:

```sql
-- One row per Pacific-Time calendar day. `signups_total` is profiles whose
-- `created` timestamp falls in that PT day. `signups_consented_email` is the
-- subset whose subscriptions.email.marketing.consent equals 'SUBSCRIBED' at
-- the moment the rollup ran (drift-tolerant by design).
create table if not exists klaviyo_signups_daily (
  day date primary key,
  signups_total integer not null default 0,
  signups_consented_email integer not null default 0,
  computed_at timestamptz not null default now()
);

create index if not exists klaviyo_signups_daily_computed_at_idx
  on klaviyo_signups_daily (computed_at);
```

- [ ] **Step 2: Apply the migration to Supabase**

Use the Supabase MCP tool to apply:

```
mcp__supabase__apply_migration project_id=ykjjwszoxazzlcovhlgd name="0012_klaviyo_signups_daily" query=<contents of the SQL file>
```

Expected: migration succeeds, table exists in `public` schema.

- [ ] **Step 3: Verify table exists**

Run via Supabase MCP:

```sql
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_name = 'klaviyo_signups_daily'
order by ordinal_position;
```

Expected output: 4 rows (day, signups_total, signups_consented_email, computed_at) with the right types.

- [ ] **Step 4: Commit**

```bash
git add migrations/0012_klaviyo_signups_daily.sql
git commit -m "feat: add klaviyo_signups_daily rollup table"
```

---

## Task 2: Rollup Repository

**Files:**
- Create: `src/storage/repositories/klaviyo-signup-rollup.ts`
- Create: `tests/unit/storage/klaviyo-signup-rollup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/storage/klaviyo-signup-rollup.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KlaviyoSignupRollupRepo } from '../../../src/storage/repositories/klaviyo-signup-rollup.js';

function makeFakeSupabase() {
  const tables = new Map<string, Map<string, unknown>>();
  const get = (t: string) => {
    if (!tables.has(t)) tables.set(t, new Map());
    return tables.get(t)!;
  };
  return {
    tables,
    from(table: string) {
      const rows = get(table);
      const ctx: { _filters: Array<(r: any) => boolean>; _selectCols?: string } = { _filters: [] };
      const builder: any = {
        upsert(payload: any) {
          const arr = Array.isArray(payload) ? payload : [payload];
          for (const r of arr) rows.set(String((r as any).day), { ...(r as any), computed_at: new Date().toISOString() });
          return Promise.resolve({ error: null });
        },
        select(cols?: string) {
          ctx._selectCols = cols;
          return builder;
        },
        gte(col: string, val: any) { ctx._filters.push((r: any) => r[col] >= val); return builder; },
        lte(col: string, val: any) { ctx._filters.push((r: any) => r[col] <= val); return builder; },
        order() { return builder; },
        single() {
          const list = [...rows.values()].filter((r: any) => ctx._filters.every((f) => f(r)));
          return Promise.resolve({ data: list[0] ?? null, error: null });
        },
        then(resolve: any) {
          const list = [...rows.values()].filter((r: any) => ctx._filters.every((f) => f(r)));
          if (ctx._selectCols === 'count') return resolve({ count: list.length, error: null });
          return resolve({ data: list, error: null });
        },
      };
      return builder;
    },
  } as any;
}

describe('KlaviyoSignupRollupRepo', () => {
  let supabase: ReturnType<typeof makeFakeSupabase>;
  let repo: KlaviyoSignupRollupRepo;

  beforeEach(() => {
    supabase = makeFakeSupabase();
    repo = new KlaviyoSignupRollupRepo(supabase);
  });

  it('upserts and reads back rows in a date range', async () => {
    await repo.upsertManyDays([
      { day: '2026-01-01', signupsTotal: 10, signupsConsentedEmail: 7 },
      { day: '2026-01-02', signupsTotal: 5, signupsConsentedEmail: 4 },
      { day: '2026-02-01', signupsTotal: 8, signupsConsentedEmail: 5 },
    ]);
    const rows = await repo.getRange('2026-01-01', '2026-01-31');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.day === '2026-01-01')).toMatchObject({ signupsTotal: 10, signupsConsentedEmail: 7 });
  });

  it('upsert is idempotent (re-upserting same day overwrites)', async () => {
    await repo.upsertManyDays([{ day: '2026-01-01', signupsTotal: 10, signupsConsentedEmail: 7 }]);
    await repo.upsertManyDays([{ day: '2026-01-01', signupsTotal: 12, signupsConsentedEmail: 9 }]);
    const rows = await repo.getRange('2026-01-01', '2026-01-01');
    expect(rows).toHaveLength(1);
    expect(rows[0].signupsTotal).toBe(12);
    expect(rows[0].signupsConsentedEmail).toBe(9);
  });

  it('getRange returns empty array when no rows match', async () => {
    const rows = await repo.getRange('2030-01-01', '2030-12-31');
    expect(rows).toEqual([]);
  });

  it('upsertManyDays with empty array is a no-op', async () => {
    await expect(repo.upsertManyDays([])).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npx vitest run tests/unit/storage/klaviyo-signup-rollup.test.ts
```

Expected: FAIL with "Cannot find module '../../../src/storage/repositories/klaviyo-signup-rollup.js'".

- [ ] **Step 3: Implement the repo**

Create `src/storage/repositories/klaviyo-signup-rollup.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';

export interface KlaviyoSignupRollupRow {
  day: string; // YYYY-MM-DD
  signupsTotal: number;
  signupsConsentedEmail: number;
  computedAt: string; // ISO 8601
}

export interface KlaviyoSignupRollupUpsert {
  day: string;
  signupsTotal: number;
  signupsConsentedEmail: number;
}

export class KlaviyoSignupRollupRepo {
  constructor(private readonly db: SupabaseClient) {}

  async upsertManyDays(rows: KlaviyoSignupRollupUpsert[]): Promise<void> {
    if (rows.length === 0) return;
    const payload = rows.map((r) => ({
      day: r.day,
      signups_total: r.signupsTotal,
      signups_consented_email: r.signupsConsentedEmail,
      computed_at: new Date().toISOString(),
    }));
    const { error } = await this.db.from('klaviyo_signups_daily').upsert(payload);
    if (error) throw new Error(`klaviyo_signups_daily upsert failed: ${error.message}`);
  }

  async getRange(startDate: string, endDate: string): Promise<KlaviyoSignupRollupRow[]> {
    const { data, error } = await this.db
      .from('klaviyo_signups_daily')
      .select('day,signups_total,signups_consented_email,computed_at')
      .gte('day', startDate)
      .lte('day', endDate)
      .order('day', { ascending: true });
    if (error) throw new Error(`klaviyo_signups_daily getRange failed: ${error.message}`);
    return ((data as Array<{ day: string; signups_total: number; signups_consented_email: number; computed_at: string }>) ?? []).map((r) => ({
      day: r.day,
      signupsTotal: r.signups_total,
      signupsConsentedEmail: r.signups_consented_email,
      computedAt: r.computed_at,
    }));
  }

  async latestDay(): Promise<string | null> {
    const { data, error } = await this.db
      .from('klaviyo_signups_daily')
      .select('day')
      .order('day', { ascending: false })
      .limit(1)
      .single();
    if (error && error.code !== 'PGRST116') throw new Error(`klaviyo_signups_daily latestDay failed: ${error.message}`);
    return (data as { day?: string } | null)?.day ?? null;
  }

  async count(): Promise<number> {
    const { count, error } = await this.db
      .from('klaviyo_signups_daily')
      .select('count', { count: 'exact', head: true });
    if (error) throw new Error(`klaviyo_signups_daily count failed: ${error.message}`);
    return count ?? 0;
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
npx vitest run tests/unit/storage/klaviyo-signup-rollup.test.ts
```

Expected: 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/storage/repositories/klaviyo-signup-rollup.ts tests/unit/storage/klaviyo-signup-rollup.test.ts
git commit -m "feat: add KlaviyoSignupRollupRepo"
```

---

## Task 3: Klaviyo Client — Profiles search by created range

**Files:**
- Modify: `src/connectors/klaviyo/client.ts`
- Create or extend: `tests/unit/connectors/klaviyo/client.test.ts`

- [ ] **Step 1: Read the existing client**

Open `src/connectors/klaviyo/client.ts` and locate the `paginate<T>()` method (currently capped at 50 pages). Note its exact signature so the new helper matches the conventions (auth header, base URL, response shape).

- [ ] **Step 2: Write the failing tests**

Open `tests/unit/connectors/klaviyo/client.test.ts` (create if it doesn't exist):

```ts
import { describe, it, expect, vi } from 'vitest';
import { KlaviyoApiClient } from '../../../../src/connectors/klaviyo/client.js';

describe('KlaviyoApiClient.searchProfilesByCreatedRange', () => {
  it('builds the filter and additional-fields query string correctly and walks pagination unbounded', async () => {
    const fetchImpl = vi.fn();
    let call = 0;
    fetchImpl.mockImplementation(async (url: string) => {
      call++;
      const u = new URL(url);
      if (call === 1) {
        // First call: verify filter + additional-fields
        const filter = u.searchParams.get('filter');
        expect(filter).toBe('and(greater-or-equal(created,2026-01-01T00:00:00.000Z),less-than(created,2026-02-01T00:00:00.000Z))');
        expect(u.searchParams.get('additional-fields[profile]')).toBe('subscriptions');
        return new Response(JSON.stringify({
          data: [{ id: '1', type: 'profile', attributes: { created: '2026-01-15T10:00:00.000Z', subscriptions: { email: { marketing: { consent: 'SUBSCRIBED' } } } } }],
          links: { next: 'https://a.klaviyo.com/api/profiles?page[cursor]=p2' },
        }), { status: 200 });
      }
      if (call === 2) {
        return new Response(JSON.stringify({
          data: [{ id: '2', type: 'profile', attributes: { created: '2026-01-20T10:00:00.000Z', subscriptions: null } }],
          links: { next: 'https://a.klaviyo.com/api/profiles?page[cursor]=p3' },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: '3', type: 'profile', attributes: { created: '2026-01-25T10:00:00.000Z' } }], links: {} }), { status: 200 });
    });

    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    const profiles = await client.searchProfilesByCreatedRange({ startDate: '2026-01-01', endDate: '2026-01-31' });
    expect(profiles).toHaveLength(3);
    expect(profiles.map((p) => p.id)).toEqual(['1', '2', '3']);
    expect(call).toBe(3);
  });

  it('throws if pagination exceeds the 10000-page sanity cap', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(
      JSON.stringify({ data: [{ id: 'x', type: 'profile', attributes: { created: '2026-01-15T10:00:00.000Z' } }], links: { next: 'https://a.klaviyo.com/api/profiles?page[cursor]=loop' } }),
      { status: 200 },
    ));
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    await expect(client.searchProfilesByCreatedRange({ startDate: '2026-01-01', endDate: '2026-01-31' }))
      .rejects.toThrow(/sanity cap/);
  });
});
```

- [ ] **Step 3: Run tests, verify they fail**

```bash
npx vitest run tests/unit/connectors/klaviyo/client.test.ts
```

Expected: FAIL with "client.searchProfilesByCreatedRange is not a function".

- [ ] **Step 4: Add the type and method**

In `src/connectors/klaviyo/client.ts`, add the `KlaviyoProfileAttrs` interface near the other resource attribute types:

```ts
export interface KlaviyoProfileAttrs {
  email?: string | null;
  created: string; // ISO 8601
  updated?: string;
  subscriptions?: {
    email?: { marketing?: { consent?: string; consent_timestamp?: string } };
    sms?: unknown;
  } | null;
}
```

Add `searchProfilesByCreatedRange` as a public method:

```ts
async searchProfilesByCreatedRange(opts: { startDate: string; endDate: string }): Promise<KlaviyoResource<KlaviyoProfileAttrs>[]> {
  const startISO = `${opts.startDate}T00:00:00.000Z`;
  // Klaviyo's `less-than` is exclusive. Convert end (inclusive YMD) to next-day midnight UTC.
  const endExclusive = addDaysYmd(opts.endDate, 1);
  const endISO = `${endExclusive}T00:00:00.000Z`;
  const filter = `and(greater-or-equal(created,${startISO}),less-than(created,${endISO}))`;
  const params = new URLSearchParams();
  params.set('filter', filter);
  params.set('additional-fields[profile]', 'subscriptions');
  return this.paginateUnbounded<KlaviyoProfileAttrs>(`/api/profiles?${params.toString()}`);
}
```

Add the helper functions at the bottom of the file (or in a private method on the class):

```ts
function addDaysYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
```

Add the unbounded paginate helper. If the existing `paginate<T>()` method is private, add a sibling private method:

```ts
private async paginateUnbounded<TAttrs>(initialPath: string): Promise<KlaviyoResource<TAttrs>[]> {
  const SANITY_CAP = 10000;
  const out: KlaviyoResource<TAttrs>[] = [];
  let url = `${this.baseUrl}${initialPath}`;
  let pageNum = 0;
  while (url) {
    if (pageNum >= SANITY_CAP) {
      throw new KlaviyoApiError(0, null, `paginateUnbounded exceeded ${SANITY_CAP}-page sanity cap; aborting`);
    }
    const res = await this.fetchImpl(url, { headers: this.authHeaders() });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new KlaviyoApiError(res.status, body, `Klaviyo paginated GET ${url} -> ${res.status}`);
    }
    const json = (await res.json()) as { data: KlaviyoResource<TAttrs>[]; links?: { next?: string } };
    out.push(...(json.data ?? []));
    url = json.links?.next ?? '';
    pageNum++;
  }
  return out;
}
```

(If `this.baseUrl`, `this.fetchImpl`, `this.authHeaders()` are named differently in the existing client, match the actual names while keeping the same flow.)

- [ ] **Step 5: Run tests, verify they pass**

```bash
npx vitest run tests/unit/connectors/klaviyo/client.test.ts
```

Expected: 2 tests passing.

- [ ] **Step 6: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/connectors/klaviyo/client.ts tests/unit/connectors/klaviyo/client.test.ts
git commit -m "feat: add KlaviyoApiClient.searchProfilesByCreatedRange with unbounded pagination"
```

---

## Task 4: Signup Rollup Job

**Files:**
- Create: `src/connectors/klaviyo/signup-rollup-job.ts`
- Create: `tests/unit/connectors/klaviyo/signup-rollup-job.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/connectors/klaviyo/signup-rollup-job.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { KlaviyoSignupRollupJob } from '../../../../src/connectors/klaviyo/signup-rollup-job.js';

function makeProfile(id: string, createdISO: string, consent?: string) {
  return {
    id,
    type: 'profile' as const,
    attributes: {
      created: createdISO,
      subscriptions: consent
        ? { email: { marketing: { consent } } }
        : null,
    },
  };
}

function makeRepo() {
  const upserts: Array<Array<{ day: string; signupsTotal: number; signupsConsentedEmail: number }>> = [];
  return {
    upserts,
    upsertManyDays: vi.fn(async (rows) => { upserts.push(rows); }),
    getRange: vi.fn(),
    latestDay: vi.fn(),
    count: vi.fn(),
  };
}

describe('KlaviyoSignupRollupJob', () => {
  it('counts SUBSCRIBED profiles as consented and others as total-only', async () => {
    const client = {
      searchProfilesByCreatedRange: vi.fn().mockResolvedValue([
        makeProfile('1', '2026-01-15T20:00:00.000Z', 'SUBSCRIBED'),  // PT day = 2026-01-15
        makeProfile('2', '2026-01-15T21:00:00.000Z', 'UNSUBSCRIBED'), // PT day = 2026-01-15
        makeProfile('3', '2026-01-15T22:00:00.000Z'),                  // no subscriptions
      ]),
    } as any;
    const repo = makeRepo();
    const job = new KlaviyoSignupRollupJob({ client, repo: repo as any });
    const result = await job.run();
    expect(result.profilesSeen).toBe(3);
    expect(repo.upsertManyDays).toHaveBeenCalledOnce();
    const rows = repo.upserts[0];
    const jan15 = rows.find((r) => r.day === '2026-01-15');
    expect(jan15).toEqual({ day: '2026-01-15', signupsTotal: 3, signupsConsentedEmail: 1 });
  });

  it('buckets by Pacific Time, not UTC', async () => {
    const client = {
      // 2026-01-01T05:00:00Z = 2025-12-31 21:00 PT (Dec 31 PT bucket)
      searchProfilesByCreatedRange: vi.fn().mockResolvedValue([
        makeProfile('1', '2026-01-01T05:00:00.000Z', 'SUBSCRIBED'),
      ]),
    } as any;
    const repo = makeRepo();
    const job = new KlaviyoSignupRollupJob({ client, repo: repo as any });
    await job.run();
    const rows = repo.upserts[0];
    expect(rows[0].day).toBe('2025-12-31');
  });

  it('skips profiles with malformed `created`', async () => {
    const client = {
      searchProfilesByCreatedRange: vi.fn().mockResolvedValue([
        { id: '1', type: 'profile', attributes: { created: 'not-a-date' } },
        makeProfile('2', '2026-01-15T20:00:00.000Z', 'SUBSCRIBED'),
      ]),
    } as any;
    const repo = makeRepo();
    const job = new KlaviyoSignupRollupJob({ client, repo: repo as any });
    const result = await job.run();
    expect(result.profilesSeen).toBe(2);
    const rows = repo.upserts[0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ day: '2026-01-15', signupsTotal: 1, signupsConsentedEmail: 1 });
  });

  it('absorbs unsubscribe drift on re-run', async () => {
    // Run 1: profile is SUBSCRIBED → consented = 1
    const client1 = {
      searchProfilesByCreatedRange: vi.fn().mockResolvedValue([makeProfile('1', '2026-01-15T20:00:00.000Z', 'SUBSCRIBED')]),
    } as any;
    const repo = makeRepo();
    const job1 = new KlaviyoSignupRollupJob({ client: client1, repo: repo as any });
    await job1.run();
    expect(repo.upserts[0][0].signupsConsentedEmail).toBe(1);

    // Run 2: same profile is now UNSUBSCRIBED → consented = 0
    const client2 = {
      searchProfilesByCreatedRange: vi.fn().mockResolvedValue([makeProfile('1', '2026-01-15T20:00:00.000Z', 'UNSUBSCRIBED')]),
    } as any;
    const job2 = new KlaviyoSignupRollupJob({ client: client2, repo: repo as any });
    await job2.run();
    expect(repo.upserts[1][0].signupsConsentedEmail).toBe(0);
  });

  it('returns zeros and logs error when client throws (does not crash)', async () => {
    const client = {
      searchProfilesByCreatedRange: vi.fn().mockRejectedValue(new Error('rate limited')),
    } as any;
    const repo = makeRepo();
    const job = new KlaviyoSignupRollupJob({ client, repo: repo as any });
    const result = await job.run();
    expect(result).toEqual({ daysWritten: 0, profilesSeen: 0 });
    expect(repo.upsertManyDays).not.toHaveBeenCalled();
  });

  it('serializes overlapping run() calls (second returns 0)', async () => {
    let resolveFirst: () => void = () => {};
    const client = {
      searchProfilesByCreatedRange: vi.fn().mockImplementation(() => new Promise((resolve) => {
        resolveFirst = () => resolve([makeProfile('1', '2026-01-15T20:00:00.000Z', 'SUBSCRIBED')]);
      })),
    } as any;
    const repo = makeRepo();
    const job = new KlaviyoSignupRollupJob({ client, repo: repo as any });
    const p1 = job.run();
    const p2 = job.run();
    resolveFirst();
    const r1 = await p1;
    const r2 = await p2;
    expect(r1.profilesSeen).toBe(1);
    expect(r2.profilesSeen).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
npx vitest run tests/unit/connectors/klaviyo/signup-rollup-job.test.ts
```

Expected: FAIL with "Cannot find module '.../signup-rollup-job.js'".

- [ ] **Step 3: Implement the job**

Create `src/connectors/klaviyo/signup-rollup-job.ts`:

```ts
import type { KlaviyoApiClient } from './client.js';
import type { KlaviyoSignupRollupRepo, KlaviyoSignupRollupUpsert } from '../../storage/repositories/klaviyo-signup-rollup.js';
import { logger } from '../../logger.js';

const PT_TZ = 'America/Los_Angeles';
const HISTORY_START = '2020-01-01';

export interface KlaviyoSignupRollupJobDeps {
  client: KlaviyoApiClient;
  repo: KlaviyoSignupRollupRepo;
}

export class KlaviyoSignupRollupJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: KlaviyoSignupRollupJobDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tickIfDue(); }, 15 * 60 * 1000);
    logger.info({}, 'klaviyo signup rollup job started (15-min poll, fires at 03:00 PT)');
    void this.run().catch((err) => logger.error({ err: err instanceof Error ? err.stack : String(err) }, 'initial klaviyo signup rollup failed'));
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tickIfDue(): Promise<void> {
    if (this.running) return;
    const hourPt = parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: PT_TZ, hour: '2-digit', hour12: false })
        .format(new Date())
        .replace(/\D/g, ''),
      10,
    );
    if (hourPt !== 3) return;
    await this.run();
  }

  async run(): Promise<{ daysWritten: number; profilesSeen: number }> {
    if (this.running) return { daysWritten: 0, profilesSeen: 0 };
    this.running = true;
    const started = Date.now();
    try {
      const startDate = HISTORY_START;
      const endDate = ptDayOf(new Date(Date.now() - 24 * 3600 * 1000));
      logger.info({ startDate, endDate }, 'klaviyo_signup_rollup_started');

      const profiles = await this.deps.client.searchProfilesByCreatedRange({ startDate, endDate });

      const counts = new Map<string, { total: number; consented: number }>();
      for (const p of profiles) {
        const created = p.attributes?.created;
        if (typeof created !== 'string') continue;
        const t = Date.parse(created);
        if (!Number.isFinite(t)) continue;
        const day = ptDayOf(new Date(t));
        const consent = p.attributes?.subscriptions?.email?.marketing?.consent === 'SUBSCRIBED';
        const cur = counts.get(day) ?? { total: 0, consented: 0 };
        cur.total++;
        if (consent) cur.consented++;
        counts.set(day, cur);
      }

      const upserts: KlaviyoSignupRollupUpsert[] = [];
      for (const [day, c] of counts) {
        upserts.push({ day, signupsTotal: c.total, signupsConsentedEmail: c.consented });
      }
      await this.deps.repo.upsertManyDays(upserts);

      const durationMs = Date.now() - started;
      logger.info({ profilesSeen: profiles.length, daysUpserted: upserts.length, durationMs }, 'klaviyo_signup_rollup_completed');
      return { daysWritten: upserts.length, profilesSeen: profiles.length };
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.stack : String(err) }, 'klaviyo_signup_rollup_failed');
      return { daysWritten: 0, profilesSeen: 0 };
    } finally {
      this.running = false;
    }
  }
}

function ptDayOf(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: PT_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
npx vitest run tests/unit/connectors/klaviyo/signup-rollup-job.test.ts
```

Expected: 6 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/klaviyo/signup-rollup-job.ts tests/unit/connectors/klaviyo/signup-rollup-job.test.ts
git commit -m "feat: add KlaviyoSignupRollupJob"
```

---

## Task 5: Connector tool — `klaviyo.consented_signups`

**Files:**
- Modify: `src/connectors/klaviyo/connector.ts`
- Modify: `tests/unit/connectors/klaviyo/connector.test.ts`

- [ ] **Step 1: Read the current connector**

Read `src/connectors/klaviyo/connector.ts`. Note:
- The current `KlaviyoConnector` constructor signature (deps).
- The current local `DateRange` schema definition.
- The pattern for declaring tools (name, description, schema, jsonSchema, execute).

The connector needs two changes:
1. Migrate the existing local DateRange schema to the shared `DateRangeArg` from `src/connectors/base/date-range.ts` (to satisfy the `tests/unit/connectors/base/date-range-invariant.test.ts` invariant).
2. Add the new `klaviyo.consented_signups` tool.

- [ ] **Step 2: Add deps + new tool definition**

In the connector, accept an optional `signupRepo` in deps. Add the new tool. Update the existing tools to use `DateRangeArg` instead of the local schema.

Modify `src/connectors/klaviyo/connector.ts`:

a) At the top, import the shared schema:

```ts
import { DateRangeArg, normalizeDateRange } from '../base/date-range.js';
import type { KlaviyoSignupRollupRepo } from '../../storage/repositories/klaviyo-signup-rollup.js';
```

b) Update the deps interface and constructor to accept `signupRepo: KlaviyoSignupRollupRepo`:

```ts
export interface KlaviyoConnectorDeps {
  client: KlaviyoApiClient;
  signupRepo: KlaviyoSignupRollupRepo;
}
```

c) Replace the local `DateRange` schema usages in existing tool args with `DateRangeArg`. Where the existing code reads `args.dateRange.startDate` directly, replace with:

```ts
const { startDate, endDate } = normalizeDateRange(args.dateRange);
```

d) Add the new tool. Insert this in the `tools` array (place near `flow_performance` or end of array — match the existing style):

```ts
const ConsentedSignupsArgs = z.object({
  dateRange: DateRangeArg.describe('Date window over which to count signups (by profile.created in PT).'),
  granularity: z.enum(['daily', 'weekly', 'monthly']).default('monthly')
    .describe("Aggregation bucket. 'monthly' is most common."),
});
type ConsentedSignupsArgs = z.infer<typeof ConsentedSignupsArgs>;

const consentedSignups: ToolDef<ConsentedSignupsArgs> = {
  name: 'klaviyo.consented_signups',
  description:
    'Count of profiles created in the window AND currently subscribed to email marketing in Klaviyo. Use for questions like "how many email signups did we get in March?" or "monthly consented signups in 2026". Reads from the nightly rollup table — fast (millis), refreshed once/day at 03:00 PT.',
  schema: ConsentedSignupsArgs as z.ZodType<ConsentedSignupsArgs>,
  jsonSchema: zodToJsonSchema(ConsentedSignupsArgs),
  async execute(args) {
    const { startDate, endDate } = normalizeDateRange(args.dateRange);
    const days = await deps.signupRepo.getRange(startDate, endDate);

    const rows = aggregateSignups(days, args.granularity);

    let latestComputedDay: string | null = null;
    let computedAt: string | null = null;
    for (const d of days) {
      if (latestComputedDay === null || d.day > latestComputedDay) latestComputedDay = d.day;
      if (computedAt === null || d.computedAt > computedAt) computedAt = d.computedAt;
    }

    return {
      period: { startDate, endDate },
      granularity: args.granularity,
      rows,
      rollupFreshness: { latestComputedDay, computedAt },
      note: 'Consent reflects current state. Counts may decrease over time as profiles unsubscribe.',
    };
  },
};
```

e) Add the aggregation helper at the bottom of the file:

```ts
function aggregateSignups(
  days: Array<{ day: string; signupsTotal: number; signupsConsentedEmail: number }>,
  granularity: 'daily' | 'weekly' | 'monthly',
): Array<{ key: string; signupsTotal: number; signupsConsentedEmail: number }> {
  if (granularity === 'daily') {
    return days.map((d) => ({ key: d.day, signupsTotal: d.signupsTotal, signupsConsentedEmail: d.signupsConsentedEmail }));
  }
  const buckets = new Map<string, { signupsTotal: number; signupsConsentedEmail: number }>();
  for (const d of days) {
    const key = granularity === 'monthly' ? d.day.slice(0, 7) : isoWeekStart(d.day);
    const cur = buckets.get(key) ?? { signupsTotal: 0, signupsConsentedEmail: 0 };
    cur.signupsTotal += d.signupsTotal;
    cur.signupsConsentedEmail += d.signupsConsentedEmail;
    buckets.set(key, cur);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => ({ key, ...v }));
}

function isoWeekStart(ymd: string): string {
  // Returns the Monday (ISO 8601 week start) of the week containing ymd, formatted YYYY-MM-DD.
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayOfWeek = (dt.getUTCDay() + 6) % 7; // Mon=0, Sun=6
  dt.setUTCDate(dt.getUTCDate() - dayOfWeek);
  return dt.toISOString().slice(0, 10);
}
```

f) Append the new tool to the `tools` array:

```ts
return [
  // ... existing tools, now using DateRangeArg ...
  consentedSignups,
];
```

- [ ] **Step 3: Add tool tests**

Open `tests/unit/connectors/klaviyo/connector.test.ts` and append:

```ts
describe('klaviyo.consented_signups', () => {
  function makeConnector(rows: Array<{ day: string; signupsTotal: number; signupsConsentedEmail: number; computedAt: string }>) {
    const signupRepo = {
      getRange: vi.fn().mockResolvedValue(rows),
      upsertManyDays: vi.fn(),
      latestDay: vi.fn(),
      count: vi.fn(),
    } as any;
    const client = {} as any;
    const conn = new KlaviyoConnector({ client, signupRepo });
    const tool = conn.tools.find((t) => t.name === 'klaviyo.consented_signups')!;
    return { tool, signupRepo };
  }

  it('aggregates daily rows to monthly buckets', async () => {
    const { tool } = makeConnector([
      { day: '2026-01-01', signupsTotal: 10, signupsConsentedEmail: 7, computedAt: '2026-04-29T10:00:00.000Z' },
      { day: '2026-01-15', signupsTotal: 5, signupsConsentedEmail: 3, computedAt: '2026-04-29T10:00:00.000Z' },
      { day: '2026-02-01', signupsTotal: 8, signupsConsentedEmail: 5, computedAt: '2026-04-29T10:00:00.000Z' },
    ]);
    const out = await tool.execute({ dateRange: { startDate: '2026-01-01', endDate: '2026-02-28' }, granularity: 'monthly' });
    expect(out.rows).toEqual([
      { key: '2026-01', signupsTotal: 15, signupsConsentedEmail: 10 },
      { key: '2026-02', signupsTotal: 8, signupsConsentedEmail: 5 },
    ]);
  });

  it('passes through daily rows unchanged for granularity=daily', async () => {
    const { tool } = makeConnector([
      { day: '2026-01-01', signupsTotal: 1, signupsConsentedEmail: 1, computedAt: '2026-04-29T10:00:00.000Z' },
    ]);
    const out = await tool.execute({ dateRange: { startDate: '2026-01-01', endDate: '2026-01-01' }, granularity: 'daily' });
    expect(out.rows).toEqual([{ key: '2026-01-01', signupsTotal: 1, signupsConsentedEmail: 1 }]);
  });

  it('accepts a preset string for dateRange', async () => {
    const { tool } = makeConnector([]);
    await expect(tool.execute({ dateRange: 'last_30_days', granularity: 'monthly' })).resolves.toBeDefined();
  });

  it('returns empty rows + null rollupFreshness when no data exists', async () => {
    const { tool } = makeConnector([]);
    const out = await tool.execute({ dateRange: { startDate: '2030-01-01', endDate: '2030-12-31' }, granularity: 'monthly' });
    expect(out.rows).toEqual([]);
    expect(out.rollupFreshness).toEqual({ latestComputedDay: null, computedAt: null });
  });

  it('reports the latest computed day in rollupFreshness', async () => {
    const { tool } = makeConnector([
      { day: '2026-01-01', signupsTotal: 1, signupsConsentedEmail: 1, computedAt: '2026-04-29T10:00:00.000Z' },
      { day: '2026-01-02', signupsTotal: 1, signupsConsentedEmail: 1, computedAt: '2026-04-29T10:00:00.000Z' },
    ]);
    const out = await tool.execute({ dateRange: { startDate: '2026-01-01', endDate: '2026-01-31' }, granularity: 'daily' });
    expect(out.rollupFreshness.latestComputedDay).toBe('2026-01-02');
    expect(out.rollupFreshness.computedAt).toBe('2026-04-29T10:00:00.000Z');
  });

  it('aggregates weekly into ISO week buckets keyed by Monday', async () => {
    const { tool } = makeConnector([
      // 2026-01-01 is a Thursday — its ISO week starts Monday 2025-12-29.
      { day: '2026-01-01', signupsTotal: 4, signupsConsentedEmail: 2, computedAt: '2026-04-29T10:00:00.000Z' },
      { day: '2026-01-04', signupsTotal: 1, signupsConsentedEmail: 0, computedAt: '2026-04-29T10:00:00.000Z' },
      // 2026-01-05 is the Monday of the next ISO week.
      { day: '2026-01-05', signupsTotal: 6, signupsConsentedEmail: 4, computedAt: '2026-04-29T10:00:00.000Z' },
    ]);
    const out = await tool.execute({ dateRange: { startDate: '2026-01-01', endDate: '2026-01-31' }, granularity: 'weekly' });
    expect(out.rows).toEqual([
      { key: '2025-12-29', signupsTotal: 5, signupsConsentedEmail: 2 },
      { key: '2026-01-05', signupsTotal: 6, signupsConsentedEmail: 4 },
    ]);
  });
});
```

If the existing connector tests already construct a `KlaviyoConnector` with `{ client }` only, update those constructions to include a stub `signupRepo: { getRange: vi.fn(), upsertManyDays: vi.fn(), latestDay: vi.fn(), count: vi.fn() } as any`. Don't change the assertions on existing tests.

- [ ] **Step 4: Run tests, verify they pass**

```bash
npx vitest run tests/unit/connectors/klaviyo/
```

Expected: all existing klaviyo tests still pass + 6 new tool tests pass.

- [ ] **Step 5: Run the date-range invariant test**

```bash
npx vitest run tests/unit/connectors/base/date-range-invariant.test.ts
```

Expected: now also covers `klaviyo.consented_signups` (since it'll be whitelisted in Task 6) and accepts the preset.

- [ ] **Step 6: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/connectors/klaviyo/connector.ts tests/unit/connectors/klaviyo/connector.test.ts
git commit -m "feat: add klaviyo.consented_signups tool, migrate connector to shared DateRangeArg"
```

---

## Task 6: Wiring (index.ts, prompts, whitelist)

**Files:**
- Modify: `src/index.ts`
- Modify: `src/reports/live/spec.ts`
- Modify: `src/orchestrator/prompts.ts`

- [ ] **Step 1: Whitelist the tool**

Open `src/reports/live/spec.ts`. Find the `WHITELISTED_TOOLS` Set. Add `'klaviyo.consented_signups'` to the set, alphabetically with the other `klaviyo.*` tools.

Example (the surrounding context will already exist; just add the line):

```ts
export const WHITELISTED_TOOLS = new Set<string>([
  // ...
  'klaviyo.campaign_performance',
  'klaviyo.consented_signups',  // <-- new
  'klaviyo.flow_performance',
  'klaviyo.list_campaigns',
  'klaviyo.list_segments',
  // ...
]);
```

- [ ] **Step 2: Wire the repo and job in `src/index.ts`**

Open `src/index.ts`. Find where the existing `KlaviyoConnector` is instantiated (search for `KlaviyoApiClient` or `KlaviyoConnector`). Add:

```ts
import { KlaviyoSignupRollupRepo } from './storage/repositories/klaviyo-signup-rollup.js';
import { KlaviyoSignupRollupJob } from './connectors/klaviyo/signup-rollup-job.js';
```

Where the supabase client and Klaviyo client are already in scope:

```ts
const klaviyoSignupRepo = new KlaviyoSignupRollupRepo(supabase);
const klaviyoSignupRollupJob = new KlaviyoSignupRollupJob({ client: klaviyoClient, repo: klaviyoSignupRepo });
klaviyoSignupRollupJob.start();
```

(Variable names should match the existing ones — e.g. `supabase`, `klaviyoClient` may be named differently. Read context around the existing connector instantiation.)

Update the `KlaviyoConnector` instantiation to pass the repo:

```ts
const klaviyoConnector = new KlaviyoConnector({ client: klaviyoClient, signupRepo: klaviyoSignupRepo });
```

- [ ] **Step 3: Add prompt documentation**

Open `src/orchestrator/prompts.ts`. Find the section that documents Klaviyo tools (search for `klaviyo.list_campaigns` or `klaviyo.flow_performance`). Add a new entry after `klaviyo.flow_performance`:

```
- klaviyo.consented_signups({dateRange, granularity?: 'daily'|'weekly'|'monthly'}): Returns counts of profiles created in the window AND currently subscribed to email marketing. Default granularity 'monthly'. Use for "how many email signups in March?", "monthly consented signups YTD", "weekly signups Q1". Backed by a nightly rollup; counts for past months can drift down as profiles unsubscribe (this matches the canonical definition).
```

(Match the formatting of the surrounding tool docs — bullet style, indentation, etc.)

- [ ] **Step 4: Run all tests**

```bash
npx vitest run
```

Expected: full suite passes including invariant test.

- [ ] **Step 5: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Build**

```bash
npm run build
```

Expected: clean build, no errors.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/reports/live/spec.ts src/orchestrator/prompts.ts
git commit -m "feat: wire klaviyo.consented_signups + nightly rollup job"
```

---

## Task 7: Deploy + smoke test against Lana's reference

**Files:**
- Manual deploy + verification only.

- [ ] **Step 1: Deploy to Fly**

```bash
fly deploy
```

Expected: deploy succeeds. Watch logs for `klaviyo signup rollup job started (15-min poll, fires at 03:00 PT)` and the initial `klaviyo_signup_rollup_started`.

- [ ] **Step 2: Wait for the initial run to complete**

The rollup job runs once on boot. With ~50K profiles since 2020, expect 1–3 minutes. Watch Fly logs for:

```
klaviyo_signup_rollup_completed { profilesSeen: <N>, daysUpserted: <N>, durationMs: <N> }
```

If it fails with `klaviyo_signup_rollup_failed`, investigate the error before proceeding.

- [ ] **Step 3: Verify the rollup table has data**

Via Supabase MCP:

```sql
select count(*) as days, sum(signups_total) as total_signups, sum(signups_consented_email) as total_consented
from klaviyo_signups_daily;
```

Expected: `days` is several thousand (one per day since the first signup), `total_consented` is the lifetime consent count.

- [ ] **Step 4: Verify monthly counts match Lana's reference**

Query for 2026 YTD via Supabase MCP:

```sql
select to_char(day, 'YYYY-MM') as month,
       sum(signups_total) as signups_total,
       sum(signups_consented_email) as signups_consented
from klaviyo_signups_daily
where day >= '2026-01-01' and day <= '2026-04-24'
group by 1 order by 1;
```

Expected:
- Jan 2026 consented ≈ 593
- Feb 2026 consented ≈ 329
- Mar 2026 consented ≈ 350
- Apr 1–24 2026 consented ≈ 299
- YTD total ≈ 1,571

If counts differ by >5%, debug the bucketing or consent semantics before merging:
- Check if PT bucketing is correct (a profile at `2026-01-01T05:00:00Z` should land in `2025-12-31`)
- Confirm `subscriptions.email.marketing.consent === 'SUBSCRIBED'` is the right field path (try `additional-fields[profile]=subscriptions` from a single profile via `curl` and inspect the JSON)
- Check that pagination is exhausting all profiles (look at `profilesSeen` log)

- [ ] **Step 5: End-to-end smoke from Slack**

Send a test DM to the bot:

```
@gantri-ai How many consented signups did we get monthly in 2026 YTD?
```

Expected: bot calls `klaviyo.consented_signups({dateRange: {startDate: '2026-01-01', endDate: '<today>'}, granularity: 'monthly'})`, returns a table with the months above.

Send another test:

```
@gantri-ai Make a Live Report titled "Email signups trend (last 90 days)" using consented signups by month
```

Expected: report compiles successfully (no `column_field_not_scalar` or `unresolved_report_range` errors), publishes a URL, the visual verifier passes.

- [ ] **Step 6: Reply to Lana's feedback thread**

Once Step 4 + Step 5 pass, send a follow-up to Lana on the original feedback thread:

> Klaviyo consented signups now live via `klaviyo.consented_signups` (try "monthly consented signups in 2026 YTD" in DM). Backed by a nightly rollup at 03:00 PT, so today's signups show up tomorrow morning. YTD numbers I just verified: Jan ~593 / Feb ~329 / Mar ~350 / Apr 1–24 ~299 (matches your reference). Past months can drift down as profiles unsubscribe — that's the canonical definition.

(Customize once we have the actual numbers from Step 4.)

- [ ] **Step 7: Final commit / merge**

If everything passes, the branch is ready to merge. No further code commit needed in this task.
