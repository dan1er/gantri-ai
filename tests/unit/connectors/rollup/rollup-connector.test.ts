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
    const conn = new RollupConnector({ repo: repo as any });
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
    const conn = new RollupConnector({ repo: repo as any });
    const tool = conn.tools.find((t) => t.name === 'gantri.daily_rollup')!;
    const r: any = await tool.execute({
      dateRange: { startDate: '2025-03-10', endDate: '2025-03-16' },
      dimension: 'none',
      granularity: 'week',
    });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].totalOrders).toBe(7 * 42);
  });

  it('granularity=period collapses N days into ONE row per dimension key (no date column)', async () => {
    const days = [
      { ...sampleRow, date: '2025-03-10' },
      { ...sampleRow, date: '2025-03-11' },
      { ...sampleRow, date: '2025-03-12' },
    ];
    const repo = fakeRepo(days);
    const conn = new RollupConnector({ repo: repo as any });
    const tool = conn.tools.find((t) => t.name === 'gantri.daily_rollup')!;
    const r: any = await tool.execute({
      dateRange: { startDate: '2025-03-10', endDate: '2025-03-12' },
      dimension: 'type',
      granularity: 'period',
    });
    // 3 days × 2 dim keys (Order + Wholesale) but period collapses to one per
    // key — so 2 rows total.
    expect(r.rows).toHaveLength(2);
    const orderRow = r.rows.find((x: any) => x.dimensionKey === 'Order');
    expect(orderRow.totalOrders).toBe(90);                        // 3 × 30
    expect(orderRow.totalRevenueDollars).toBeCloseTo(24000);       // 3 × 800,000 cents
    expect(orderRow.date).toBeUndefined();
    // Sorted desc by revenue — Order is bigger than Wholesale
    expect(r.rows[0].dimensionKey).toBe('Order');
  });

  it('granularity=period with dimension=none returns a single grand total row', async () => {
    const repo = fakeRepo([sampleRow, { ...sampleRow, date: '2025-03-16' }]);
    const conn = new RollupConnector({ repo: repo as any });
    const tool = conn.tools.find((t) => t.name === 'gantri.daily_rollup')!;
    const r: any = await tool.execute({
      dateRange: { startDate: '2025-03-15', endDate: '2025-03-16' },
      dimension: 'none',
      granularity: 'period',
    });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].totalOrders).toBe(84);                       // 2 × 42
    expect(r.rows[0].totalRevenueDollars).toBeCloseTo(24690);      // 2 × 12345
    expect(r.rows[0].date).toBeUndefined();
    expect(r.rows[0].dimensionKey).toBeUndefined();
  });

it('breaks down by type when dimension=type', async () => {
    const repo = fakeRepo([sampleRow]);
    const conn = new RollupConnector({ repo: repo as any });
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
