import { describe, it, expect, vi } from 'vitest';
import { ImpactConnector } from '../../../../src/connectors/impact/connector.js';
import type { ImpactApiClient, ImpactAction, ImpactPartner } from '../../../../src/connectors/impact/client.js';

/**
 * Connector tests use a hand-stubbed ImpactApiClient instead of mocking
 * fetch — keeps the unit isolated from HTTP and lets us assert the
 * server-side aggregation logic precisely.
 */

const partner = (id: string, name: string, extra: Partial<ImpactPartner> = {}): ImpactPartner => ({
  Id: id, Name: name, Description: extra.Description ?? '',
  Mediatype: extra.Mediatype ?? 'Content', Country: extra.Country ?? 'US', Status: extra.Status ?? 'Active',
});
const action = (overrides: Partial<ImpactAction> = {}): ImpactAction => ({
  Id: '19816.1', CampaignId: '19816', CampaignName: 'Gantri',
  ActionTrackerName: 'Online Sale', ActionTrackerId: '37766', EventCode: '',
  MediaPartnerId: 'P1', MediaPartnerName: 'Skimlinks', State: 'PENDING',
  AdId: '1', ClientCost: '5', Payout: '5', DeltaPayout: '5', IntendedPayout: '5',
  Amount: '100', DeltaAmount: '100', IntendedAmount: '100', Currency: 'USD',
  ReferringDate: '', EventDate: '2026-04-22T10:00:00-07:00', CreationDate: '',
  LockingDate: '', ClearedDate: '', ReferringType: 'CLICK_COOKIE', ReferringDomain: '',
  IpAddress: '', PromoCode: '', Oid: '53904', CustomerId: '65507',
  CustomerPostCode: '', CustomerStatus: 'New', Note: '', CallerId: '',
  CustomerArea: '', CustomerCity: 'Washington', CustomerRegion: 'DC',
  CustomerCountry: 'US', SharedId: '', Uri: '',
  ...overrides,
});

function makeStub(opts: { partners?: ImpactPartner[]; actions?: ImpactAction[] } = {}) {
  return {
    listPartners: vi.fn(async () => opts.partners ?? []),
    listActions: vi.fn(async () => opts.actions ?? []),
    listCampaigns: vi.fn(async () => [{ Id: '19816', Name: 'Gantri' }]),
  } as unknown as ImpactApiClient;
}

describe('impact.list_partners', () => {
  it('returns all partners and totalAcrossAccount when no search filter', async () => {
    const c = new ImpactConnector(makeStub({ partners: [partner('1', 'Skimlinks'), partner('2', 'Wirecutter')] }));
    const tool = c.tools.find((t) => t.name === 'impact.list_partners')!;
    const r = await tool.execute({}) as any;
    expect(r.totalAcrossAccount).toBe(2);
    expect(r.count).toBe(2);
    expect(r.partners.map((p: any) => p.name)).toEqual(['Skimlinks', 'Wirecutter']);
  });

  it('filters by case-insensitive substring on name', async () => {
    const c = new ImpactConnector(makeStub({
      partners: [partner('1', 'Skimlinks'), partner('2', 'Wirecutter'), partner('3', 'Honey')],
    }));
    const tool = c.tools.find((t) => t.name === 'impact.list_partners')!;
    const r = await tool.execute({ search: 'wire' }) as any;
    expect(r.count).toBe(1);
    expect(r.totalAcrossAccount).toBe(3);
    expect(r.partners[0].name).toBe('Wirecutter');
  });
});

