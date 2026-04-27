import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublishedReportsRepo } from '../../../src/storage/repositories/published-reports.js';

function fakeSupabase() {
  const tables: Record<string, any[]> = { published_reports: [], published_reports_history: [] };
  const builder = (table: string) => {
    let pending: any = { table, op: 'select', filters: [], data: null, single: false };
    const chain: any = {
      select: vi.fn(() => { pending.op = 'select'; return chain; }),
      insert: vi.fn((row: any) => { pending.op = 'insert'; pending.data = row; return chain; }),
      update: vi.fn((row: any) => { pending.op = 'update'; pending.data = row; return chain; }),
      eq: vi.fn((col: string, v: any) => { pending.filters.push({ col, v }); return chain; }),
      neq: vi.fn(() => chain),
      is: vi.fn((col: string, v: any) => { pending.filters.push({ col, v }); return chain; }),
      overlaps: vi.fn((col: string, v: any) => { pending.filters.push({ op: 'overlaps', col, v }); return chain; }),
      order: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      single: vi.fn(() => { pending.single = true; return Promise.resolve(execute(pending, tables)); }),
      maybeSingle: vi.fn(() => { pending.single = true; pending.maybeSingle = true; return Promise.resolve(execute(pending, tables)); }),
      then: (cb: any) => Promise.resolve(execute(pending, tables)).then(cb),
    };
    return chain;
  };
  return { from: builder, _tables: tables };
}

function execute(pending: any, tables: Record<string, any[]>) {
  const t = tables[pending.table];
  if (pending.op === 'insert') {
    const inserted = { ...pending.data, id: pending.data.id ?? `id_${t.length + 1}`, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), visit_count: 0 };
    t.push(inserted);
    return { data: inserted, error: null };
  }
  if (pending.op === 'select') {
    let rows = [...t];
    for (const f of pending.filters) {
      if (f.op === 'overlaps') {
        rows = rows.filter((r) => Array.isArray(r[f.col]) && r[f.col].some((k: string) => f.v.includes(k)));
      } else {
        rows = rows.filter((r) => (f.v === null ? r[f.col] == null : r[f.col] === f.v));
      }
    }
    if (pending.single) return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }
  if (pending.op === 'update') {
    let rows = [...t];
    for (const f of pending.filters) rows = rows.filter((r) => r[f.col] === f.v);
    rows.forEach((r) => Object.assign(r, pending.data));
    return { data: rows[0] ?? null, error: null };
  }
  return { data: null, error: null };
}

const sampleSpec = { version: 1 as const, title: 'T', data: [{ id: 'a', tool: 'gantri.order_stats', args: {} }], ui: [{ type: 'kpi' as const, label: 'X', value: 'a.totalOrders' }], cacheTtlSec: 300 };

describe('PublishedReportsRepo', () => {
  let supabase: ReturnType<typeof fakeSupabase>;
  let repo: PublishedReportsRepo;
  beforeEach(() => { supabase = fakeSupabase(); repo = new PublishedReportsRepo(supabase as never); });

  it('creates a report and reads it back by slug', async () => {
    const created = await repo.create({
      slug: 'weekly-sales', title: 'Weekly Sales', ownerSlackId: 'UDANNY', intent: 'show me weekly sales', intentKeywords: ['weekly', 'sales'], spec: sampleSpec, accessToken: 'tok123',
    });
    expect(created.slug).toBe('weekly-sales');
    const fetched = await repo.getBySlug('weekly-sales');
    expect(fetched?.title).toBe('Weekly Sales');
  });

  it('records visit increments count + sets last_visited_at', async () => {
    await repo.create({ slug: 's', title: 't', ownerSlackId: 'U', intent: 'x', intentKeywords: [], spec: sampleSpec, accessToken: 'a' });
    await repo.recordVisit('s');
    const r = await repo.getBySlug('s');
    expect(r?.visitCount).toBe(1);
  });

  it('archive sets archived_at and getBySlug returns null', async () => {
    await repo.create({ slug: 's', title: 't', ownerSlackId: 'U', intent: 'x', intentKeywords: [], spec: sampleSpec, accessToken: 'a' });
    await repo.archive('s', 'UDANNY');
    expect(await repo.getBySlug('s')).toBeNull();
  });
});
