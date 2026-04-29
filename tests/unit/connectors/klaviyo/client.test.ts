import { describe, it, expect, vi } from 'vitest';
import { KlaviyoApiClient } from '../../../../src/connectors/klaviyo/client.js';

describe('KlaviyoApiClient.metricAggregateByName', () => {
  it('resolves the metric id by name and posts the right metric-aggregates body', async () => {
    const fetchImpl = vi.fn();
    let calls = 0;
    fetchImpl.mockImplementation(async (url: string, opts?: any) => {
      calls++;
      if (url.includes('/metrics') && !url.includes('/metric-aggregates')) {
        return new Response(JSON.stringify({
          data: [
            { id: 'M_OTHER', type: 'metric', attributes: { name: 'Placed Order' } },
            { id: 'M_SUB', type: 'metric', attributes: { name: 'Subscribed to Email Marketing' } },
          ],
          links: {},
        }), { status: 200 });
      }
      if (url.endsWith('/metric-aggregates/') && opts?.method === 'POST') {
        const body = JSON.parse(opts.body);
        expect(body.data.attributes.metric_id).toBe('M_SUB');
        expect(body.data.attributes.measurements).toEqual(['count']);
        expect(body.data.attributes.interval).toBe('month');
        expect(body.data.attributes.timezone).toBe('America/Los_Angeles');
        expect(body.data.attributes.filter).toEqual([
          'greater-or-equal(datetime,2026-01-01T00:00:00.000Z)',
          'less-than(datetime,2026-02-01T00:00:00.000Z)',
        ]);
        return new Response(JSON.stringify({
          data: { type: 'metric-aggregate', id: 'agg-1', attributes: {
            dates: ['2026-01-01T08:00:00+00:00'],
            data: [{ dimensions: [], measurements: { count: [929] } }],
          }},
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    const result = await client.metricAggregateByName({
      metricName: 'Subscribed to Email Marketing',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      interval: 'month',
    });
    expect(result.dates).toEqual(['2026-01-01T08:00:00+00:00']);
    expect(result.counts).toEqual([929]);
    expect(calls).toBe(2); // metrics list + metric-aggregates
  });

  it('throws if the metric name is not in the catalog', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/metrics') && !url.includes('/metric-aggregates')) {
        return new Response(JSON.stringify({ data: [], links: {} }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    await expect(client.metricAggregateByName({
      metricName: 'NoSuchMetric',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      interval: 'month',
    })).rejects.toThrow(/not found in catalog/);
  });
});
