import { describe, it, expect } from 'vitest';
import { aggregateFromRollup } from '../../../../src/connectors/gantri-porter/gantri-porter-connector.js';
import type { RollupRow } from '../../../../src/storage/rollup-repo.js';

const sampleRows: RollupRow[] = [
  {
    date: '2024-01-01',
    total_orders: 12,
    total_revenue_cents: 234500,
    by_type: {
      Order: { orders: 8, revenueCents: 200000 },
      Wholesale: { orders: 3, revenueCents: 30000 },
      Refund: { orders: 1, revenueCents: -5500 },
      Trade: { orders: 0, revenueCents: 10000 },
    },
    by_status: {
      Processed: { orders: 7, revenueCents: 160000 },
      Shipped: { orders: 4, revenueCents: 70000 },
      Refunded: { orders: 1, revenueCents: 4500 },
    },
    by_organization: {},
    refreshed_at: '2026-04-25T00:00:00.000Z',
  },
  {
    date: '2024-01-02',
    total_orders: 10,
    total_revenue_cents: 180000,
    by_type: {
      Order: { orders: 7, revenueCents: 140000 },
      Wholesale: { orders: 2, revenueCents: 30000 },
      Refund: { orders: 1, revenueCents: -10000 },
    },
    by_status: {
      Processed: { orders: 6, revenueCents: 120000 },
      Shipped: { orders: 4, revenueCents: 60000 },
    },
    by_organization: {},
    refreshed_at: '2026-04-25T00:00:00.000Z',
  },
];

describe('aggregateFromRollup', () => {
  it('sums orders and revenue across days, returns full type breakdown', () => {
    const r = aggregateFromRollup(sampleRows, { dateRange: { startDate: '2024-01-01', endDate: '2024-01-02' } }, 100) as any;
    expect(r.source).toBe('rollup');
    // 8 + 7 (Order) + 3 + 2 (Wholesale) + 1 + 1 (Refund) + 0 (Trade) = 22
    expect(r.totalOrders).toBe(22);
    // 200000 + 140000 + 30000 + 30000 - 5500 - 10000 + 10000 = 394500 → $3,945.00
    expect(r.totalRevenueDollars).toBe(3945);
    expect(r.typeBreakdown).toEqual([
      { type: 'Order', count: 15, revenueDollars: 3400 },
      { type: 'Wholesale', count: 5, revenueDollars: 600 },
      { type: 'Refund', count: 2, revenueDollars: -155 },
      { type: 'Trade', count: 0, revenueDollars: 100 },
    ]);
  });

  it('filters typeBreakdown by `types` and suppresses statusBreakdown when filtered', () => {
    const r = aggregateFromRollup(
      sampleRows,
      { dateRange: { startDate: '2024-01-01', endDate: '2024-01-02' }, types: ['Order'] },
      100,
    ) as any;
    expect(r.typeBreakdown).toEqual([{ type: 'Order', count: 15, revenueDollars: 3400 }]);
    expect(r.statusBreakdown).toBeNull();
    expect(r.totalOrders).toBe(15);
    expect(r.totalRevenueDollars).toBe(3400);
  });

  it('returns the status breakdown when no type filter is set', () => {
    const r = aggregateFromRollup(sampleRows, { dateRange: { startDate: '2024-01-01', endDate: '2024-01-02' } }, 100) as any;
    const bySt = (r.statusBreakdown as Array<{ status: string; count: number }>).reduce<Record<string, number>>(
      (acc, x) => ((acc[x.status] = x.count), acc),
      {},
    );
    expect(bySt).toEqual({ Processed: 13, Shipped: 8, Refunded: 1 });
  });

  it('flags the rollup source so the LLM knows the Cancelled/Lost exclusion', () => {
    const r = aggregateFromRollup(sampleRows, { dateRange: { startDate: '2024-01-01', endDate: '2024-01-02' } }, 100) as any;
    expect(r.source).toBe('rollup');
    expect(r.note).toContain('Cancelled');
  });

  it('passes the porter total count through for cross-check (so the LLM can spot definitional differences)', () => {
    const r = aggregateFromRollup(sampleRows, { dateRange: { startDate: '2024-01-01', endDate: '2024-01-02' } }, 99) as any;
    expect(r.porterTotalCount).toBe(99);
  });
});
