import { describe, it, expect, vi } from 'vitest';
import { PipedriveApiClient, PipedriveApiError } from '../../../../src/connectors/pipedrive/client.js';

describe('PipedriveApiClient core', () => {
  it('attaches Authorization: api_token=<token> header on every request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }),
    );
    const client = new PipedriveApiClient({ apiToken: 'tok_abc', fetchImpl });
    await client.listPipelines();
    const [, opts] = fetchImpl.mock.calls[0];
    expect(opts.headers.Authorization).toBe('api_token=tok_abc');
    expect(opts.headers.Accept).toBe('application/json');
  });

  it('does NOT put api_token in the URL query string (avoids token leakage to logs)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }),
    );
    const client = new PipedriveApiClient({ apiToken: 'tok_abc', fetchImpl });
    await client.listPipelines();
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).not.toMatch(/api_token=/);
  });

  it('throws PipedriveApiError on 4xx with status + body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 }),
    );
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    await expect(client.listPipelines()).rejects.toBeInstanceOf(PipedriveApiError);
    try { await client.listPipelines(); } catch (e) {
      expect((e as PipedriveApiError).status).toBe(401);
      expect((e as PipedriveApiError).body).toEqual({ success: false, error: 'Unauthorized' });
    }
  });

  it('retries once on 429 then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{ id: 1 }] }), { status: 200 }));
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl, retryDelayMs: 1 });
    const out = await client.listPipelines();
    expect(out).toEqual([{ id: 1 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries once on 5xx then throws if still failing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 503 }));
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl, retryDelayMs: 1 });
    await expect(client.listPipelines()).rejects.toBeInstanceOf(PipedriveApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it('paginate<T>() respects maxPages cap', async () => {
    let page = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      page += 1;
      return new Response(JSON.stringify({
        success: true,
        data: [{ id: page }],
        additional_data: { pagination: { more_items_in_collection: true, next_start: page * 100 } },
      }), { status: 200 });
    });
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    // listUsers uses paginate internally with maxPages=10 by default; force a small cap to assert.
    const result = await (client as unknown as { paginateForTest: (path: string, query: Record<string, string>, maxPages: number) => Promise<{ items: unknown[]; hasMore: boolean }> })
      .paginateForTest('/v1/users', {}, 3);
    expect(result.items.length).toBe(3);
    expect(result.hasMore).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('PipedriveApiClient directory + 10-min cache', () => {
  it('listPipelines roundtrips and caches across calls', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: [{ id: 1, name: 'Trade' }] }), { status: 200 }),
    );
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const a = await client.listPipelines();
    const b = await client.listPipelines();
    expect(a).toEqual([{ id: 1, name: 'Trade' }]);
    expect(b).toEqual(a);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // cached
  });

  it('listStages, listUsers, listDealFields each roundtrip independently', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/v1/stages')) return new Response(JSON.stringify({ success: true, data: [{ id: 11, name: 'Discovery', pipeline_id: 3 }] }), { status: 200 });
      if (url.includes('/v1/users')) return new Response(JSON.stringify({ success: true, data: [{ id: 7, name: 'Lana' }] }), { status: 200 });
      if (url.includes('/v1/dealFields')) return new Response(JSON.stringify({ success: true, data: [{ key: 'abc', name: 'Source' }] }), { status: 200 });
      return new Response('nope', { status: 404 });
    });
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    expect(await client.listStages()).toEqual([{ id: 11, name: 'Discovery', pipeline_id: 3 }]);
    expect(await client.listUsers()).toEqual([{ id: 7, name: 'Lana' }]);
    expect(await client.listDealFields()).toEqual([{ key: 'abc', name: 'Source' }]);
  });

  it('cache TTL expires (forced via clock injection)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: [{ id: 1 }] }), { status: 200 }),
    );
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    await client.listPipelines();
    now.mockReturnValue(1_000_000 + 11 * 60 * 1000); // +11 min — past TTL
    await client.listPipelines();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });
});

describe('PipedriveApiClient aggregations', () => {
  it('dealsTimeline parses totals.{count, values, weighted_values, open_count, open_values, won_count, won_values}', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        period_start: '2026-01-01',
        period_count: 3,
        period_units: 'month',
        totals: {
          count: 30,
          values: { USD: 150000 },
          weighted_values: { USD: 75000 },
          open_count: 10, open_values: { USD: 50000 },
          won_count: 18, won_values: { USD: 90000 },
        },
        data: [
          { period_start: '2026-01-01', period_end: '2026-01-31', totals: {
            count: 12, values: { USD: 60000 }, weighted_values: { USD: 30000 },
            open_count: 4, open_values: { USD: 20000 },
            won_count: 7, won_values: { USD: 35000 },
          }, deals: [] },
          { period_start: '2026-02-01', period_end: '2026-02-28', totals: {
            count: 9, values: { USD: 45000 }, weighted_values: { USD: 22000 },
            open_count: 3, open_values: { USD: 15000 },
            won_count: 5, won_values: { USD: 25000 },
          }, deals: [] },
        ],
      },
    }), { status: 200 }));
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const out = await client.dealsTimeline({
      startDate: '2026-01-01', amount: 3, interval: 'month', fieldKey: 'won_time',
    });
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({
      period_start: '2026-01-01',
      count: 12,
      total_value_usd: 60000,
      weighted_value_usd: 30000,
      open_count: 4, open_value_usd: 20000,
      won_count: 7, won_value_usd: 35000,
    });
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/v1/deals/timeline');
    expect(String(url)).toContain('field_key=won_time');
    expect(String(url)).toContain('interval=month');
  });

  it('dealsSummary parses totals.{count, value, weighted_value} into flat shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        total_count: 157,
        total_currency_converted_value: 2481089,
        total_weighted_currency_converted_value: 1240500,
        values_total: { USD: { value: 2481089, count: 157, value_converted: 2481089 } },
      },
    }), { status: 200 }));
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const out = await client.dealsSummary({ status: 'open' });
    expect(out).toMatchObject({ count: 157, total_value_usd: 2481089, weighted_value_usd: 1240500 });
  });
});
