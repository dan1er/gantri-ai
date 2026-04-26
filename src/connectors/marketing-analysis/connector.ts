import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import type { NorthbeamApiClient, DataExportPayload } from '../northbeam-api/client.js';

/**
 * Higher-level Northbeam analysis tools. Each one wraps a specific multi-call
 * pattern that the LLM has historically gotten wrong when composing it inline:
 * sequential calls across attribution models, LTV-cohort math, new/returning
 * splits, marginal-ROAS deltas. Centralizing them here means the LLM does ONE
 * tool call and the arithmetic is deterministic.
 */
export interface MarketingAnalysisDeps {
  nb: NorthbeamApiClient;
}

const PT_TZ = 'America/Los_Angeles';

const DateRange = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD PT'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD PT'),
});

// ---- M1: attribution_compare_models ----

const AttributionCompareArgs = z.object({
  dateRange: DateRange,
  metrics: z.array(z.string()).min(1).default(['rev', 'spend', 'txns']),
  /** Optional. If set, restricts to a single channel/platform via the Platform breakdown. */
  platformFilter: z.string().optional(),
  /** Subset of attribution models to include. Defaults to all 7. */
  models: z.array(z.string()).optional(),
});
type AttributionCompareArgs = z.infer<typeof AttributionCompareArgs>;

const ALL_MODELS = [
  { id: 'northbeam_custom', name: 'Clicks only' },
  { id: 'northbeam_custom__enh', name: 'Clicks + Deterministic Views' },
  { id: 'northbeam_custom__va', name: 'Clicks + Modeled Views' },
  { id: 'last_touch', name: 'Last touch' },
  { id: 'last_touch_non_direct', name: 'Last non-direct touch' },
  { id: 'first_touch', name: 'First touch' },
  { id: 'linear', name: 'Linear' },
];

// ---- M2: ltv_cac_by_channel ----

const LtvCacArgs = z.object({
  dateRange: DateRange,
  /** Defaults to Platform (Northbeam) — most common breakdown for "by channel" questions. */
  breakdownKey: z.enum(['Platform (Northbeam)', 'Forecast', 'Category (Northbeam)']).default('Platform (Northbeam)'),
});
type LtvCacArgs = z.infer<typeof LtvCacArgs>;

// LTV horizons NB exposes (verified empirically against the metrics catalog).
// `*Ltv` are the LTV-projected variants; `Ft` flag means "first-time customer
// only" — what we want for new-customer LTV / new-customer CAC analysis.
const LTV_METRICS = ['cacFt', 'aovFt', 'aovFtLtv', 'roasFt', 'roasFtLtv', 'rev', 'revFt', 'spend'] as const;

// ---- M3: new_vs_returning_split ----

const NewVsReturningArgs = z.object({
  dateRange: DateRange,
  breakdownKey: z.enum(['Platform (Northbeam)', 'Forecast', 'Category (Northbeam)']).default('Platform (Northbeam)'),
  level: z.enum(['platform', 'campaign']).default('platform'),
});
type NewVsReturningArgs = z.infer<typeof NewVsReturningArgs>;

const NVR_METRICS = ['rev', 'revFt', 'revRtn', 'txns', 'txnsFt', 'txnsRtn', 'spend', 'cac', 'cacFt'];

// ---- M4: budget_optimization_report ----

const BudgetOptimizationArgs = z.object({
  /** Current period — typically last 30/14/7 days. */
  currentPeriod: DateRange,
  /** Prior period — same length as currentPeriod, immediately preceding it. Used to compute marginal ROAS as (Δrev / Δspend). */
  priorPeriod: DateRange,
  /** Drop campaigns with spend below this in the current period. Defaults to $100. */
  minSpendDollars: z.number().default(100),
});
type BudgetOptimizationArgs = z.infer<typeof BudgetOptimizationArgs>;

// ---- connector ----

export class MarketingAnalysisConnector implements Connector {
  readonly name = 'marketing-analysis';
  readonly tools: readonly ToolDef[];

