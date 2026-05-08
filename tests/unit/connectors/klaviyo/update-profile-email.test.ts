import { describe, it, expect, vi } from 'vitest';
import { KlaviyoApiClient } from '../../../../src/connectors/klaviyo/client.js';

function fakeFetch(handler: (url: string, init?: any) => Promise<Response>) {
  return vi.fn(handler) as unknown as typeof fetch;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/vnd.api+json' } });
}

describe('KlaviyoApiClient — updateProfileEmail', () => {
  it('PATCHes /api/profiles/{id} with the JSON:API body shape', async () => {
    const fetchImpl = fakeFetch(async (url, init) => {
      expect(url).toMatch(/\/api\/profiles\/01JHPN57KPZFTJVN8D4D2WVK2H$/);
      expect(init?.method).toBe('PATCH');
      expect(init?.headers?.['Authorization']).toMatch(/^Klaviyo-API-Key /);
      expect(init?.headers?.['content-type']).toBe('application/vnd.api+json');
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({
        data: {
          type: 'profile',
          id: '01JHPN57KPZFTJVN8D4D2WVK2H',
          attributes: { email: 'new@example.com' },
        },
      });
      return jsonRes({ data: { id: '01JHPN57KPZFTJVN8D4D2WVK2H' } });
    });
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    await client.updateProfileEmail('01JHPN57KPZFTJVN8D4D2WVK2H', 'new@example.com');
  });

  it('throws on 404 (profile not found)', async () => {
    const fetchImpl = fakeFetch(async () => new Response(JSON.stringify({ errors: [{ code: 'not_found' }] }), { status: 404, headers: { 'content-type': 'application/vnd.api+json' } }));
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    await expect(client.updateProfileEmail('missing', 'x@y.com')).rejects.toThrow();
  });

  it('throws on 409 (email conflict)', async () => {
    const fetchImpl = fakeFetch(async () => new Response(JSON.stringify({ errors: [{ code: 'duplicate_profile' }] }), { status: 409, headers: { 'content-type': 'application/vnd.api+json' } }));
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    await expect(client.updateProfileEmail('p1', 'taken@y.com')).rejects.toThrow();
  });
});
