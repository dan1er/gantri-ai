import { describe, it, expect, vi } from 'vitest';
import { KlaviyoApiClient } from '../../../../src/connectors/klaviyo/client.js';

describe('KlaviyoApiClient.streamProfilesByCreatedRange', () => {
  it('builds the filter + additional-fields query string and streams items page-by-page', async () => {
    const fetchImpl = vi.fn();
    let call = 0;
    fetchImpl.mockImplementation(async (url: string) => {
      call++;
      const u = new URL(url);
      if (call === 1) {
        const filter = u.searchParams.get('filter');
        expect(filter).toBe('and(greater-than(created,2025-12-31T23:59:59.999Z),less-than(created,2026-02-01T00:00:00.000Z))');
        expect(u.searchParams.get('additional-fields[profile]')).toBe('subscriptions');
        return new Response(JSON.stringify({
          data: [{ id: '1', type: 'profile', attributes: { created: '2026-01-15T10:00:00.000Z', subscriptions: { email: { marketing: { consent: 'SUBSCRIBED' } } } } }],
          links: { next: 'https://a.klaviyo.com/api/profiles?page[cursor]=p2' },
        }), { status: 200 });
      }
      if (call === 2) {
        return new Response(JSON.stringify({
          data: [{ id: '2', type: 'profile', attributes: { created: '2026-01-20T10:00:00.000Z', subscriptions: null } }],
          links: { next: 'https://a.klaviyo.com/api/profiles?page[cursor]=p3' },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: '3', type: 'profile', attributes: { created: '2026-01-25T10:00:00.000Z' } }], links: {} }), { status: 200 });
    });

    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    const seen: string[] = [];
    const result = await client.streamProfilesByCreatedRange(
      { startDate: '2026-01-01', endDate: '2026-01-31' },
      (p) => { seen.push(p.id); },
    );
    expect(result).toEqual({ pages: 3, items: 3 });
    expect(seen).toEqual(['1', '2', '3']);
    expect(call).toBe(3);
  });

  it('throws if pagination exceeds the 10000-page sanity cap', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(
      JSON.stringify({ data: [{ id: 'x', type: 'profile', attributes: { created: '2026-01-15T10:00:00.000Z' } }], links: { next: 'https://a.klaviyo.com/api/profiles?page[cursor]=loop' } }),
      { status: 200 },
    ));
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    await expect(client.streamProfilesByCreatedRange(
      { startDate: '2026-01-01', endDate: '2026-01-31' },
      () => {},
    )).rejects.toThrow(/sanity cap/);
  });
});
