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
