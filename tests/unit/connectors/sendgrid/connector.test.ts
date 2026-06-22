import { describe, it, expect, vi } from 'vitest';
import { SendgridConnector } from '../../../../src/connectors/sendgrid/connector.js';
import type { SendgridApiClient } from '../../../../src/connectors/sendgrid/client.js';
import { SendgridApiError } from '../../../../src/connectors/sendgrid/client.js';

function makeStub(over: Partial<Record<keyof SendgridApiClient, unknown>> = {}): SendgridApiClient {
  return {
    listMessages: vi.fn().mockResolvedValue([]),
    getMessage: vi.fn().mockResolvedValue({ events: [] }),
    getTemplate: vi.fn().mockResolvedValue({ id: 'd-x', name: 'Some Template', generation: 'dynamic' }),
    ...over,
  } as unknown as SendgridApiClient;
}

const sampleRow = {
  msg_id: 'm1', from_email: 'noreply@gantri.com', to_email: 'a@b.com',
  subject: 'Your order shipped', status: 'delivered',
  opens_count: 3, clicks_count: 1, last_event_time: '2026-06-10T12:00:00Z',
};

describe('SendgridConnector — skeleton', () => {
  it('exposes name "sendgrid" and the two tools', () => {
    const conn = new SendgridConnector({ client: makeStub() });
    expect(conn.name).toBe('sendgrid');
    expect(conn.tools.map((t) => t.name).sort()).toEqual(['sendgrid.email_activity', 'sendgrid.message_detail']);
  });

  it('healthCheck ok when listMessages resolves', async () => {
    const conn = new SendgridConnector({ client: makeStub({ listMessages: vi.fn().mockResolvedValue([sampleRow]) }) });
    const h = await conn.healthCheck();
    expect(h.ok).toBe(true);
  });

  it('healthCheck reports the add-on-missing reason on 403', async () => {
    const conn = new SendgridConnector({ client: makeStub({
      listMessages: vi.fn().mockRejectedValue(new SendgridApiError('GET /v3/messages -> 403', 403, {})),
    }) });
    const h = await conn.healthCheck();
    expect(h.ok).toBe(false);
    expect(h.detail).toMatch(/add-on/i);
  });
});

