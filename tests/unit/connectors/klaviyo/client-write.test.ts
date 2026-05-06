import { describe, it, expect, vi } from 'vitest';
import { KlaviyoApiClient } from '../../../../src/connectors/klaviyo/client.js';

function fakeFetch(impl: (url: string, init: any) => Promise<{ status: number; body: unknown }>) {
  return vi.fn(async (url: string, init: any) => {
    const r = await impl(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

describe('KlaviyoApiClient.bulkSubscribeProfiles', () => {
  it('builds correct JSON:API body with both channels and a list_id', async () => {
    let captured: any = null;
    const fetchImpl = fakeFetch(async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return { status: 202, body: { data: { id: 'job-1' } } };
    });
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    const r = await client.bulkSubscribeProfiles({
      profiles: [
        { email: 'a@x.com', first_name: 'A', phone_number: '+14155550100' },
        { email: 'b@y.com' },
      ],
      listId: 'L1',
      channels: ['email', 'sms'],
      consentedAt: '2026-05-05T10:00:00Z',
      defaultConsentSource: 'BDNY 2026',
    });
    expect(r.job_id).toBe('job-1');
    expect(captured.url).toBe('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs');
    const body = captured.body.data.attributes;
    expect(body.list_id).toBe('L1');
    expect(body.profiles[0].subscriptions.email.marketing.consent).toBe('SUBSCRIBED');
    expect(body.profiles[0].subscriptions.sms.marketing.consent).toBe('SUBSCRIBED');
    expect(body.profiles[0].custom_source).toBe('BDNY 2026');
    expect(body.profiles[0].consented_at).toBe('2026-05-05T10:00:00Z');
    expect(body.profiles[0].phone_number).toBe('+14155550100');
    expect(body.profiles[0].first_name).toBe('A');
    expect(body.historical_import).toBe(false);
  });

  it('omits sms subscription when channels is email-only', async () => {
    let captured: any = null;
    const fetchImpl = fakeFetch(async (_url, init) => {
      captured = JSON.parse(init.body);
      return { status: 202, body: { data: { id: 'j' } } };
    });
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    await client.bulkSubscribeProfiles({ profiles: [{ email: 'a@x.com' }], channels: ['email'] });
    const sub = captured.data.attributes.profiles[0].subscriptions;
    expect(sub.email).toBeDefined();
    expect(sub.sms).toBeUndefined();
  });

  it('omits list_id when undefined', async () => {
    let captured: any = null;
    const fetchImpl = fakeFetch(async (_url, init) => {
      captured = JSON.parse(init.body);
      return { status: 202, body: { data: { id: 'j' } } };
    });
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    await client.bulkSubscribeProfiles({ profiles: [{ email: 'a@x.com' }], channels: ['email'] });
    expect(captured.data.attributes.list_id).toBeUndefined();
  });

  it('throws KlaviyoApiError on 4xx', async () => {
    const fetchImpl = fakeFetch(async () => ({ status: 400, body: { errors: [{ detail: 'bad' }] } }));
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    await expect(client.bulkSubscribeProfiles({ profiles: [{ email: 'a@x.com' }], channels: ['email'] })).rejects.toThrow();
  });

  it('per-row custom_source overrides defaultConsentSource', async () => {
    let captured: any = null;
    const fetchImpl = fakeFetch(async (_url, init) => {
      captured = JSON.parse(init.body);
      return { status: 202, body: { data: { id: 'j' } } };
    });
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    await client.bulkSubscribeProfiles({
      profiles: [
        { email: 'a@x.com', custom_source: 'inline override' },
        { email: 'b@y.com' },
      ],
      channels: ['email'],
      defaultConsentSource: 'batch fallback',
    });
    const profiles = captured.data.attributes.profiles;
    expect(profiles[0].custom_source).toBe('inline override');
    expect(profiles[1].custom_source).toBe('batch fallback');
  });
});

describe('KlaviyoApiClient.getBulkImportJobStatus', () => {
  it('returns parsed status', async () => {
    const fetchImpl = fakeFetch(async (url) => {
      expect(url).toContain('/api/profile-bulk-import-jobs/job-1');
      return {
        status: 200,
        body: { data: { id: 'job-1', attributes: { status: 'complete', total_count: 5, completed_count: 5, failed_count: 0 } } },
      };
    });
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    const r = await client.getBulkImportJobStatus('job-1');
    expect(r.jobId).toBe('job-1');
    expect(r.status).toBe('complete');
    expect(r.totalCount).toBe(5);
    expect(r.completedCount).toBe(5);
    expect(r.failedCount).toBe(0);
  });

  it('returns errors array when failed', async () => {
    const fetchImpl = fakeFetch(async () => ({
      status: 200,
      body: { data: { id: 'j2', attributes: { status: 'failed', errors: [{ detail: 'malformed payload' }] } } },
    }));
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    const r = await client.getBulkImportJobStatus('j2');
    expect(r.status).toBe('failed');
    expect(r.errors).toEqual([{ detail: 'malformed payload' }]);
  });
});

describe('KlaviyoApiClient.findProfileByEmail', () => {
  it('returns null when data is empty', async () => {
    const fetchImpl = fakeFetch(async () => ({ status: 200, body: { data: [] } }));
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    const r = await client.findProfileByEmail('nope@x.com');
    expect(r).toBeNull();
  });

  it('returns profile + lists', async () => {
    const fetchImpl = fakeFetch(async (url) => {
      expect(url).toContain('filter=');
      expect(decodeURIComponent(url)).toContain('equals(email,"a@x.com")');
      return {
        status: 200,
        body: {
          data: [{
            id: 'pid1',
            attributes: { email: 'a@x.com', created: '2024-08-12T19:03:45+00:00' },
            relationships: { lists: { data: [{ id: 'L1' }] } },
          }],
          included: [{ type: 'list', id: 'L1', attributes: { name: 'Trade Customers' } }],
        },
      };
    });
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    const r = await client.findProfileByEmail('a@x.com');
    expect(r).toEqual({ id: 'pid1', created_at: '2024-08-12T19:03:45+00:00', lists: ['Trade Customers'] });
  });

  it('falls back to created_at attribute name when present', async () => {
    const fetchImpl = fakeFetch(async () => ({
      status: 200,
      body: {
        data: [{
          id: 'pid1',
          attributes: { email: 'a@x.com', created_at: '2024-08-12T19:03:45+00:00' },
          relationships: { lists: { data: [] } },
        }],
        included: [],
      },
    }));
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    const r = await client.findProfileByEmail('a@x.com');
    expect(r?.created_at).toBe('2024-08-12T19:03:45+00:00');
    expect(r?.lists).toEqual([]);
  });

  it('returns list id when included entry is missing', async () => {
    const fetchImpl = fakeFetch(async () => ({
      status: 200,
      body: {
        data: [{
          id: 'pid1',
          attributes: { email: 'a@x.com', created: '2024-01-01T00:00:00Z' },
          relationships: { lists: { data: [{ id: 'L1' }, { id: 'L2' }] } },
        }],
        included: [{ type: 'list', id: 'L1', attributes: { name: 'Trade' } }],
      },
    }));
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    const r = await client.findProfileByEmail('a@x.com');
    expect(r?.lists).toEqual(['Trade', 'L2']);
  });
});

describe('KlaviyoApiClient.requestProfileDeletion', () => {
  it('builds correct JSON:API body for email identifier', async () => {
    let captured: any = null;
    const fetchImpl = fakeFetch(async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return { status: 202, body: { data: { id: 'del-1' } } };
    });
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    const r = await client.requestProfileDeletion({ email: 'junk@x.com' });
    expect(r.deletion_job_id).toBe('del-1');
    expect(captured.url).toBe('https://a.klaviyo.com/api/data-privacy-deletion-jobs');
    expect(captured.body.data.type).toBe('data-privacy-deletion-job');
    expect(captured.body.data.attributes.profile.data.attributes.email).toBe('junk@x.com');
  });

  it('uses profile_id when no email passed', async () => {
    let captured: any = null;
    const fetchImpl = fakeFetch(async (_u, init) => {
      captured = JSON.parse(init.body);
      return { status: 202, body: { data: { id: 'del-2' } } };
    });
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    await client.requestProfileDeletion({ profile_id: 'pid-123' });
    expect(captured.data.attributes.profile.data.attributes.id).toBe('pid-123');
    expect(captured.data.attributes.profile.data.attributes.email).toBeUndefined();
  });

  it('throws when no identifier provided', async () => {
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl: fakeFetch(async () => ({ status: 200, body: {} })) });
    await expect(client.requestProfileDeletion({} as any)).rejects.toThrow();
  });

  it('throws on 4xx', async () => {
    const fetchImpl = fakeFetch(async () => ({ status: 400, body: { errors: [{ detail: 'bad' }] } }));
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    await expect(client.requestProfileDeletion({ email: 'x@y.com' })).rejects.toThrow();
  });
});

