import { describe, it, expect, vi } from 'vitest';
import { Ga4Connector } from '../../../src/connectors/ga4/connector.js';
import type { Ga4Client } from '../../../src/connectors/ga4/client.js';

function fakeClient(report: unknown): Ga4Client {
  return {
    runReport: vi.fn(async () => report),
    runRealtimeReport: vi.fn(),
  } as unknown as Ga4Client;
}

describe('Ga4Connector.ga4.run_report', () => {
  it('exposes the tool and validates args via Zod', async () => {
    const conn = new Ga4Connector({ client: fakeClient({}) });
    const tool = conn.tools.find((t) => t.name === 'ga4.run_report');
    expect(tool).toBeDefined();
    // missing required `metrics` should fail validation when called via the registry,
    // but here we exercise the schema directly:
    expect(tool!.schema.safeParse({}).success).toBe(false);
    expect(tool!.schema.safeParse({ metrics: ['sessions'] }).success).toBe(true);
  });

  it('reshapes the GA4 response into a flat rows array', async () => {
    const client = fakeClient({
      dimensionHeaders: [{ name: 'sessionDefaultChannelGroup' }],
      metricHeaders: [{ name: 'sessions', type: 'TYPE_INTEGER' }, { name: 'totalUsers', type: 'TYPE_INTEGER' }],
      rows: [
        { dimensionValues: [{ value: 'Direct' }], metricValues: [{ value: '120' }, { value: '95' }] },
        { dimensionValues: [{ value: 'Organic Search' }], metricValues: [{ value: '60' }, { value: '40' }] },
      ],
      rowCount: 2,
    });
    const conn = new Ga4Connector({ client });
    const tool = conn.tools.find((t) => t.name === 'ga4.run_report')!;
    const out = await tool.execute({
      dateRange: 'last_7_days',
      dimensions: ['sessionDefaultChannelGroup'],
      metrics: ['sessions', 'totalUsers'],
    }) as { rows: Array<Record<string, unknown>>; rowCount: number };
    expect(out.rowCount).toBe(2);
    expect(out.rows).toEqual([
      { sessionDefaultChannelGroup: 'Direct', sessions: 120, totalUsers: 95 },
      { sessionDefaultChannelGroup: 'Organic Search', sessions: 60, totalUsers: 40 },
    ]);
  });

  it('translates preset dateRange to GA4 relative-date strings', async () => {
    const client = { runReport: vi.fn(async () => ({ rows: [], rowCount: 0, dimensionHeaders: [], metricHeaders: [] })) } as unknown as Ga4Client;
    const conn = new Ga4Connector({ client });
    const tool = conn.tools.find((t) => t.name === 'ga4.run_report')!;
    await tool.execute({ dateRange: 'last_30_days', metrics: ['sessions'] });
    expect((client.runReport as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
      metrics: [{ name: 'sessions' }],
    });
  });
});
