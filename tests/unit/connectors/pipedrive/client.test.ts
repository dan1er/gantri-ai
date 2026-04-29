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

describe('PipedriveApiClient list endpoints', () => {
  it('listDeals uses v2 cursor pagination + passes filters', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: [{ id: 816, title: 'KBM-Hogue', value: 24500, currency: 'USD', status: 'open', stage_id: 11, pipeline_id: 3, owner_id: { id: 7, name: 'Lana' }, person_id: { value: 12, name: 'Tasha' }, org_id: { value: 5, name: 'KBM-Hogue' }, add_time: '2026-04-01T00:00:00Z', custom_fields: {} }],
      additional_data: { next_cursor: null },
    }), { status: 200 }));
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const out = await client.listDeals({ status: 'open', pipelineId: 3, limit: 100 });
    expect(out.items.length).toBe(1);
    expect(out.hasMore).toBe(false);
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/v2/deals');
    expect(String(url)).toContain('status=open');
    expect(String(url)).toContain('pipeline_id=3');
  });

  it('listOrganizations uses v2 cursor pagination', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true, data: [{ id: 5, name: 'KBM-Hogue' }], additional_data: { next_cursor: null },
    }), { status: 200 }));
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const out = await client.listOrganizations({ ids: [5] });
    expect(out.items.length).toBe(1);
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/v2/organizations');
  });

  it('listPersons uses v2 cursor pagination', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true, data: [{ id: 12, name: 'Tasha' }], additional_data: { next_cursor: null },
    }), { status: 200 }));
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const out = await client.listPersons({});
    expect(out.items.length).toBe(1);
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/v2/persons');
  });

  it('listActivities uses v1 offset pagination + passes filters', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true, data: [{ id: 100, type: 'call', subject: 'Discovery call', user_id: 7, done: 1, due_date: '2026-04-15' }],
      additional_data: { pagination: { start: 0, limit: 500, more_items_in_collection: false } },
    }), { status: 200 }));
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const out = await client.listActivities({ startDate: '2026-04-01', endDate: '2026-04-30', userId: 7, type: 'call', done: 1 });
    expect(out.items.length).toBe(1);
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/v1/activities');
    expect(String(url)).toContain('user_id=7');
    expect(String(url)).toContain('type=call');
    expect(String(url)).toContain('done=1');
  });
});

describe('PipedriveApiClient detail + search', () => {
  it('getDeal hits /v2/deals/{id}', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true, data: { id: 816, title: 'KBM-Hogue', value: 24500, currency: 'USD' },
    }), { status: 200 }));
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const out = await client.getDeal(816);
    expect(out.id).toBe(816);
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/v2/deals/816');
  });

  it('getOrganization hits /v2/organizations/{id}', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true, data: { id: 5, name: 'KBM-Hogue', address: '1 Main St', web: 'kbm.com' },
    }), { status: 200 }));
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const out = await client.getOrganization(5);
    expect(out.name).toBe('KBM-Hogue');
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/v2/organizations/5');
  });

  it('itemSearch hits /v1/itemSearch with query + entity filter', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        items: [
          { result_score: 0.92, item: { type: 'deal', id: 816, title: 'KBM-Hogue', value: 24500 } },
          { result_score: 0.71, item: { type: 'organization', id: 5, name: 'KBM-Hogue' } },
        ],
      },
    }), { status: 200 }));
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const out = await client.itemSearch({ term: 'KBM', itemTypes: ['deal', 'organization'], limit: 10 });
    expect(out.length).toBe(2);
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/v1/itemSearch');
    expect(String(url)).toContain('term=KBM');
    expect(String(url)).toContain('item_types=deal%2Corganization');
  });
});
