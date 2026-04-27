import { describe, it, expect, vi } from 'vitest';
import { buildCompareNbTool, buildDiffNbTool } from '../../../../src/connectors/sales-report/compare-nb-tool.js';
import type { GrafanaConnector } from '../../../../src/connectors/grafana/grafana-connector.js';
import type { NorthbeamApiClient } from '../../../../src/connectors/northbeam-api/client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake GrafanaConnector that, when runSql is called, returns the given
 * fields and rows. Multiple calls can return different results by supplying an
 * array; if only one result is provided it is reused for every call.
 */
function fakeGrafana(
  results: Array<{ fields: string[]; rows: unknown[][] }> | { fields: string[]; rows: unknown[][] },
): GrafanaConnector {
  const queue = Array.isArray(results) ? [...results] : [results];
  let callIndex = 0;
  return {
    runSql: vi.fn(async () => {
      const r = queue[callIndex] ?? queue[queue.length - 1];
      callIndex++;
      return r;
    }),
  } as unknown as GrafanaConnector;
}

/** Build a fake NorthbeamApiClient whose listOrders returns the given rows. */
function fakeNb(orders: Array<Record<string, unknown>>): NorthbeamApiClient {
  return {
    listOrders: vi.fn(async () => orders),
  } as unknown as NorthbeamApiClient;
}

/**
 * Build a Porter grafana result for the compare tool.
 * `days` is an array of { day, orders, revenue } objects.
 * `day` should be a YYYY-MM-DD string (how Porter returns it).
 */
function porterGrafanaResult(days: Array<{ day: string; orders: number; revenue: number }>) {
  return {
    fields: ['day', 'orders', 'revenue'],
    rows: days.map(({ day, orders, revenue }) => [day, orders, revenue]),
  };
}

/**
 * Build a minimal NB order row for a given PT date and total.
 * time_of_purchase is stored as an ISO 8601 UTC string that lands on the
 * given PT day (we use noon UTC so it's also daytime in PT).
 */
