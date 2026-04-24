import { describe, it, expect, vi, afterEach } from 'vitest';
import { NorthbeamGraphqlClient } from '../../../src/connectors/northbeam/graphql-client.js';

describe('NorthbeamGraphqlClient', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it('sends required headers and returns data on success', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer jwt-xxx');
      expect(headers.get('x-nb-dashboard-id')).toBe('ws-1');
      expect(headers.get('x-nb-impersonate-user')).toBe('ws-1');
      expect(headers.get('content-type')).toBe('application/json');
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    });
    globalThis.fetch = fetchMock as any;

    const client = new NorthbeamGraphqlClient({
      getToken: async () => 'jwt-xxx',
      dashboardId: 'ws-1',
    });
    const data = await client.request<{ ok: boolean }>('MyOp', 'query MyOp { me { id } }', { a: 1 });
    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when response contains GraphQL errors', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ errors: [{ message: 'boom' }] }), { status: 200 }),
    ) as any;
    const client = new NorthbeamGraphqlClient({
      getToken: async () => 'jwt',
      dashboardId: 'ws',
    });
    await expect(client.request('Op', 'query { x }', {})).rejects.toThrow(/boom/);
  });

  it('throws with HTTP status when non-2xx', async () => {
    globalThis.fetch = vi.fn(async () => new Response('unauthorized', { status: 401 })) as any;
    const client = new NorthbeamGraphqlClient({
      getToken: async () => 'jwt',
      dashboardId: 'ws',
    });
    await expect(client.request('Op', 'query { x }', {})).rejects.toThrow(/401/);
  });
});
