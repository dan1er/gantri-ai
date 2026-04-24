import { describe, it, expect, vi } from 'vitest';
import { buildNorthbeamTools } from '../../../src/connectors/northbeam/tools.js';

function fakeDeps() {
  return {
    gql: { request: vi.fn() },
    cache: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) },
    nowISO: () => '2026-04-24T00:00:00.000Z',
  };
}

describe('northbeam tools', () => {
  it('overview normalizes actual + comparison summaries and rows', async () => {
    const deps = fakeDeps();
    deps.gql.request.mockResolvedValue({
      me: {
        overviewMetricsReportV3: {
          rows: [{ date: '2026-04-17', metrics: { spend: 100 } }],
          summary: {
            actual: [{ metrics: { spend: 700 } }],
            comparison: [{ metrics: { spend: 650 } }],
          },
        },
      },
    });
    const tools = buildNorthbeamTools(deps as any);
    const overview = tools.find((t) => t.name === 'northbeam.overview')!;
    const result = await overview.execute({
      dateRange: { startDate: '2026-04-17', endDate: '2026-04-23' },
      metrics: ['spend'],
      compareToPreviousPeriod: true,
    });
    expect(result).toMatchObject({
      summary: { actual: { spend: 700 }, comparison: { spend: 650 } },
      rows: [{ date: '2026-04-17', metrics: { spend: 100 } }],
    });
  });

  it('sales rejects unknown metric id via schema', async () => {
    const deps = fakeDeps();
    const tools = buildNorthbeamTools(deps as any);
    const sales = tools.find((t) => t.name === 'northbeam.sales')!;
    const parsed = sales.schema.safeParse({
      level: 'campaign',
      dateRange: { startDate: '2026-04-01', endDate: '2026-04-07' },
      metrics: ['not_a_metric'],
    });
    expect(parsed.success).toBe(false);
  });

  it('list_breakdowns returns a normalized map', async () => {
    const deps = fakeDeps();
    deps.gql.request.mockResolvedValue({
      me: {
        salesBreakdownConfigs: [
          { key: 'Platform (Northbeam)', name: 'Platform (Northbeam)', choices: [{ value: 'Google Ads', label: 'Google Ads' }] },
        ],
      },
    });
    const tools = buildNorthbeamTools(deps as any);
    const lb = tools.find((t) => t.name === 'northbeam.list_breakdowns')!;
    const out: any = await lb.execute({});
    expect(out.breakdowns['Platform (Northbeam)']).toEqual(['Google Ads']);
  });
});