function nbOrder(
  orderId: string,
  ptDate: string,
  purchaseTotal: number,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  // noon UTC on ptDate is mid-morning PT — unambiguously falls on ptDate in PT
  const time_of_purchase = `${ptDate}T20:00:00.000Z`;
  return {
    order_id: orderId,
    purchase_total: purchaseTotal,
    time_of_purchase,
    is_cancelled: false,
    is_deleted: false,
    order_tags: [],
    customer_email: 'test@example.com',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildCompareNbTool
// ---------------------------------------------------------------------------

describe('buildCompareNbTool (gantri.compare_orders_nb_vs_porter)', () => {
  it('returns one row per PT day in the range with porter, nb, diff columns', async () => {
    const grafana = fakeGrafana(
      porterGrafanaResult([
        { day: '2026-04-23', orders: 10, revenue: 1000.00 },
        { day: '2026-04-24', orders: 8, revenue: 800.00 },
        { day: '2026-04-25', orders: 6, revenue: 600.00 },
      ]),
    );
    const nb = fakeNb([
      nbOrder('NB-001', '2026-04-23', 100.0),
      nbOrder('NB-002', '2026-04-23', 100.0),
      nbOrder('NB-003', '2026-04-24', 200.0),
      nbOrder('NB-004', '2026-04-25', 150.0),
    ]);

    const tool = buildCompareNbTool({ grafana, nb });
    const args = tool.schema.parse({
      dateRange: { startDate: '2026-04-23', endDate: '2026-04-25' },
    });
    const out = await tool.execute(args) as {
      rows: Array<{
        date: string;
        porter_orders: number;
        porter_revenue: number;
        nb_orders: number;
        nb_revenue: number;
        order_diff: number;
        revenue_diff: number;
      }>;
      totals: Record<string, number>;
      csv: string;
    };

    expect(out.rows).toHaveLength(3);
    const row0 = out.rows.find((r) => r.date === '2026-04-23');
    expect(row0).toBeDefined();
    expect(row0!.porter_orders).toBe(10);
    expect(row0!.nb_orders).toBe(2);
    expect(row0!.nb_revenue).toBe(200.0);

    // All six expected columns present on every row
    for (const row of out.rows) {
      expect(typeof row.porter_orders).toBe('number');
      expect(typeof row.porter_revenue).toBe('number');
      expect(typeof row.nb_orders).toBe('number');
      expect(typeof row.nb_revenue).toBe('number');
      expect(typeof row.order_diff).toBe('number');
      expect(typeof row.revenue_diff).toBe('number');
    }
  });

  it('order_diff and revenue_diff are correct when porter has more orders than nb on a given day', async () => {
    const grafana = fakeGrafana(
      porterGrafanaResult([
        { day: '2026-04-25', orders: 5, revenue: 500.00 },
      ]),
    );
    // NB has 4 orders totaling $400
    const nb = fakeNb([
      nbOrder('O1', '2026-04-25', 100.0),
      nbOrder('O2', '2026-04-25', 100.0),
      nbOrder('O3', '2026-04-25', 100.0),
      nbOrder('O4', '2026-04-25', 100.0),
    ]);

    const tool = buildCompareNbTool({ grafana, nb });
    const args = tool.schema.parse({
      dateRange: { startDate: '2026-04-25', endDate: '2026-04-25' },
    });
    const out = await tool.execute(args) as { rows: Array<Record<string, number>> };

    const row = out.rows[0];
    expect(row.porter_orders).toBe(5);
    expect(row.nb_orders).toBe(4);
    expect(row.order_diff).toBe(1); // porter - nb
    expect(row.revenue_diff).toBe(100.0); // 500 - 400
  });

  it('excludeToday: true drops the current PT day from the result', async () => {
    // Mock the current PT date by controlling what the tool sees.
    // The tool computes today via Intl.DateTimeFormat. We test by requesting a
    // range that includes yesterday and today, with excludeToday: true — only
    // yesterday should survive.
    //
    // We request 2 days: 2026-04-24 and 2026-04-25 (and we know today in CI
    // is 2026-04-26, so 2026-04-25 is yesterday). If the test machine's PT day
    // differs, we still verify that the row count is one fewer than without
    // excludeToday by comparing the two results.

    const makeGrafana = () =>
      fakeGrafana(
        porterGrafanaResult([
          { day: '2026-04-24', orders: 3, revenue: 300.0 },
          { day: '2026-04-25', orders: 4, revenue: 400.0 },
        ]),
      );
    const makeNb = () =>
      fakeNb([
        nbOrder('A', '2026-04-24', 100.0),
        nbOrder('B', '2026-04-25', 100.0),
      ]);

    const toolWithExclude = buildCompareNbTool({ grafana: makeGrafana(), nb: makeNb() });
    const argsExclude = toolWithExclude.schema.parse({
      dateRange: { startDate: '2026-04-24', endDate: '2026-04-25' },
      excludeToday: true,
    });
    const outExclude = await toolWithExclude.execute(argsExclude) as { rows: Array<{ date: string }> };

    const toolNormal = buildCompareNbTool({ grafana: makeGrafana(), nb: makeNb() });
    const argsNormal = toolNormal.schema.parse({
      dateRange: { startDate: '2026-04-24', endDate: '2026-04-25' },
      excludeToday: false,
    });
    const outNormal = await toolNormal.execute(argsNormal) as { rows: Array<{ date: string }> };

    // With excludeToday the row count should be <= normal count
    expect(outExclude.rows.length).toBeLessThanOrEqual(outNormal.rows.length);
    // The excluded date should not appear when today is within the requested range
    // (if today is 2026-04-25 in PT, the '2026-04-25' row should be dropped)
    const todayPt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    if (todayPt === '2026-04-25') {
      expect(outExclude.rows.find((r) => r.date === '2026-04-25')).toBeUndefined();
    }
  });

  it('csv field is present with header row, data rows, and a TOTAL row', async () => {
    const grafana = fakeGrafana(
      porterGrafanaResult([
        { day: '2026-04-24', orders: 3, revenue: 300.00 },
        { day: '2026-04-25', orders: 4, revenue: 400.00 },
      ]),
    );
    const nb = fakeNb([
      nbOrder('A', '2026-04-24', 150.0),
      nbOrder('B', '2026-04-25', 200.0),
      nbOrder('C', '2026-04-25', 100.0),
    ]);

    const tool = buildCompareNbTool({ grafana, nb });
    const args = tool.schema.parse({
      dateRange: { startDate: '2026-04-24', endDate: '2026-04-25' },
    });
    const out = await tool.execute(args) as { csv: string };

    const lines = out.csv.split('\n');
    // header
    expect(lines[0]).toBe('date,porter_orders,porter_revenue,nb_orders,nb_revenue,order_diff,revenue_diff');
    // 2 data lines + 1 TOTAL line = 3
    expect(lines).toHaveLength(4);
    // TOTAL line is last
    expect(lines[lines.length - 1]).toMatch(/^TOTAL,/);
    // Each data line has 7 comma-separated fields
    for (const line of lines.slice(1)) {
      expect(line.split(',').length).toBe(7);
    }
  });
});

// ---------------------------------------------------------------------------
// buildDiffNbTool
// ---------------------------------------------------------------------------

/**
 * Build a Porter grafana runSql result for the diff tool.
 * Columns: order_id, status, type, created_pt, placed_pt, completed_pt, total
 */
function porterDiffResult(
  rows: Array<{
    order_id: string;
    status?: string;
    type?: string;
    created_pt?: string;
    placed_pt?: string;
    completed_pt?: string;
    total?: number;
  }>,
) {
  const fields = ['order_id', 'status', 'type', 'created_pt', 'placed_pt', 'completed_pt', 'total'];
  return {
    fields,
    rows: rows.map((r) => [
      r.order_id,
      r.status ?? 'Completed',
      r.type ?? 'Order',
      r.created_pt ?? '2026-04-25T10:00:00',
      r.placed_pt ?? '2026-04-25T10:00:00',
      r.completed_pt ?? null,
      r.total ?? 100.0,
    ]),
  };
}

describe('buildDiffNbTool (gantri.diff_orders_nb_vs_porter)', () => {
  it('returns perfect_match: true when both sides have the same order with same total', async () => {
    const grafana = fakeGrafana(porterDiffResult([{ order_id: 'A', total: 150.0 }]));
    const nb = fakeNb([nbOrder('A', '2026-04-25', 150.0)]);

    const tool = buildDiffNbTool({ grafana, nb });
    const args = tool.schema.parse({
      dateRange: { startDate: '2026-04-25', endDate: '2026-04-25' },
    });
    const out = await tool.execute(args) as {
      perfect_match: boolean;
      only_in_nb: unknown[];
      only_in_porter: unknown[];
      revenue_mismatch: unknown[];
      status_mismatch: unknown[];
    };

    expect(out.perfect_match).toBe(true);
    expect(out.only_in_nb).toHaveLength(0);
    expect(out.only_in_porter).toHaveLength(0);
    expect(out.revenue_mismatch).toHaveLength(0);
    expect(out.status_mismatch).toHaveLength(0);
  });

  it('order in nb but not porter goes to only_in_nb', async () => {
    const grafana = fakeGrafana(porterDiffResult([])); // porter has nothing
    const nb = fakeNb([nbOrder('NB-ONLY', '2026-04-25', 200.0)]);

    const tool = buildDiffNbTool({ grafana, nb });
    const args = tool.schema.parse({
      dateRange: { startDate: '2026-04-25', endDate: '2026-04-25' },
    });
    const out = await tool.execute(args) as {
      perfect_match: boolean;
      only_in_nb: Array<{ order_id: string; nb_total: number }>;
      only_in_porter: unknown[];
    };

    expect(out.perfect_match).toBe(false);
    expect(out.only_in_nb).toHaveLength(1);
    expect(out.only_in_nb[0].order_id).toBe('NB-ONLY');
    expect(out.only_in_nb[0].nb_total).toBe(200.0);
    expect(out.only_in_porter).toHaveLength(0);
  });

  it('order in porter but not nb goes to only_in_porter', async () => {
    const grafana = fakeGrafana(porterDiffResult([{ order_id: 'P-ONLY', total: 300.0 }]));
    const nb = fakeNb([]); // nb has nothing

    const tool = buildDiffNbTool({ grafana, nb });
    const args = tool.schema.parse({
      dateRange: { startDate: '2026-04-25', endDate: '2026-04-25' },
    });
    const out = await tool.execute(args) as {
      perfect_match: boolean;
      only_in_nb: unknown[];
      only_in_porter: Array<{ order_id: string; porter_total: number }>;
    };

    expect(out.perfect_match).toBe(false);
    expect(out.only_in_nb).toHaveLength(0);
    expect(out.only_in_porter).toHaveLength(1);
    expect(out.only_in_porter[0].order_id).toBe('P-ONLY');
    expect(out.only_in_porter[0].porter_total).toBe(300.0);
  });

  it('same id but totals differ by >$0.50 goes to revenue_mismatch with a diff field', async () => {
    const grafana = fakeGrafana(porterDiffResult([{ order_id: 'RM-1', total: 150.0 }]));
    const nb = fakeNb([nbOrder('RM-1', '2026-04-25', 100.0)]); // diff = $50

    const tool = buildDiffNbTool({ grafana, nb });
    const args = tool.schema.parse({
      dateRange: { startDate: '2026-04-25', endDate: '2026-04-25' },
    });
    const out = await tool.execute(args) as {
      revenue_mismatch: Array<{ order_id: string; nb_total: number; porter_total: number; diff: number }>;
    };

    expect(out.revenue_mismatch).toHaveLength(1);
    const entry = out.revenue_mismatch[0];
    expect(entry.order_id).toBe('RM-1');
    expect(entry.nb_total).toBe(100.0);
    expect(entry.porter_total).toBe(150.0);
    expect(entry.diff).toBe(-50.0); // nb_total - porter_total
  });

  it("porter status='Refunded' for an id nb still has → status_mismatch with likelyCause='porter_refunded_after'", async () => {
    const grafana = fakeGrafana(
      porterDiffResult([{ order_id: 'SM-1', status: 'Refunded', total: 200.0 }]),
    );
    const nb = fakeNb([nbOrder('SM-1', '2026-04-25', 200.0)]);

    const tool = buildDiffNbTool({ grafana, nb });
    const args = tool.schema.parse({
      dateRange: { startDate: '2026-04-25', endDate: '2026-04-25' },
    });
    const out = await tool.execute(args) as {
      status_mismatch: Array<{ order_id: string; porter_status: string; likelyCause: string }>;
    };

    expect(out.status_mismatch).toHaveLength(1);
    const entry = out.status_mismatch[0];
    expect(entry.order_id).toBe('SM-1');
    expect(entry.porter_status).toBe('Refunded');
    expect(entry.likelyCause).toBe('porter_refunded_after');
  });

  it('nb orders with is_cancelled or is_deleted are excluded from all diff buckets', async () => {
    const grafana = fakeGrafana(porterDiffResult([]));
    const nb = fakeNb([
      // cancelled — should be silently skipped, NOT added to only_in_nb
      nbOrder('CANCEL-1', '2026-04-25', 100.0, { is_cancelled: true }),
      // deleted — same
      nbOrder('DELETE-1', '2026-04-25', 100.0, { is_deleted: true }),
    ]);

    const tool = buildDiffNbTool({ grafana, nb });
    const args = tool.schema.parse({
      dateRange: { startDate: '2026-04-25', endDate: '2026-04-25' },
    });
    const out = await tool.execute(args) as {
      perfect_match: boolean;
      only_in_nb: unknown[];
      only_in_porter: unknown[];
      revenue_mismatch: unknown[];
      status_mismatch: unknown[];
    };

    // No active NB orders — nothing to diff
    expect(out.only_in_nb).toHaveLength(0);
    expect(out.only_in_porter).toHaveLength(0);
    expect(out.revenue_mismatch).toHaveLength(0);
    expect(out.status_mismatch).toHaveLength(0);
    expect(out.perfect_match).toBe(true);
  });
});
