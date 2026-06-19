import { describe, it, expect, vi } from 'vitest';
import { SendgridConnector } from '../../../../src/connectors/sendgrid/connector.js';
import type { SendgridApiClient } from '../../../../src/connectors/sendgrid/client.js';
import { SendgridApiError } from '../../../../src/connectors/sendgrid/client.js';

function makeStub(over: Partial<Record<keyof SendgridApiClient, unknown>> = {}): SendgridApiClient {
  return {
    listMessages: vi.fn().mockResolvedValue([]),
    getMessage: vi.fn(),
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
    const conn = new SendgridConnector({ client: makeStub({ listMessages }) });
    const tool = conn.tools.find((t) => t.name === 'sendgrid.email_activity')!;
    const r = await tool.execute({ toEmail: 'a@b.com', limit: 100 }) as any;

    expect(listMessages).toHaveBeenCalledWith({ query: 'to_email="a@b.com"', limit: 100 });
    expect(r).toMatchObject({ toEmail: 'a@b.com', count: 1 });
    expect(r.rows[0]).toEqual({
      msgId: 'm1', subject: 'Your order shipped', status: 'delivered',
      fromEmail: 'noreply@gantri.com', lastEventTime: '2026-06-10T12:00:00Z',
      opensCount: 3, clicksCount: 1,
    });
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
  it('maps the detail response (events → {name, at}, template, categories)', async () => {
    const getMessage = vi.fn().mockResolvedValue({
      ...sampleRow,
      events: [
        { event_name: 'processed', processed: '2026-06-10T11:59:00Z' },
        { event_name: 'open', processed: '2026-06-10T13:00:00Z' },
      ],
      template_id: 'd-xyz', categories: ['shipping', 'order'],
    });
    const conn = new SendgridConnector({ client: makeStub({ getMessage }) });
    const tool = conn.tools.find((t) => t.name === 'sendgrid.message_detail')!;
    const r = await tool.execute({ msgId: 'm1' }) as any;

    expect(getMessage).toHaveBeenCalledWith('m1');
    expect(r).toMatchObject({
      msgId: 'm1', subject: 'Your order shipped', toEmail: 'a@b.com',
      fromEmail: 'noreply@gantri.com', status: 'delivered', template: 'd-xyz',
      categories: ['shipping', 'order'],
    });
    expect(r.events).toEqual([
      { name: 'processed', at: '2026-06-10T11:59:00Z' },
      { name: 'open', at: '2026-06-10T13:00:00Z' },
    ]);
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
