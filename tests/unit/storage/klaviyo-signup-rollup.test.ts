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
      const ctx: {
        _filters: Array<(r: any) => boolean>;
        _selectCols?: string;
        _orderBy?: { col: string; ascending: boolean };
        _limit?: number;
      } = { _filters: [] };
      const applyOrderAndLimit = (list: any[]): any[] => {
        let out = list;
        if (ctx._orderBy) {
          const { col, ascending } = ctx._orderBy;
          out = [...out].sort((a, b) => {
            if (a[col] < b[col]) return ascending ? -1 : 1;
            if (a[col] > b[col]) return ascending ? 1 : -1;
            return 0;
          });
        }
        if (ctx._limit !== undefined) out = out.slice(0, ctx._limit);
        return out;
      };
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
        order(col: string, opts?: { ascending?: boolean }) {
          ctx._orderBy = { col, ascending: opts?.ascending ?? true };
          return builder;
        },
        limit(n: number) { ctx._limit = n; return builder; },
        single() {
          const list = applyOrderAndLimit([...rows.values()].filter((r: any) => ctx._filters.every((f) => f(r))));
          return Promise.resolve({ data: list[0] ?? null, error: null });
        },
        maybeSingle() {
          const list = applyOrderAndLimit([...rows.values()].filter((r: any) => ctx._filters.every((f) => f(r))));
          return Promise.resolve({ data: list[0] ?? null, error: null });
        },
        then(resolve: any) {
          const list = applyOrderAndLimit([...rows.values()].filter((r: any) => ctx._filters.every((f) => f(r))));
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

  it('latestDay returns the most recent day when rows exist', async () => {
    await repo.upsertManyDays([
      { day: '2026-01-01', signupsTotal: 1, signupsConsentedEmail: 1 },
      { day: '2026-01-15', signupsTotal: 2, signupsConsentedEmail: 2 },
      { day: '2026-01-10', signupsTotal: 3, signupsConsentedEmail: 3 },
    ]);
    expect(await repo.latestDay()).toBe('2026-01-15');
  });

  it('latestDay returns null when no rows exist', async () => {
    expect(await repo.latestDay()).toBeNull();
  });

  it('count returns the total number of rollup days', async () => {
    expect(await repo.count()).toBe(0);
    await repo.upsertManyDays([
      { day: '2026-01-01', signupsTotal: 1, signupsConsentedEmail: 1 },
      { day: '2026-01-02', signupsTotal: 1, signupsConsentedEmail: 1 },
    ]);
    expect(await repo.count()).toBe(2);
  });
});