describe('sendgrid.email_activity', () => {
  it('builds a to_email query, defaults limit to 100, and maps rows to flat shape', async () => {
    const listMessages = vi.fn().mockResolvedValue([sampleRow]);
    // getMessage returns no template_id, so the row's template stays null.
    const getMessage = vi.fn().mockResolvedValue({ ...sampleRow, events: [] });
    const conn = new SendgridConnector({ client: makeStub({ listMessages, getMessage }) });
    const tool = conn.tools.find((t) => t.name === 'sendgrid.email_activity')!;
    const r = await tool.execute({ toEmail: 'a@b.com', limit: 100 }) as any;

    expect(listMessages).toHaveBeenCalledWith({ query: 'to_email="a@b.com"', limit: 100 });
    expect(r).toMatchObject({ toEmail: 'a@b.com', count: 1, templateEnrichmentTruncated: false });
    expect(r.rows[0]).toEqual({
      msgId: 'm1', subject: 'Your order shipped', status: 'delivered',
      fromEmail: 'noreply@gantri.com', lastEventTime: '2026-06-10T12:00:00Z',
      opensCount: 3, clicksCount: 1, template: null,
    });
  });

  it('enriches each row with template { id, name, url } via getMessage + getTemplate', async () => {
    const listMessages = vi.fn().mockResolvedValue([sampleRow]);
    const getMessage = vi.fn().mockResolvedValue({ ...sampleRow, events: [], template_id: 'd-abc' });
    const getTemplate = vi.fn().mockResolvedValue({ id: 'd-abc', name: 'Made Hub Invite', generation: 'dynamic' });
    const conn = new SendgridConnector({ client: makeStub({ listMessages, getMessage, getTemplate }) });
    const tool = conn.tools.find((t) => t.name === 'sendgrid.email_activity')!;
    const r = await tool.execute({ toEmail: 'a@b.com', limit: 100 }) as any;

    expect(getMessage).toHaveBeenCalledWith('m1');
    expect(r.rows[0].template).toEqual({ id: 'd-abc', name: 'Made Hub Invite' });
  });

  it('resolves a repeated template id only once (per-call name cache)', async () => {
    const rows = [
      { ...sampleRow, msg_id: 'm1' },
      { ...sampleRow, msg_id: 'm2' },
    ];
    const listMessages = vi.fn().mockResolvedValue(rows);
    const getMessage = vi.fn().mockImplementation(async (id: string) => ({ ...sampleRow, msg_id: id, events: [], template_id: 'd-same' }));
    const getTemplate = vi.fn().mockResolvedValue({ id: 'd-same', name: 'Shared', generation: 'dynamic' });
    const conn = new SendgridConnector({ client: makeStub({ listMessages, getMessage, getTemplate }) });
    const tool = conn.tools.find((t) => t.name === 'sendgrid.email_activity')!;
    const r = await tool.execute({ toEmail: 'a@b.com', limit: 100 }) as any;

    expect(getMessage).toHaveBeenCalledTimes(2);
    expect(getTemplate).toHaveBeenCalledTimes(1); // cached on the second row
    expect(r.rows[0].template.name).toBe('Shared');
    expect(r.rows[1].template.name).toBe('Shared');
  });

  it('degrades a row to template null (id+url, name null) when getTemplate fails', async () => {
    const listMessages = vi.fn().mockResolvedValue([sampleRow]);
    const getMessage = vi.fn().mockResolvedValue({ ...sampleRow, events: [], template_id: 'd-x' });
    const getTemplate = vi.fn().mockRejectedValue(new SendgridApiError('GET /v3/templates/d-x -> 403', 403, {}));
    const conn = new SendgridConnector({ client: makeStub({ listMessages, getMessage, getTemplate }) });
    const tool = conn.tools.find((t) => t.name === 'sendgrid.email_activity')!;
    const r = await tool.execute({ toEmail: 'a@b.com', limit: 100 }) as any;

    expect(r.rows[0].template).toEqual({ id: 'd-x', name: null });
  });

  it('does not fail the whole tool when a single getMessage throws', async () => {
    const listMessages = vi.fn().mockResolvedValue([sampleRow]);
    const getMessage = vi.fn().mockRejectedValue(new Error('boom'));
    const conn = new SendgridConnector({ client: makeStub({ listMessages, getMessage }) });
    const tool = conn.tools.find((t) => t.name === 'sendgrid.email_activity')!;
    const r = await tool.execute({ toEmail: 'a@b.com', limit: 100 }) as any;
    expect(r.count).toBe(1);
    expect(r.rows[0].template).toBeNull();
  });

  it('caps enrichment at 50 rows and sets templateEnrichmentTruncated', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ...sampleRow, msg_id: `m${i}` }));
    const listMessages = vi.fn().mockResolvedValue(many);
    const getMessage = vi.fn().mockImplementation(async (id: string) => ({ ...sampleRow, msg_id: id, events: [], template_id: 'd-z' }));
    const getTemplate = vi.fn().mockResolvedValue({ id: 'd-z', name: 'Z', generation: 'dynamic' });
    const conn = new SendgridConnector({ client: makeStub({ listMessages, getMessage, getTemplate }) });
    const tool = conn.tools.find((t) => t.name === 'sendgrid.email_activity')!;
    const r = await tool.execute({ toEmail: 'a@b.com', limit: 1000 }) as any;

    expect(r.count).toBe(60);
    expect(r.templateEnrichmentTruncated).toBe(true);
    expect(getMessage).toHaveBeenCalledTimes(50); // only the first 50 enriched
    expect(r.rows[0].template.name).toBe('Z');
    expect(r.rows[59].template).toBeNull(); // overflow row left null
  });

  it('appends a last_event_time BETWEEN clause when dateRange is given', async () => {
    const listMessages = vi.fn().mockResolvedValue([]);
    const conn = new SendgridConnector({ client: makeStub({ listMessages }) });
    const tool = conn.tools.find((t) => t.name === 'sendgrid.email_activity')!;
    await tool.execute({ toEmail: 'a@b.com', limit: 100, dateRange: { startDate: '2026-06-01', endDate: '2026-06-07' } });

    const { query } = listMessages.mock.calls[0][0];
    expect(query).toContain('to_email="a@b.com"');
    expect(query).toContain('last_event_time BETWEEN TIMESTAMP "2026-06-01T00:00:00Z" AND TIMESTAMP "2026-06-07T23:59:59Z"');
  });

  it('accepts dateRange as a preset string', async () => {
    const listMessages = vi.fn().mockResolvedValue([]);
    const conn = new SendgridConnector({ client: makeStub({ listMessages }) });
    const tool = conn.tools.find((t) => t.name === 'sendgrid.email_activity')!;
    // Validate through the tool's own schema first (the registry path), then execute.
    const args = tool.schema.parse({ toEmail: 'a@b.com', dateRange: 'last_30_days' });
    const r = await tool.execute(args) as any;
    expect(r.toEmail).toBe('a@b.com');
    expect(listMessages.mock.calls[0][0].query).toContain('last_event_time BETWEEN');
  });

  it('surfaces the 403 add-on error as SENDGRID_ADDON_REQUIRED', async () => {
    const conn = new SendgridConnector({ client: makeStub({
      listMessages: vi.fn().mockRejectedValue(new SendgridApiError('GET /v3/messages -> 403', 403, { errors: [] })),
    }) });
    const tool = conn.tools.find((t) => t.name === 'sendgrid.email_activity')!;
    const r = await tool.execute({ toEmail: 'a@b.com', limit: 100 }) as any;
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('SENDGRID_ADDON_REQUIRED');
  });
});

