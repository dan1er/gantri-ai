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
