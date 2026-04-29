import { describe, it, expect, vi } from 'vitest';
import { PipedriveConnector } from '../../../../src/connectors/pipedrive/connector.js';
import type { PipedriveApiClient, DealField } from '../../../../src/connectors/pipedrive/client.js';

function makeStub(over: Partial<Record<keyof PipedriveApiClient, unknown>> = {}): PipedriveApiClient {
  return {
    listPipelines: vi.fn().mockResolvedValue([]),
    listStages: vi.fn().mockResolvedValue([]),
    listUsers: vi.fn().mockResolvedValue([]),
    listDealFields: vi.fn().mockResolvedValue([]),
    dealsTimeline: vi.fn().mockResolvedValue([]),
    dealsSummary: vi.fn().mockResolvedValue({ count: 0, total_value_usd: 0, weighted_value_usd: 0 }),
    listDeals: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    listOrganizations: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    listPersons: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    listActivities: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    getDeal: vi.fn(),
    getOrganization: vi.fn(),
    itemSearch: vi.fn().mockResolvedValue([]),
    ...over,
  } as unknown as PipedriveApiClient;
}

describe('PipedriveConnector — skeleton', () => {
  it('exposes name "pipedrive" and tools array', () => {
    const conn = new PipedriveConnector({ client: makeStub() });
    expect(conn.name).toBe('pipedrive');
    expect(Array.isArray(conn.tools)).toBe(true);
  });

  it('resolveCustomFieldName maps a hash to the human name from listDealFields', async () => {
    const fields: DealField[] = [
      { key: '9539ba1ce1e5a79d39a30359e5c3e5b7a95ac082', name: 'Specifier', field_type: 'enum', options: [] },
      { key: '1f25ac373967eb662bc1128e1312a6cde5543fe2', name: 'Purchaser', field_type: 'enum', options: [] },
      { key: 'f21bb44b8b693a780b3e881a258257db8897b6d0', name: 'Source', field_type: 'enum', options: [{ id: 161, label: 'ICFF' }, { id: 162, label: 'Design Miami' }] },
    ];
    const stub = makeStub({ listDealFields: vi.fn().mockResolvedValue(fields) });
    const conn = new PipedriveConnector({ client: stub });
    const map = await conn.resolveCustomFieldNames();
    expect(map.get('9539ba1ce1e5a79d39a30359e5c3e5b7a95ac082')).toBe('Specifier');
    expect(map.get('f21bb44b8b693a780b3e881a258257db8897b6d0')).toBe('Source');
  });

  it('healthCheck pings listPipelines and reports ok with count', async () => {
    const stub = makeStub({ listPipelines: vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]) });
    const conn = new PipedriveConnector({ client: stub });
    const h = await conn.healthCheck();
    expect(h.ok).toBe(true);
    expect(h.detail).toMatch(/2 pipelines/);
  });
});