  constructor(private readonly deps: MarketingAnalysisDeps) {
    this.tools = this.buildTools();
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true };
  }

  private buildTools(): ToolDef[] {
    return [
      this.attributionCompareModels(),
      this.ltvCacByChannel(),
      this.newVsReturningSplit(),
      this.budgetOptimizationReport(),
    ];
  }

  private buildExport(opts: {
    dateRange: { startDate: string; endDate: string };
    attributionModel: string;
    metrics: string[];
    breakdown?: { key: string; values?: string[] };
    level?: 'platform' | 'campaign' | 'adset' | 'ad';
    aggregateData?: boolean;
  }): DataExportPayload {
    return {
      level: opts.level ?? 'platform',
      time_granularity: 'DAILY',
      period_type: 'FIXED',
      period_options: {
        period_starting_at: `${opts.dateRange.startDate}T00:00:00.000Z`,
        period_ending_at: `${opts.dateRange.endDate}T23:59:59.999Z`,
      },
      breakdowns: opts.breakdown ? [opts.breakdown] : [],
      options: {
        export_aggregation: 'BREAKDOWN',
        remove_zero_spend: false,
        aggregate_data: opts.aggregateData ?? true,
        include_ids: false,
      },
      attribution_options: {
        attribution_models: [opts.attributionModel],
        accounting_modes: ['cash'],
        attribution_windows: ['1'],
      },
      metrics: opts.metrics.map((id) => ({ id })),
    };
  }

  private attributionCompareModels(): ToolDef<AttributionCompareArgs> {
    return {
      name: 'gantri.attribution_compare_models',
      description: [
        'Run the same metrics against ALL 7 Northbeam attribution models in parallel and return a side-by-side comparison.',
        'Use for ANY question of the form "ROAS / revenue / orders by attribution model", "which channels are over/undervalued by last-click vs NB", or "how stable is the channel ranking across models" (Q1, Q2, Q3 in the marketing question list).',
        'Returns one row per (model × breakdown_value) with the metrics + a derived `roas` column when both rev and spend are requested. Default metrics: rev, spend, txns. Default platform breakdown: none (cross-channel total). Pass `platformFilter` to lock to one channel (e.g. "Google Ads"). Pass `models` to subset.',
        'The 7 models are: northbeam_custom (Clicks only), northbeam_custom__enh (Clicks + Deterministic Views), northbeam_custom__va (Clicks + Modeled Views — DEFAULT), last_touch, last_touch_non_direct, first_touch, linear.',
      ].join(' '),
      schema: AttributionCompareArgs as z.ZodType<AttributionCompareArgs>,
      jsonSchema: zodToJsonSchema(AttributionCompareArgs),
      execute: (args: AttributionCompareArgs) => this.runAttributionCompare(args),
    };
  }

  private async runAttributionCompare(args: AttributionCompareArgs) {
    const models = args.models
      ? ALL_MODELS.filter((m) => args.models!.includes(m.id))
      : ALL_MODELS;
    const breakdown = args.platformFilter
      ? { key: 'Platform (Northbeam)', values: [args.platformFilter] }
      : undefined;
    const results = await Promise.all(
      models.map(async (m) => {
        try {
          const csv = await this.deps.nb.runExport(this.buildExport({
            dateRange: args.dateRange,
            attributionModel: m.id,
            metrics: args.metrics,
            breakdown,
            aggregateData: true,
          }));
          return { model: m, ok: true as const, headers: csv.headers, rows: csv.rows };
        } catch (err) {
          return { model: m, ok: false as const, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    // Aggregate per-model totals across breakdown rows for the comparison view.
    const perModel = results.map((r) => {
      if (!r.ok) return { model_id: r.model.id, model_name: r.model.name, error: r.error };
      const sum = (col: string) => {
        const idx = r.headers.indexOf(col);
        if (idx < 0) return null;
        return r.rows.reduce((acc, row) => acc + (Number(row[idx]) || 0), 0);
      };
      const out: Record<string, unknown> = { model_id: r.model.id, model_name: r.model.name };
      for (const m of args.metrics) out[m] = round2(sum(m) ?? 0);
      const rev = (out.rev as number | undefined) ?? null;
      const spend = (out.spend as number | undefined) ?? null;
      if (rev != null && spend != null && spend > 0) out.roas = round2(rev / spend);
      return out;
    });
    return {
      period: args.dateRange,
      platformFilter: args.platformFilter ?? null,
      metrics: args.metrics,
      models: perModel,
    };
  }

  private ltvCacByChannel(): ToolDef<LtvCacArgs> {
    return {
      name: 'gantri.ltv_cac_by_channel',
      description: [
        'LTV vs CAC analysis per channel. Pulls first-time-customer revenue, AOV, LTV-projected AOV, ROAS, LTV-projected ROAS, and CAC for each channel in the chosen breakdown. Adds a derived `ltv_cac_ratio = aovFtLtv / cacFt` column and ranks channels.',
        'Use for "LTV/CAC ratio per channel", "which channel brings highest-quality customers", "CAC by channel new-customer-only" (Q11, Q12, Q13 in the marketing question list).',
        'Default breakdown: Platform (Northbeam). Returns one row per channel with all metrics + ratio.',
      ].join(' '),
      schema: LtvCacArgs as z.ZodType<LtvCacArgs>,
      jsonSchema: zodToJsonSchema(LtvCacArgs),
      execute: (args: LtvCacArgs) => this.runLtvCac(args),
    };
  }

  private async runLtvCac(args: LtvCacArgs) {
    const breakdownValues = await this.expandBreakdownValues(args.breakdownKey);
    const csv = await this.deps.nb.runExport(this.buildExport({
      dateRange: args.dateRange,
      attributionModel: 'northbeam_custom__va',
      metrics: [...LTV_METRICS],
      breakdown: { key: args.breakdownKey, values: breakdownValues },
      aggregateData: true,
    }));
    const breakdownColumn = breakdownColumnFor(args.breakdownKey);
    const rows = csv.rows.map((r) => {
      const get = (col: string) => {
        const i = csv.headers.indexOf(col);
        if (i < 0) return null;
        const v = r[i];
        return v === '' || v == null ? null : Number(v);
      };
      const channel = (() => {
        const i = csv.headers.indexOf(breakdownColumn);
        return i >= 0 ? String(r[i]) : 'unknown';
      })();
      const aovFtLtv = get('aov_1st_time_ltv');
      const cacFt = get('new_customer_acquisition_cost');
      const aovFt = get('aov_1st_time');
      const rev = get('rev');
      const revFt = get('rev_1st_time');
      const spend = get('spend');
      return {
        channel,
        revenue: round2(rev ?? 0),
        first_time_revenue: round2(revFt ?? 0),
        spend: round2(spend ?? 0),
        cac_first_time: cacFt != null ? round2(cacFt) : null,
        aov_first_time: aovFt != null ? round2(aovFt) : null,
        aov_first_time_ltv: aovFtLtv != null ? round2(aovFtLtv) : null,
        roas_first_time: get('roas_1st_time') ?? null,
        roas_first_time_ltv: get('roas_1st_time_ltv') ?? null,
        ltv_cac_ratio: aovFtLtv != null && cacFt != null && cacFt > 0 ? round2(aovFtLtv / cacFt) : null,
      };
    });
    rows.sort((a, b) => (b.ltv_cac_ratio ?? -Infinity) - (a.ltv_cac_ratio ?? -Infinity));
    return { period: args.dateRange, breakdown: args.breakdownKey, rows, headers: csv.headers };
  }

  private newVsReturningSplit(): ToolDef<NewVsReturningArgs> {
    return {
      name: 'gantri.new_vs_returning_split',
      description: [
        'Per-channel breakdown of new (first-time) vs returning customer revenue, transactions, and CAC.',
        'Use for "what % of revenue per channel is new vs returning", "nCAC by Meta campaign", "am I paying to reacquire customers I already had via email/organic" (Q16, Q17, Q18).',
        'Default breakdown: Platform (Northbeam). Set level=campaign to drill into individual campaigns (typical for nCAC by Meta campaign question). Returns rev/txns/cac split into Ft (first-time) and Rtn (returning) with a derived `pct_new_revenue` column.',
      ].join(' '),
      schema: NewVsReturningArgs as z.ZodType<NewVsReturningArgs>,
      jsonSchema: zodToJsonSchema(NewVsReturningArgs),
      execute: (args: NewVsReturningArgs) => this.runNewVsReturning(args),
    };
  }

  private async runNewVsReturning(args: NewVsReturningArgs) {
    const breakdownValues = await this.expandBreakdownValues(args.breakdownKey);
    const csv = await this.deps.nb.runExport(this.buildExport({
      dateRange: args.dateRange,
      attributionModel: 'northbeam_custom__va',
      metrics: NVR_METRICS,
      breakdown: { key: args.breakdownKey, values: breakdownValues },
      level: args.level,
      aggregateData: args.level === 'platform',
    }));
    const breakdownColumn = breakdownColumnFor(args.breakdownKey);
    const rows = csv.rows.map((r) => {
      const get = (col: string) => {
        const i = csv.headers.indexOf(col);
        return i >= 0 ? Number(r[i] ?? 0) : 0;
      };
      const channel = (() => {
        const i = csv.headers.indexOf(breakdownColumn);
        return i >= 0 ? String(r[i]) : 'unknown';
      })();
      const campaignName = (() => {
        const i = csv.headers.indexOf('campaign_name');
        return i >= 0 ? String(r[i]) : null;
      })();
      const rev = get('rev');
      const revFt = get('rev_1st_time');
      const revRtn = get('rev_returning');
      return {
        channel,
        ...(campaignName ? { campaign: campaignName } : {}),
        revenue_total: round2(rev),
        revenue_new: round2(revFt),
        revenue_returning: round2(revRtn),
        pct_new_revenue: rev > 0 ? round2((revFt / rev) * 100) : 0,
        transactions_total: round2(get('transactions')),
        transactions_new: round2(get('transactions_1st_time')),
        transactions_returning: round2(get('transactions_returning')),
        spend: round2(get('spend')),
        cac: round2(get('customer_acquisition_cost')),
        cac_new: round2(get('new_customer_acquisition_cost')),
      };
    });
    rows.sort((a, b) => b.revenue_total - a.revenue_total);
    return { period: args.dateRange, breakdown: args.breakdownKey, level: args.level, rows };
  }

  private budgetOptimizationReport(): ToolDef<BudgetOptimizationArgs> {
    return {
      name: 'gantri.budget_optimization_report',
      description: [
        'Per-campaign marginal ROAS analysis comparing two periods. Surfaces low-marginal-ROAS campaigns for budget cuts.',
        'Use for "if I had to cut 20% of budget, which campaigns have lowest marginal ROAS", "which campaigns are wasting spend", "rank Meta campaigns by efficiency" (Q6 in the marketing question list).',
        'Args: currentPeriod + priorPeriod (typically equal-length back-to-back windows, e.g. last 14 days vs prior 14 days). Returns one row per campaign with current_rev/spend/roas, prior_rev/spend/roas, and marginal_roas = (current_rev - prior_rev) / (current_spend - prior_spend) when spend changed. Sorted ascending by marginal_roas (worst first).',
        'Filters out campaigns with current spend below `minSpendDollars` (default $100) to drop noise.',
      ].join(' '),
      schema: BudgetOptimizationArgs as z.ZodType<BudgetOptimizationArgs>,
      jsonSchema: zodToJsonSchema(BudgetOptimizationArgs),
      execute: (args: BudgetOptimizationArgs) => this.runBudgetOptimization(args),
    };
  }

  private async runBudgetOptimization(args: BudgetOptimizationArgs) {
    const fetchPeriod = async (range: { startDate: string; endDate: string }) => {
      return this.deps.nb.runExport(this.buildExport({
        dateRange: range,
        attributionModel: 'northbeam_custom__va',
        metrics: ['rev', 'spend', 'txns'],
        level: 'campaign',
        aggregateData: false,
      }));
    };
    const [current, prior] = await Promise.all([
      fetchPeriod(args.currentPeriod),
      fetchPeriod(args.priorPeriod),
    ]);
    const indexBy = (csv: { headers: string[]; rows: Array<Record<string, string>> | Array<Array<string | number | null>> }) => {
      const map = new Map<string, { rev: number; spend: number; txns: number; campaign: string; platform: string }>();
      const get = (row: Array<unknown>, col: string) => {
        const i = csv.headers.indexOf(col);
        return i >= 0 ? row[i] : null;
      };
      for (const r of csv.rows as Array<Array<unknown>>) {
        const campaign = String(get(r, 'campaign_name') ?? 'unknown');
        const platform = String(get(r, 'breakdown_platform_northbeam') ?? '');
        const key = `${platform}::${campaign}`;
        const e = map.get(key) ?? { rev: 0, spend: 0, txns: 0, campaign, platform };
        e.rev += Number(get(r, 'rev') ?? 0);
        e.spend += Number(get(r, 'spend') ?? 0);
        e.txns += Number(get(r, 'transactions') ?? 0);
        map.set(key, e);
      }
      return map;
    };
    const cur = indexBy(current);
    const pri = indexBy(prior);
    const allKeys = new Set([...cur.keys(), ...pri.keys()]);
    const rows = [];
    for (const k of allKeys) {
      const c = cur.get(k) ?? { rev: 0, spend: 0, txns: 0, campaign: '', platform: '' };
      const p = pri.get(k) ?? { rev: 0, spend: 0, txns: 0, campaign: c.campaign, platform: c.platform };
      if (c.spend < args.minSpendDollars) continue;
      const dRev = c.rev - p.rev;
      const dSpend = c.spend - p.spend;
      rows.push({
        platform: c.platform || p.platform,
        campaign: c.campaign || p.campaign,
        current_rev: round2(c.rev),
        current_spend: round2(c.spend),
        current_roas: c.spend > 0 ? round2(c.rev / c.spend) : null,
        prior_rev: round2(p.rev),
        prior_spend: round2(p.spend),
        prior_roas: p.spend > 0 ? round2(p.rev / p.spend) : null,
        delta_rev: round2(dRev),
        delta_spend: round2(dSpend),
        marginal_roas: Math.abs(dSpend) > 1 ? round2(dRev / dSpend) : null,
      });
    }
    // Sort: lowest current_roas first when no marginal info; lowest marginal_roas first otherwise
    rows.sort((a, b) => (a.marginal_roas ?? a.current_roas ?? 999) - (b.marginal_roas ?? b.current_roas ?? 999));
    return { currentPeriod: args.currentPeriod, priorPeriod: args.priorPeriod, minSpendDollars: args.minSpendDollars, rows };
  }

  private async expandBreakdownValues(key: string): Promise<string[]> {
    const breakdowns = await this.deps.nb.listBreakdowns();
    const match = breakdowns.find((b) => b.key === key);
    if (!match) throw new Error(`Breakdown "${key}" not found in NB catalog`);
    return match.values;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function breakdownColumnFor(key: string): string {
  switch (key) {
    case 'Platform (Northbeam)': return 'breakdown_platform_northbeam';
    case 'Forecast': return 'breakdown_forecast';
    case 'Category (Northbeam)': return 'breakdown_category_northbeam';
    default: return 'breakdown_' + key.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  }
}

void PT_TZ;
