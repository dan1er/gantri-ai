import { describe, it, expect, vi } from 'vitest';
import { SendgridApiClient, SendgridApiError } from '../../../../src/connectors/sendgrid/client.js';

describe('SendgridApiClient.listMessages', () => {
  it('attaches Authorization: Bearer header and unwraps { messages }', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [
        { msg_id: 'm1', from_email: 'noreply@gantri.com', to_email: 'a@b.com', subject: 'Order confirmed', status: 'delivered', opens_count: 2, clicks_count: 1, last_event_time: '2026-06-01T10:00:00Z' },
      ] }), { status: 200 }),
    );
    const client = new SendgridApiClient({ apiKey: 'SG.abc', fetchImpl });
    const out = await client.listMessages({ query: 'to_email="a@b.com"', limit: 50 });
    expect(out).toHaveLength(1);
    expect(out[0].msg_id).toBe('m1');
    const [, opts] = fetchImpl.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer SG.abc');
    expect(opts.method).toBe('GET');
  });

  it('URL-encodes the query and passes the limit', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [] }), { status: 200 }));
    const client = new SendgridApiClient({ apiKey: 'k', fetchImpl });
    await client.listMessages({ query: 'to_email="a@b.com"', limit: 25 });
    const [url] = fetchImpl.mock.calls[0];
    const s = String(url);
    expect(s).toContain('/v3/messages?');
    // `query` is URL-encoded — the quotes and = sign must be escaped.
    expect(s).toContain('query=to_email%3D%22a%40b.com%22');
    expect(s).toContain('limit=25');
  });

  it('defaults limit to 100 and caps it at the API max of 1000', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ messages: [] }), { status: 200 }));
    const client = new SendgridApiClient({ apiKey: 'k', fetchImpl });
    await client.listMessages({ query: '' });
    expect(String(fetchImpl.mock.calls[0][0])).toContain('limit=100');
    await client.listMessages({ query: '', limit: 99999 });
    expect(String(fetchImpl.mock.calls[1][0])).toContain('limit=1000');
  });

  it('returns [] when the response has no messages array', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const client = new SendgridApiClient({ apiKey: 'k', fetchImpl });
    expect(await client.listMessages({ query: '' })).toEqual([]);
  });

  it('throws SendgridApiError with status + body on 403 (add-on missing)', async () => {
    const body = { errors: [{ message: 'You do not have access to Email Activity.' }] };
    // Fresh Response per call — a Response body can only be consumed once.
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status: 403 }));
    const client = new SendgridApiClient({ apiKey: 'k', fetchImpl });
    await expect(client.listMessages({ query: '' })).rejects.toBeInstanceOf(SendgridApiError);
    try { await client.listMessages({ query: '' }); } catch (e) {
      expect((e as SendgridApiError).status).toBe(403);
      expect((e as SendgridApiError).body).toEqual(body);
    }
  });

  it('throws SendgridApiError on 401 (bad key)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: [{ message: 'authorization required' }] }), { status: 401 }));
    const client = new SendgridApiClient({ apiKey: 'bad', fetchImpl });
    await expect(client.listMessages({ query: '' })).rejects.toMatchObject({ status: 401 });
  });
});

describe('SendgridApiClient.getMessage', () => {
  it('hits /v3/messages/{id} and returns the detail shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      msg_id: 'm1', from_email: 'noreply@gantri.com', to_email: 'a@b.com', subject: 'Shipped',
      status: 'delivered', opens_count: 1, clicks_count: 0, last_event_time: '2026-06-02T08:00:00Z',
      events: [
        { event_name: 'processed', processed: '2026-06-02T07:59:00Z' },
        { event_name: 'delivered', processed: '2026-06-02T08:00:00Z' },
      ],
      template_id: 'd-123', categories: ['shipping'],
    }), { status: 200 }));
    const client = new SendgridApiClient({ apiKey: 'k', fetchImpl });
    const out = await client.getMessage('m1');
    expect(out.msg_id).toBe('m1');
    expect(out.events).toHaveLength(2);
    expect(out.template_id).toBe('d-123');
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/v3/messages/m1');
    const [, opts] = fetchImpl.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer k');
  });

  it('URL-encodes the msgId path segment', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ msg_id: 'a/b', events: [] }), { status: 200 }));
    const client = new SendgridApiClient({ apiKey: 'k', fetchImpl });
    await client.getMessage('a/b');
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/v3/messages/a%2Fb');
  });
});