describe('KlaviyoApiClient.listLists', () => {
  it('returns id+name pairs and uses page[size]=10 (Klaviyo /api/lists cap)', async () => {
    let capturedUrl: string | null = null;
    const fetchImpl = fakeFetch(async (url) => {
      capturedUrl = url;
      expect(url).toContain('/api/lists');
      return {
        status: 200,
        body: {
          data: [
            { id: 'L1', attributes: { name: 'Trade Customers' } },
            { id: 'L2', attributes: { name: 'BDNY Booth 2026' } },
          ],
          links: {},
        },
      };
    });
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    const r = await client.listLists();
    expect(r).toEqual([
      { id: 'L1', name: 'Trade Customers' },
      { id: 'L2', name: 'BDNY Booth 2026' },
    ]);
    // Klaviyo's /api/lists endpoint caps page[size] at 10 (sending 100 returns 400).
    expect(capturedUrl).toContain('page%5Bsize%5D=10');
    expect(capturedUrl).not.toContain('page%5Bsize%5D=100');
  });

  it('paginates via links.next when account has more than 10 lists', async () => {
    let callCount = 0;
    const fetchImpl = fakeFetch(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          status: 200,
          body: {
            data: Array.from({ length: 10 }, (_, i) => ({ id: `L${i}`, attributes: { name: `List ${i}` } })),
            links: { next: 'https://a.klaviyo.com/api/lists?page%5Bcursor%5D=cursor1' },
          },
        };
      }
      return {
        status: 200,
        body: {
          data: [{ id: 'L10', attributes: { name: 'List 10' } }],
          links: {},
        },
      };
    });
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    const r = await client.listLists();
    expect(r.length).toBe(11);
    expect(callCount).toBe(2);
  });

  it('handles empty list response', async () => {
    const fetchImpl = fakeFetch(async () => ({ status: 200, body: { data: [] } }));
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    const r = await client.listLists();
    expect(r).toEqual([]);
  });
});
