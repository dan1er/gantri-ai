import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import { DateRangeArg, normalizeDateRange } from '../base/date-range.js';
import { logger } from '../../logger.js';
import { ImpactApiClient, ImpactApiError, type ImpactAction, type ImpactApiConfig } from './client.js';

/**
 * Impact.com partnership-platform connector. Surface kept narrow on
 * purpose — three tools cover every partner-level question we anticipated
 * in the FLC, all built off the `/Actions` and `/MediaPartners` raw
 * endpoints (Reports endpoints empirically returned empty for Gantri's
 * account; aggregation happens server-side here instead).
 *
 *   - impact.list_partners         — partner discovery / id lookup
 *   - impact.list_actions          — per-conversion drill-down
 *   - impact.partner_performance   — aggregates over a date range
 *
 * Every numeric field that NB also reports (revenue, transactions) uses
 * the SAME naming convention so the LLM can write cross-source recon
 * queries without translating between vocabularies.
 *
 * Date ranges use the shared `DateRangeArg` schema (preset string |
 * { start, end } | { startDate, endDate }), normalized via
 * `normalizeDateRange` before any logic runs. The registry's
 * `unstringifyJsonObjects` preprocess handles the LLM-stringified-object
 * edge case before our schema even sees the args.
 */

const ListPartnersArgs = z.object({
  search: z.string().optional().describe('Optional case-insensitive substring filter on Name or Description (e.g. "Wirecutter", "Skimlinks").'),
});
type ListPartnersArgs = z.infer<typeof ListPartnersArgs>;

const ListActionsArgs = z.object({
  dateRange: DateRangeArg,
  partnerId: z.string().optional().describe('Optional MediaPartnerId to restrict to one partner. Use `impact.list_partners` first to find IDs.'),
  state: z.enum(['ALL', 'PENDING', 'APPROVED', 'LOCKED', 'CLEARED', 'REVERSED']).default('ALL').describe('Action lifecycle state filter. Defaults to ALL — most callers want all states. PENDING + APPROVED = "still attributable"; REVERSED = bad.'),
  limit: z.number().int().min(1).max(2000).default(200).describe('Max actions to return after filtering. Default 200; raise for full exports.'),
});
type ListActionsArgs = z.infer<typeof ListActionsArgs>;

const PartnerPerformanceArgs = z.object({
  dateRange: DateRangeArg,
  partnerId: z.string().optional().describe('Optional — restrict the aggregation to one partner. Most callers omit and rank all partners.'),
  state: z.enum(['ALL', 'PENDING', 'APPROVED', 'LOCKED', 'CLEARED', 'REVERSED']).default('ALL'),
  sortBy: z.enum(['revenue', 'payout', 'actions', 'roas']).default('revenue').describe('Field to sort partners by, descending.'),
  limit: z.number().int().min(1).max(200).default(50).describe('Top-N partners to return. Default 50.'),
});
type PartnerPerformanceArgs = z.infer<typeof PartnerPerformanceArgs>;

export class ImpactConnector implements Connector {
  readonly name = 'impact';
  readonly tools: readonly ToolDef[];
  private campaignId: string | null = null;
  private campaignDiscoveryAttempted = false;

  constructor(private readonly client: ImpactApiClient) {
    this.tools = this.buildTools();
  }

