import { describe, it, expect, vi } from 'vitest';
import { PipedriveApiClient } from '../../../../src/connectors/pipedrive/client.js';

function fakeFetch(handler: (url: string, init?: any) => Promise<Response>) {
  return vi.fn(handler) as unknown as typeof fetch;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('PipedriveApiClient — write methods', () => {
  it('findPersonByEmail returns first hit when search has results', async () => {
    const fetchImpl = fakeFetch(async (url) => {
      expect(url).toContain('/v1/persons/search');
      expect(url).toContain('term=jane%40foo.com');
      expect(url).toContain('fields=email');
      expect(url).toContain('exact_match=true');
      return jsonRes({ success: true, data: { items: [{ item: { id: 9012, name: 'Jane Doe' } }] } });
    });
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const r = await client.findPersonByEmail('jane@foo.com');
    expect(r).toEqual({ id: 9012, name: 'Jane Doe' });
  });

  it('findPersonByEmail returns null on empty results', async () => {
    const fetchImpl = fakeFetch(async () => jsonRes({ success: true, data: { items: [] } }));
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const r = await client.findPersonByEmail('nobody@foo.com');
    expect(r).toBeNull();
  });

  it('findOrganizationByName returns first hit', async () => {
    const fetchImpl = fakeFetch(async (url) => {
      expect(url).toContain('/v1/organizations/search');
      return jsonRes({ success: true, data: { items: [{ item: { id: 7843, name: 'Foo Studio' } }] } });
    });
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const r = await client.findOrganizationByName('Foo Studio');
    expect(r).toEqual({ id: 7843, name: 'Foo Studio' });
  });

  it('createPerson POSTs the right body', async () => {
    const fetchImpl = fakeFetch(async (url, init) => {
      expect(url).toMatch(/\/v1\/persons$/);
      expect(init?.method).toBe('POST');
      expect(init?.headers?.['content-type']).toBe('application/json');
      const body = JSON.parse(init?.body as string);
      expect(body.name).toBe('Jane Doe');
      expect(body.email).toEqual([{ value: 'jane@foo.com', primary: true, label: 'work' }]);
      expect(body.phone).toEqual([{ value: '+1 415 555 0101', primary: true, label: 'work' }]);
      expect(body.org_id).toBe(7843);
      return jsonRes({ success: true, data: { id: 9012, name: 'Jane Doe' } });
    });
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const r = await client.createPerson({ name: 'Jane Doe', email: 'jane@foo.com', phone: '+1 415 555 0101', orgId: 7843 });
    expect(r).toEqual({ id: 9012, name: 'Jane Doe' });
  });

  it('createOrganization POSTs name', async () => {
    const fetchImpl = fakeFetch(async (url, init) => {
      expect(url).toMatch(/\/v1\/organizations$/);
      const body = JSON.parse(init?.body as string);
      expect(body.name).toBe('Foo Studio');
      return jsonRes({ success: true, data: { id: 7843, name: 'Foo Studio' } });
    });
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const r = await client.createOrganization({ name: 'Foo Studio' });
    expect(r).toEqual({ id: 7843, name: 'Foo Studio' });
  });

  it('createLead POSTs title + person_id + org_id + value', async () => {
    const fetchImpl = fakeFetch(async (url, init) => {
      expect(url).toMatch(/\/v1\/leads$/);
      const body = JSON.parse(init?.body as string);
      expect(body.title).toBe('Foo Studio');
      expect(body.person_id).toBe(9012);
      expect(body.organization_id).toBe(7843);
      expect(body.value).toEqual({ amount: 5000, currency: 'USD' });
      expect(body.label_ids).toEqual(['lbl-1']);
      expect(body.expected_close_date).toBe('2026-06-30');
      return jsonRes({ success: true, data: { id: 'lead-uuid', title: 'Foo Studio', person_id: 9012, organization_id: 7843 } });
    });
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const r = await client.createLead({
      title: 'Foo Studio',
      personId: 9012,
      orgId: 7843,
      value: { amount: 5000, currency: 'USD' },
      labelIds: ['lbl-1'],
      expectedCloseDate: '2026-06-30',
    });
    expect(r.id).toBe('lead-uuid');
  });

  it('createNote with lead_id (UUID) — sets lead_id field', async () => {
    const fetchImpl = fakeFetch(async (url, init) => {
      expect(url).toMatch(/\/v1\/notes$/);
      const body = JSON.parse(init?.body as string);
      expect(body.content).toBe('hello');
      expect(body.lead_id).toBe('lead-uuid');
      expect(body.deal_id).toBeUndefined();
      return jsonRes({ success: true, data: { id: 5511, content: 'hello' } });
    });
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const r = await client.createNote({ content: 'hello', leadId: 'lead-uuid' });
    expect(r.id).toBe(5511);
  });

  it('createNote with deal_id (integer)', async () => {
    const fetchImpl = fakeFetch(async (url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.deal_id).toBe(123);
      expect(body.lead_id).toBeUndefined();
      return jsonRes({ success: true, data: { id: 5512, content: 'h' } });
    });
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    await client.createNote({ content: 'h', dealId: 123 });
  });

  it('createActivity POSTs subject + type + due_* + lead_id', async () => {
    const fetchImpl = fakeFetch(async (url, init) => {
      expect(url).toMatch(/\/v1\/activities$/);
      const body = JSON.parse(init?.body as string);
      expect(body.subject).toBe('Follow up');
      expect(body.type).toBe('call');
      expect(body.due_date).toBe('2026-05-12');
      expect(body.due_time).toBe('15:00');
      expect(body.duration).toBe('00:30');
      expect(body.note).toBe('Talk pricing');
      expect(body.lead_id).toBe('lead-uuid');
      expect(body.user_id).toBe(42);
      return jsonRes({ success: true, data: { id: 8801, subject: 'Follow up' } });
    });
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const r = await client.createActivity({
      subject: 'Follow up',
      type: 'call',
      dueDate: '2026-05-12',
      dueTime: '15:00',
      durationMinutes: 30,
      note: 'Talk pricing',
      leadId: 'lead-uuid',
      userId: 42,
    });
    expect(r.id).toBe(8801);
  });

  it('write surface retries once on 429 then succeeds', async () => {
    let calls = 0;
    const fetchImpl = fakeFetch(async () => {
      calls += 1;
      if (calls === 1) return new Response('rate limited', { status: 429 });
      return jsonRes({ success: true, data: { id: 9999, name: 'Foo' } });
    });
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl, retryDelayMs: 1 });
    const r = await client.createOrganization({ name: 'Foo' });
    expect(r.id).toBe(9999);
    expect(calls).toBe(2);
  });
});
