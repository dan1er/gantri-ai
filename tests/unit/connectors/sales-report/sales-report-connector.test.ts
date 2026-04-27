import { describe, it, expect, vi } from 'vitest';
import { SalesReportConnector } from '../../../../src/connectors/sales-report/sales-report-connector.js';
import type { GrafanaConnector } from '../../../../src/connectors/grafana/grafana-connector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal row array in the same column order the SQL returns. */
function buildRow(opts: {
  type: string;
  orders: number;
  items: number;
  gift_cards: number;
  subtotal: number;   // dollars (already divided by 100 in SQL)
  shipping: number;
  tax: number;
  discount: number;   // negative for discounts
  credit: number;     // negative
  sales_exl_tax: number;
  full_total: number;
}): unknown[] {
  return [
    opts.type,
    opts.orders,
    opts.items,
    opts.gift_cards,
    opts.subtotal,
    opts.shipping,
    opts.tax,
    opts.discount,
    opts.credit,
    opts.sales_exl_tax,
    opts.full_total,
  ];
}

const SQL_FIELDS = [
  'type',
  'orders',
  'items',
  'gift_cards',
  'subtotal',
  'shipping',
  'tax',
  'discount',
  'credit',
  'sales_exl_tax',
  'full_total',
];

function makeGrafanaMock(rows: unknown[][]): Pick<GrafanaConnector, 'runSql'> {
  return {
    runSql: vi.fn(async () => ({ fields: SQL_FIELDS, rows })),
  };
}

function makeConnector(grafana: Pick<GrafanaConnector, 'runSql'>) {
  return new SalesReportConnector({ grafana: grafana as GrafanaConnector });
}