describe('sendgrid.message_detail', () => {
  it('maps the detail response (events → {name, at}, template object, categories)', async () => {
    const getMessage = vi.fn().mockResolvedValue({
      ...sampleRow,
      events: [
        { event_name: 'processed', processed: '2026-06-10T11:59:00Z' },
        { event_name: 'open', processed: '2026-06-10T13:00:00Z' },
      ],
      template_id: 'd-xyz', categories: ['shipping', 'order'],
    });
    const getTemplate = vi.fn().mockResolvedValue({ id: 'd-xyz', name: 'Order Shipped', generation: 'dynamic' });
    const conn = new SendgridConnector({ client: makeStub({ getMessage, getTemplate }) });
    const tool = conn.tools.find((t) => t.name === 'sendgrid.message_detail')!;
    const r = await tool.execute({ msgId: 'm1' }) as any;

    expect(getMessage).toHaveBeenCalledWith('m1');
    expect(r).toMatchObject({
      msgId: 'm1', subject: 'Your order shipped', toEmail: 'a@b.com',
      fromEmail: 'noreply@gantri.com', status: 'delivered',
      categories: ['shipping', 'order'],
    });
    expect(r.template).toEqual({ id: 'd-xyz', name: 'Order Shipped' });
    expect(r.events).toEqual([
      { name: 'processed', at: '2026-06-10T11:59:00Z' },
      { name: 'open', at: '2026-06-10T13:00:00Z' },
    ]);
  });

  it('returns template id with name null when getTemplate fails', async () => {
    const getMessage = vi.fn().mockResolvedValue({ ...sampleRow, events: [], template_id: 'd-xyz' });
    const getTemplate = vi.fn().mockRejectedValue(new SendgridApiError('GET /v3/templates/d-xyz -> 404', 404, {}));
    const conn = new SendgridConnector({ client: makeStub({ getMessage, getTemplate }) });
    const tool = conn.tools.find((t) => t.name === 'sendgrid.message_detail')!;
    const r = await tool.execute({ msgId: 'm1' }) as any;
    expect(r.template).toEqual({ id: 'd-xyz', name: null });
  });

  it('defaults template to null and categories to [] when absent', async () => {
    const getMessage = vi.fn().mockResolvedValue({ ...sampleRow, events: [] });
    const conn = new SendgridConnector({ client: makeStub({ getMessage }) });
    const tool = conn.tools.find((t) => t.name === 'sendgrid.message_detail')!;
    const r = await tool.execute({ msgId: 'm1' }) as any;
    expect(r.template).toBeNull();
    expect(r.categories).toEqual([]);
  });
});