describe('impact.list_actions', () => {
  it('returns actions filtered by partnerId + state, capped by limit', async () => {
    const c = new ImpactConnector(makeStub({
      actions: [
        action({ Id: '1', MediaPartnerId: 'P1', State: 'PENDING' }),
        action({ Id: '2', MediaPartnerId: 'P1', State: 'APPROVED' }),
        action({ Id: '3', MediaPartnerId: 'P2', State: 'PENDING' }),
      ],
    }));
    const tool = c.tools.find((t) => t.name === 'impact.list_actions')!;
    const r = await tool.execute({
      dateRange: { startDate: '2026-04-01', endDate: '2026-04-30' },
      partnerId: 'P1',
      state: 'APPROVED',
      limit: 10,
    }) as any;
    expect(r.totalMatching).toBe(1);
    expect(r.actions[0].id).toBe('2');
  });

  it('exposes porter_order_id (joins to Porter Transactions.id)', async () => {
    const c = new ImpactConnector(makeStub({ actions: [action({ Oid: '53904' })] }));
    const tool = c.tools.find((t) => t.name === 'impact.list_actions')!;
    const r = await tool.execute({
      dateRange: { startDate: '2026-04-01', endDate: '2026-04-30' },
      state: 'ALL', limit: 10,
    }) as any;
    expect(r.actions[0].porter_order_id).toBe('53904');
  });

  it('accepts preset-string dateRange (live-reports $REPORT_RANGE path)', async () => {
    // Regression: live-reports runner resolves $REPORT_RANGE to a preset string
    // (e.g. "last_30_days"); the tool must accept that shape, not only {startDate,endDate}.
    const c = new ImpactConnector(makeStub({ actions: [action({ Id: '99' })] }));
    const tool = c.tools.find((t) => t.name === 'impact.list_actions')!;
    const r = await tool.execute({
      dateRange: 'last_30_days',
      state: 'ALL', limit: 10,
    }) as any;
    expect(r.totalMatching).toBe(1);
    expect(r.actions[0].id).toBe('99');
    // dateRange in the response is normalized to {startDate,endDate}
    expect(r.dateRange.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.dateRange.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('accepts {start,end} dateRange (alternate live-reports shape)', async () => {
    const c = new ImpactConnector(makeStub({ actions: [action({ Id: '7' })] }));
    const tool = c.tools.find((t) => t.name === 'impact.list_actions')!;
    const r = await tool.execute({
      dateRange: { start: '2026-04-01', end: '2026-04-30' },
      state: 'ALL', limit: 10,
    }) as any;
    expect(r.totalMatching).toBe(1);
    expect(r.dateRange).toEqual({ startDate: '2026-04-01', endDate: '2026-04-30' });
  });
});

describe('impact.partner_performance', () => {
  it('accepts preset-string dateRange (live-reports $REPORT_RANGE path)', async () => {
    const c = new ImpactConnector(makeStub({
      actions: [action({ MediaPartnerId: 'P1', MediaPartnerName: 'A', Amount: '100', Payout: '5' })],
    }));
    const tool = c.tools.find((t) => t.name === 'impact.partner_performance')!;
    const r = await tool.execute({
      dateRange: 'this_month',
      sortBy: 'revenue', state: 'ALL', limit: 50,
    }) as any;
    expect(r.partnerCount).toBe(1);
    expect(r.dateRange.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('aggregates revenue+payout per partner with state breakdown', async () => {
    const c = new ImpactConnector(makeStub({
      actions: [
        action({ MediaPartnerId: 'P1', MediaPartnerName: 'A', State: 'APPROVED', Amount: '200', Payout: '10' }),
        action({ MediaPartnerId: 'P1', MediaPartnerName: 'A', State: 'PENDING', Amount: '300', Payout: '15' }),
        action({ MediaPartnerId: 'P2', MediaPartnerName: 'B', State: 'APPROVED', Amount: '500', Payout: '50' }),
      ],
    }));
    const tool = c.tools.find((t) => t.name === 'impact.partner_performance')!;
    const r = await tool.execute({
      dateRange: { startDate: '2026-04-01', endDate: '2026-04-30' },
      sortBy: 'revenue', state: 'ALL', limit: 50,
    }) as any;
    expect(r.partnerCount).toBe(2);
    expect(r.totals).toEqual({ actions: 3, revenue: 1000, payout: 75, roas: 13.33 });
    // Sorted by revenue desc → B first ($500) then A ($500 too — tie, but A has 2 actions)
    expect(r.partners.map((p: any) => p.partner_name)).toEqual(['A', 'B']);
    expect(r.partners[0].revenue).toBe(500);
    expect(r.partners[0].state_breakdown).toEqual({ APPROVED: 1, PENDING: 1 });
    expect(r.partners[0].roas).toBe(20); // 500 / 25
  });

  it('roas null when payout is zero (avoids division by zero)', async () => {
    const c = new ImpactConnector(makeStub({
      actions: [action({ MediaPartnerId: 'P1', MediaPartnerName: 'Free', Amount: '100', Payout: '0' })],
    }));
    const tool = c.tools.find((t) => t.name === 'impact.partner_performance')!;
    const r = await tool.execute({
      dateRange: { startDate: '2026-04-01', endDate: '2026-04-30' },
      sortBy: 'revenue', state: 'ALL', limit: 50,
    }) as any;
    expect(r.partners[0].roas).toBeNull();
    expect(r.totals.roas).toBeNull();
  });
});