function getTool(conn: SalesReportConnector) {
  const tool = conn.tools.find((t) => t.name === 'gantri.sales_report');
  if (!tool) throw new Error('gantri.sales_report tool not found');
  return tool;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SalesReportConnector → gantri.sales_report', () => {
  it('passes dateRange correctly — fromMs/toMs derive from PT day boundaries', async () => {
    const grafana = makeGrafanaMock([]);
    const conn = makeConnector(grafana);
    const tool = getTool(conn);
    const args = tool.schema.parse({ dateRange: { startDate: '2025-04-01', endDate: '2025-04-30' } });
    await tool.execute(args);

    expect(grafana.runSql).toHaveBeenCalledTimes(1);
    const call = (grafana.runSql as ReturnType<typeof vi.fn>).mock.calls[0][0];

    // fromMs should be 2025-04-01 midnight PT = 2025-04-01T07:00:00Z
    const expectedFromMs = Date.parse('2025-04-01T07:00:00.000Z');
    // toMs should be 2025-05-01 midnight PT = 2025-05-01T07:00:00Z
    const expectedToMs = Date.parse('2025-05-01T07:00:00.000Z');

    expect(call.fromMs).toBe(expectedFromMs);
    expect(call.toMs).toBe(expectedToMs);
    expect(typeof call.sql).toBe('string');
    expect(call.sql.length).toBeGreaterThan(100); // the real SQL
  });

  it('parses result rows into the expected field shape', async () => {
    const row = buildRow({
      type: 'Order',
      orders: 42,
      items: 55,
      gift_cards: 3,
      subtotal: 1000.50,
      shipping: 150.25,
      tax: 80.10,
      discount: -50.00,
      credit: -20.00,
      sales_exl_tax: 1280.75,
      full_total: 1360.85,
    });

    const grafana = makeGrafanaMock([row]);
    const conn = makeConnector(grafana);
    const tool = getTool(conn);
    const args = tool.schema.parse({ dateRange: { startDate: '2025-04-01', endDate: '2025-04-30' } });
    const res: any = await tool.execute(args);

    expect(res.rows).toHaveLength(1);
    const r = res.rows[0];
    expect(r.type).toBe('Order');
    expect(r.orders).toBe(42);
    expect(r.items).toBe(55);
    expect(r.giftCards).toBe(3);
    expect(r.subtotal).toBeCloseTo(1000.50);
    expect(r.shipping).toBeCloseTo(150.25);
    expect(r.tax).toBeCloseTo(80.10);
    expect(r.discount).toBeCloseTo(-50.00);
    expect(r.credit).toBeCloseTo(-20.00);
    expect(r.salesExclTax).toBeCloseTo(1280.75);
    expect(r.fullTotal).toBeCloseTo(1360.85);
  });

  it('computes totals correctly across all rows — refund rows signed negative net out', async () => {
    const orderRow = buildRow({
      type: 'Order',
      orders: 10,
      items: 15,
      gift_cards: 0,
      subtotal: 500.00,
      shipping: 50.00,
      tax: 40.00,
      discount: -10.00,
      credit: -5.00,
      sales_exl_tax: 545.00,
      full_total: 580.00,
    });
    const refundRow = buildRow({
      type: 'Refund',
      orders: 2,
      items: 2,
      gift_cards: 0,
      subtotal: -100.00,  // signed negative by SQL
      shipping: -10.00,
      tax: -8.00,
      discount: 0,
      credit: 0,
      sales_exl_tax: -110.00,
      full_total: -118.00,
    });

    const grafana = makeGrafanaMock([orderRow, refundRow]);
    const conn = makeConnector(grafana);
    const tool = getTool(conn);
    const args = tool.schema.parse({ dateRange: { startDate: '2025-04-01', endDate: '2025-04-30' } });
    const res: any = await tool.execute(args);

    expect(res.rows).toHaveLength(2);
    const { totals } = res;

    // Net totals = order + refund (already signed)
    expect(totals.orders).toBe(12);          // 10 + 2
    expect(totals.items).toBe(17);           // 15 + 2
    expect(totals.subtotal).toBeCloseTo(400.00);   // 500 - 100
    expect(totals.shipping).toBeCloseTo(40.00);    // 50 - 10
    expect(totals.tax).toBeCloseTo(32.00);         // 40 - 8
    expect(totals.fullTotal).toBeCloseTo(462.00);  // 580 - 118
  });

  it('summary object has multi-naming aliases for the same value', async () => {
    const row = buildRow({
      type: 'Order',
      orders: 5,
      items: 8,
      gift_cards: 1,
      subtotal: 200.00,
      shipping: 30.00,
      tax: 20.00,
      discount: -5.00,
      credit: -2.00,
      sales_exl_tax: 225.00,
      full_total: 245.00,
    });

    const grafana = makeGrafanaMock([row]);
    const conn = makeConnector(grafana);
    const tool = getTool(conn);
    const args = tool.schema.parse({ dateRange: { startDate: '2025-04-01', endDate: '2025-04-30' } });
    const res: any = await tool.execute(args);

    const { summary } = res;
    // Shipping aliases
    expect(summary.shipping).toBeCloseTo(30.00);
    expect(summary.shippingDollars).toBeCloseTo(30.00);
    expect(summary.totalShipping).toBeCloseTo(30.00);
    // fullTotal aliases
    expect(summary.fullTotal).toBeCloseTo(245.00);
    expect(summary.fullTotalDollars).toBeCloseTo(245.00);
    expect(summary.full_total).toBeCloseTo(245.00);
    expect(summary.totalRevenue).toBeCloseTo(245.00);
    // salesExclTax aliases
    expect(summary.salesExclTax).toBeCloseTo(225.00);
    expect(summary.salesExclTaxDollars).toBeCloseTo(225.00);
    expect(summary.sales_excl_tax).toBeCloseTo(225.00);
    // totals and summary point at the same data
    expect(res.totals.fullTotal).toBeCloseTo(res.summary.fullTotal);
  });

  it('period is echoed back in the response', async () => {
    const grafana = makeGrafanaMock([]);
    const conn = makeConnector(grafana);
    const tool = getTool(conn);
    const args = tool.schema.parse({ dateRange: { startDate: '2025-03-01', endDate: '2025-03-31' } });
    const res: any = await tool.execute(args);
    expect(res.period).toEqual({ startDate: '2025-03-01', endDate: '2025-03-31' });
    expect(res.source).toBe('grafana_sales_panel');
  });

  it('null / missing cells default to 0 without crashing', async () => {
    // Simulate a row where numeric fields come back as null (e.g. no transactions)
    const sparseRow: unknown[] = ['R&D', 1, 0, 0, null, null, null, null, null, null, null];
    const grafana = makeGrafanaMock([sparseRow]);
    const conn = makeConnector(grafana);
    const tool = getTool(conn);
    const args = tool.schema.parse({ dateRange: { startDate: '2025-04-01', endDate: '2025-04-30' } });
    const res: any = await tool.execute(args);

    const r = res.rows[0];
    expect(r.subtotal).toBe(0);
    expect(r.shipping).toBe(0);
    expect(r.fullTotal).toBe(0);
  });

  it('snake_case row aliases are present alongside camelCase', async () => {
    const row = buildRow({
      type: 'Wholesale',
      orders: 3,
      items: 5,
      gift_cards: 0,
      subtotal: 300.00,
      shipping: 0,
      tax: 25.00,
      discount: 0,
      credit: 0,
      sales_exl_tax: 300.00,
      full_total: 325.00,
    });

    const grafana = makeGrafanaMock([row]);
    const conn = makeConnector(grafana);
    const tool = getTool(conn);
    const args = tool.schema.parse({ dateRange: { startDate: '2025-04-01', endDate: '2025-04-30' } });
    const res: any = await tool.execute(args);
    const r = res.rows[0];

    // camelCase
    expect(r.salesExclTax).toBeCloseTo(300.00);
    // snake_case aliases
    expect(r.sales_excl_tax).toBeCloseTo(300.00);
    expect(r.sales_exl_tax).toBeCloseTo(300.00);
    expect(r.fullTotal).toBeCloseTo(325.00);
    expect(r.full_total).toBeCloseTo(325.00);
    expect(r.giftCards).toBe(0);
    expect(r.gift_cards).toBe(0);
  });
});
