import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Ga4Client } from '../../../src/connectors/ga4/client.js';

const FAKE_KEY = {
  type: 'service_account',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n',
  client_email: 'test@test.iam.gserviceaccount.com',
};

describe('Ga4Client.getAccessToken', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-04-26T00:00:00Z')); });

  it('caches the token until ~50 min after issue', async () => {
    const getRequestHeadersMock = vi.fn(async () => ({ Authorization: 'Bearer abc' }));
    const authFactory = () => ({ getRequestHeaders: getRequestHeadersMock });
    const client = new Ga4Client({
      propertyId: 'p1',
      serviceAccountKey: JSON.stringify(FAKE_KEY),
      authFactory: authFactory as never,
    });

    const h1 = await client.getAuthHeaders();
    const h2 = await client.getAuthHeaders();
    expect(h1).toEqual({ Authorization: 'Bearer abc' });
    expect(h2).toEqual({ Authorization: 'Bearer abc' });
    expect(getRequestHeadersMock).toHaveBeenCalledTimes(1);

    // Advance past the cache TTL
    vi.setSystemTime(new Date('2026-04-26T00:51:00Z'));
    await client.getAuthHeaders();
    expect(getRequestHeadersMock).toHaveBeenCalledTimes(2);
  });
});

describe('Ga4Client.runReport', () => {
  it('POSTs to runReport with auth header and parses the response', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://analyticsdata.googleapis.com/v1beta/properties/12345:runReport');
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer abc');
      expect(headers.get('content-type')).toBe('application/json');
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({
        dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
        metrics: [{ name: 'sessions' }],
        limit: 100,
      });
      return new Response(JSON.stringify({
        dimensionHeaders: [{ name: 'sessionDefaultChannelGroup' }],
        metricHeaders: [{ name: 'sessions', type: 'TYPE_INTEGER' }],
        rows: [{ dimensionValues: [{ value: 'Direct' }], metricValues: [{ value: '1234' }] }],
        rowCount: 1,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = new Ga4Client({
      propertyId: '12345',
      serviceAccountKey: JSON.stringify(FAKE_KEY),
      authFactory: () => ({ getRequestHeaders: async () => ({ Authorization: 'Bearer abc' }) }) as never,
      fetchImpl: fetchMock as never,
    });
    const out = await client.runReport({
      dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }],
      limit: 100,
    });
    expect(out.rowCount).toBe(1);
    expect(out.rows[0].dimensionValues[0].value).toBe('Direct');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws Ga4ApiError with status + body on non-2xx', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('{"error":{"message":"PERMISSION_DENIED","code":403}}', { status: 403 }),
    );
    const client = new Ga4Client({
      propertyId: '12345',
      serviceAccountKey: JSON.stringify(FAKE_KEY),
      authFactory: () => ({ getRequestHeaders: async () => ({ Authorization: 'Bearer x' }) }) as never,
      fetchImpl: fetchMock as never,
    });
    await expect(
      client.runReport({ dateRanges: [{ startDate: 'today', endDate: 'today' }], metrics: [{ name: 'sessions' }] }),
    ).rejects.toThrow(/403.*PERMISSION_DENIED/);
  });
});

describe('Ga4Client.runRealtimeReport', () => {
  it('POSTs to runRealtimeReport endpoint', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://analyticsdata.googleapis.com/v1beta/properties/12345:runRealtimeReport');
      return new Response(JSON.stringify({
        dimensionHeaders: [{ name: 'country' }],
        metricHeaders: [{ name: 'activeUsers', type: 'TYPE_INTEGER' }],
        rows: [{ dimensionValues: [{ value: 'United States' }], metricValues: [{ value: '12' }] }],
        rowCount: 1,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = new Ga4Client({
      propertyId: '12345',
      serviceAccountKey: JSON.stringify(FAKE_KEY),
      authFactory: () => ({ getRequestHeaders: async () => ({ Authorization: 'Bearer x' }) }) as never,
      fetchImpl: fetchMock as never,
    });
    const out = await client.runRealtimeReport({
      dimensions: [{ name: 'country' }],
      metrics: [{ name: 'activeUsers' }],
    });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].metricValues[0].value).toBe('12');
  });
});