  async healthCheck() {
    try {
      const partners = await this.client.listPartners();
      return { ok: true, detail: `${partners.length} media partners` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Resolve & cache the brand's CampaignId. Gantri has exactly one
   *  ("Gantri", #19816); we discover it lazily so the connector boots
   *  even when the API is briefly unavailable. */
  private async getCampaignId(): Promise<string> {
    if (this.campaignId) return this.campaignId;
    if (this.campaignDiscoveryAttempted) throw new Error('Impact CampaignId previously failed to resolve');
    this.campaignDiscoveryAttempted = true;
    const campaigns = await this.client.listCampaigns();
    if (campaigns.length === 0) throw new Error('No campaigns under this Impact account');
    this.campaignId = campaigns[0].Id;
    if (campaigns.length > 1) {
      logger.warn({ count: campaigns.length, picked: this.campaignId }, 'multiple Impact campaigns — defaulting to first');
    }
    return this.campaignId;
  }

  private buildTools(): ToolDef[] {
    return [
      {
        name: 'impact.list_partners',
        description: [
          'List media partners (affiliates / publishers / influencers / cashback sites) attached to the Gantri Impact.com account.',
          'Returns Id, Name, Description, Mediatype, Country, Status for each. Use this for "which partners do we have?", "find me Skimlinks\' Id", or as a discovery step before `impact.partner_performance` / `impact.list_actions` when the user names a partner instead of an ID.',
          'Optional `search` filter is a case-insensitive substring match on Name + Description.',
        ].join(' '),
        schema: ListPartnersArgs as z.ZodType<z.infer<typeof ListPartnersArgs>>,
        jsonSchema: zodToJsonSchema(ListPartnersArgs),
        execute: async (rawArgs) => { const args = rawArgs as ListPartnersArgs;
          try {
            const partners = await this.client.listPartners();
            const filtered = args.search
              ? partners.filter((p) => {
                  const q = args.search!.toLowerCase();
                  return (p.Name || '').toLowerCase().includes(q) || (p.Description || '').toLowerCase().includes(q);
                })
              : partners;
            return {
              count: filtered.length,
              totalAcrossAccount: partners.length,
              partners: filtered.map((p) => ({
                id: p.Id,
                name: p.Name,
                description: typeof p.Description === 'string' ? p.Description.slice(0, 200) : '',
                mediatype: p.Mediatype ?? null,
                country: p.Country ?? null,
                status: p.Status ?? null,
              })),
            };
          } catch (err) { return errorResult(err); }
        },
      },
      {
        name: 'impact.list_actions',
        description: [
          'List individual conversions (a.k.a. "actions" in Impact: a click that turned into a sale or signup) for a date range.',
          'Each action carries: id, partner id+name, state (PENDING/APPROVED/LOCKED/CLEARED/REVERSED), amount (sale value), payout (commission paid to partner), currency, dates (event/locking/cleared), promo code, and Oid — the **merchant order id, which equals Gantri Porter Transactions.id**, enabling direct cross-source joins with Porter without name-matching.',
          'Use for "show me individual conversions from Skimlinks last week", "which orders did partner X drive?", or "list reversals in October". For aggregates, prefer `impact.partner_performance`.',
        ].join(' '),
        schema: ListActionsArgs as z.ZodType<z.infer<typeof ListActionsArgs>>,
        jsonSchema: zodToJsonSchema(ListActionsArgs),
        execute: async (rawArgs) => { const args = rawArgs as ListActionsArgs;
          try {
            const { startDate, endDate } = normalizeDateRange(args.dateRange);
            const campaignId = await this.getCampaignId();
            const all = await this.client.listActions({
              campaignId,
              startDate,
              endDate,
            });
            let filtered = args.partnerId ? all.filter((a) => a.MediaPartnerId === args.partnerId) : all;
            if (args.state !== 'ALL') filtered = filtered.filter((a) => a.State === args.state);
            const trimmed = filtered.slice(0, args.limit);
            return {
              dateRange: { startDate, endDate },
              totalMatching: filtered.length,
              returnedCount: trimmed.length,
              actions: trimmed.map(projectAction),
            };
          } catch (err) { return errorResult(err); }
        },
      },
      {
        name: 'impact.partner_performance',
        description: [
          'Aggregate conversion metrics by partner over a date range. Returns one row per partner with: id, name, actions (count), revenue (sum of Amount), payout (sum of commissions), roas (revenue/payout), avg_order_value, and a state breakdown { PENDING, APPROVED, LOCKED, CLEARED, REVERSED } so you can spot pending-heavy or reversal-heavy partners.',
          'Use for "top 10 Impact partners by revenue this quarter", "which partners have the highest ROAS / lowest CAC?", "rank partners by payout last month". For raw per-conversion data, use `impact.list_actions`.',
          'IMPORTANT: revenue here is Impact-attributed gross sale amount. To compare with NB or Porter, use the same date range and remember Impact only sees orders that came through a tracked partner link.',
          'When filtering by state=REVERSED (or any state representing canceled / non-revenue actions), expect revenue=0 and payout=0 in the response — the count of reversed actions lives in `totals.actions` and per-partner `actions` / `state_breakdown.REVERSED`. A response with `partnerCount > 0` and `totals.actions > 0` means there ARE matching actions, even when revenue is 0. For "which partners have the most reversed actions", call with state=REVERSED, sortBy=actions.',
        ].join(' '),
        schema: PartnerPerformanceArgs as z.ZodType<z.infer<typeof PartnerPerformanceArgs>>,
        jsonSchema: zodToJsonSchema(PartnerPerformanceArgs),
        execute: async (rawArgs) => { const args = rawArgs as PartnerPerformanceArgs;
          try {
            const { startDate, endDate } = normalizeDateRange(args.dateRange);
            const campaignId = await this.getCampaignId();
            const all = await this.client.listActions({
              campaignId,
              startDate,
              endDate,
            });
            let scoped = args.partnerId ? all.filter((a) => a.MediaPartnerId === args.partnerId) : all;
            if (args.state !== 'ALL') scoped = scoped.filter((a) => a.State === args.state);

            const byPartner = new Map<string, {
              id: string; name: string;
              actions: number;
              revenue: number; payout: number;
              states: Record<string, number>;
            }>();
            for (const a of scoped) {
              const e = byPartner.get(a.MediaPartnerId) ?? {
                id: a.MediaPartnerId, name: a.MediaPartnerName,
                actions: 0, revenue: 0, payout: 0, states: {},
              };
              e.actions += 1;
              e.revenue += Number(a.Amount) || 0;
              e.payout += Number(a.Payout) || 0;
              e.states[a.State] = (e.states[a.State] ?? 0) + 1;
              byPartner.set(a.MediaPartnerId, e);
            }
            const rows = [...byPartner.values()].map((p) => {
              const revenue = round2(p.revenue);
              const payout = round2(p.payout);
              return {
                partner_id: p.id,
                partner_name: p.name,
                actions: p.actions,
                revenue,
                payout,
                roas: payout > 0 ? round2(revenue / payout) : null,
                avg_order_value: p.actions > 0 ? round2(revenue / p.actions) : 0,
                state_breakdown: p.states,
              };
            });
            const sortKey = args.sortBy;
            rows.sort((a, b) => {
              const av = (a as Record<string, unknown>)[sortKey] ?? 0;
              const bv = (b as Record<string, unknown>)[sortKey] ?? 0;
              return (Number(bv) || 0) - (Number(av) || 0);
            });
            const trimmed = rows.slice(0, args.limit);
            // Top-line totals are useful when the LLM wants a single KPI.
            const totals = rows.reduce(
              (acc, r) => ({
                actions: acc.actions + r.actions,
                revenue: round2(acc.revenue + r.revenue),
                payout: round2(acc.payout + r.payout),
              }),
              { actions: 0, revenue: 0, payout: 0 },
            );
            return {
              dateRange: { startDate, endDate },
              partnerCount: rows.length,
              totals: {
                actions: totals.actions,
                revenue: totals.revenue,
                payout: totals.payout,
                roas: totals.payout > 0 ? round2(totals.revenue / totals.payout) : null,
              },
              partners: trimmed,
            };
          } catch (err) { return errorResult(err); }
        },
      },
    ];
  }
}

/** Trim the action object to the fields the bot actually surfaces — drops
 *  the noise (CallerId, AdId, SharedId, etc.). PII fields that ARE included
 *  are coarse only (city, region, country, hashed IP, post-code area). */
function projectAction(a: ImpactAction) {
  return {
    id: a.Id,
    partner_id: a.MediaPartnerId,
    partner_name: a.MediaPartnerName,
    state: a.State,
    amount: Number(a.Amount) || 0,
    payout: Number(a.Payout) || 0,
    currency: a.Currency,
    event_date: a.EventDate,
    locking_date: a.LockingDate,
    cleared_date: a.ClearedDate,
    referring_type: a.ReferringType,
    referring_domain: typeof a.ReferringDomain === 'string' ? a.ReferringDomain : null,
    promo_code: a.PromoCode || null,
    /** Porter Transactions.id — direct join key. */
    porter_order_id: a.Oid,
    customer_status: a.CustomerStatus,
    customer_country: a.CustomerCountry,
    customer_region: a.CustomerRegion,
    customer_city: a.CustomerCity,
  };
}

function errorResult(err: unknown) {
  if (err instanceof ImpactApiError) {
    return { ok: false, error: { code: 'IMPACT_API_ERROR', status: err.status, message: err.message, body: err.body } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'IMPACT_INTERNAL_ERROR', message } };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

/** Factory used by index.ts so the wiring stays consistent with other connectors. */
export function buildImpactConnector(cfg: ImpactApiConfig): ImpactConnector {
  return new ImpactConnector(new ImpactApiClient(cfg));
}
