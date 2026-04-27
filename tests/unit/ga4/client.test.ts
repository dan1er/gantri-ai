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
