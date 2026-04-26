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

// NB's data-export API quietly remaps metric IDs to its own column names in
// the CSV. Discovered empirically with scripts/probe-csv-columns.mjs — without
// this mapping, lookups silently zero-fill (e.g. metric_id="txns" → column
// "transactions"; aovFtLtv → ltv_aov_1st_time, not aov_1st_time_ltv).
const METRIC_TO_COL: Record<string, string> = {
  rev: 'rev',
  spend: 'spend',
  txns: 'transactions',
  cac: 'cac',
  cacFt: 'cac_1st_time',
  aovFt: 'aov_1st_time',
  aovFtLtv: 'ltv_aov_1st_time',
  roasFt: 'roas_1st_time',
  roasFtLtv: 'ltv_roas_1st_time',
  revFt: 'rev_1st_time',
  revRtn: 'rev_returning',
  txnsFt: 'transactions_1st_time',
  txnsRtn: 'transactions_returning',
};

function colFor(metricId: string): string {
  return METRIC_TO_COL[metricId] ?? metricId;
}

// NB ignores `accounting_modes` and `attribution_windows` in the request body
// and returns rows for every (mode × window) combo, with different metrics
// populated in different rows (e.g. `rev` lives in Cash+lifetime; LTV lives
// in Accrual+1). Merge per group taking the first non-blank value per column
// so we end up with one row per (channel[, campaign]) holding every populated
// metric.
function mergeRowsByChannel(
  rows: Array<Record<string, string>>,
  channelCol: string,
  campaignCol?: string,
): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>();
  for (const r of rows) {
    const channel = r[channelCol] ?? '';
    const campaign = campaignCol ? (r[campaignCol] ?? '') : '';
    const key = campaignCol ? `${channel}::${campaign}` : channel;
    const existing = map.get(key) ?? {};
    for (const [k, v] of Object.entries(r)) {
      if (v == null || v === '') continue;
      const cur = existing[k];
      if (cur == null || cur === '') existing[k] = v;
    }
    if (channel && existing[channelCol] == null) existing[channelCol] = channel;
    if (campaignCol && campaign && existing[campaignCol] == null) existing[campaignCol] = campaign;
    map.set(key, existing);
  }
  return map;
}

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
  /** Restrict to one platform (e.g. "Facebook Ads", "Google Ads"). Null/undefined = all platforms. Use for "cut N% of Meta budget" / "lowest ROAS Google campaigns" questions. */
  platformFilter: z.string().optional(),
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
    // Sequential, NOT parallel: firing all 7 exports at once saturates NB's
    // queue and every poll loop competes for the same 90s budget. Serial keeps
    // each export under its own timeout window. ~5-10s × 7 = 35-70s total —
    // acceptable for a tool that gives a 7-model side-by-side.
    const results: Array<
      | { model: { id: string; name: string }; ok: true; headers: string[]; rows: Array<Record<string, string>> }
      | { model: { id: string; name: string }; ok: false; error: string }
    > = [];
    for (const m of models) {
      try {
        const csv = await this.deps.nb.runExport(
          this.buildExport({
            dateRange: args.dateRange,
            attributionModel: m.id,
            metrics: args.metrics,
            breakdown,
            aggregateData: true,
          }),
          { timeoutMs: 180_000 }, // bump per-export budget from default 90s to 180s for heavy analysis windows
        );
        results.push({ model: m, ok: true, headers: csv.headers, rows: csv.rows });
      } catch (err) {
        results.push({ model: m, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    // Aggregate per-model totals across breakdown rows for the comparison view.
    // CSV rows come back as Record<col_name, string_value>, so access by name.
    // Filter to one (accounting_mode × attribution_window) combo per channel
    // so we don't double-count across NB's mode/window expansion.
    const perModel = results.map((r) => {
      if (!r.ok) return { model_id: r.model.id, model_name: r.model.name, error: r.error };
      const merged = mergeRowsByChannel(r.rows, 'breakdown_platform_northbeam');
      const sum = (metricId: string) => {
        const col = colFor(metricId);
        if (!r.headers.includes(col)) return null;
        return [...merged.values()].reduce((acc, row) => acc + (Number(row[col]) || 0), 0);
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
    const csv = await this.deps.nb.runExport(
      this.buildExport({
        dateRange: args.dateRange,
        attributionModel: 'northbeam_custom__va',
        metrics: [...LTV_METRICS],
        breakdown: { key: args.breakdownKey, values: breakdownValues },
        aggregateData: true,
      }),
      { timeoutMs: 180_000 },
    );
    const breakdownColumn = breakdownColumnFor(args.breakdownKey);
    // NB returns one row per (channel × accounting_mode × attribution_window),
    // and LTV columns live in a different combo than rev/spend. Merge per
    // channel taking first non-blank value so we end up with one row per
    // channel containing every populated column.
    const merged = mergeRowsByChannel(csv.rows, breakdownColumn);
    const rows = [...merged.values()].map((r) => {
      const get = (col: string): number | null => {
        const v = r[col];
        return v === '' || v == null ? null : Number(v);
      };
      const channel = r[breakdownColumn] ?? 'unknown';
      const aovFtLtv = get(colFor('aovFtLtv'));
      const cacFt = get(colFor('cacFt'));
      const aovFt = get(colFor('aovFt'));
      const rev = get(colFor('rev'));
      const revFt = get(colFor('revFt'));
      const spend = get(colFor('spend'));
      return {
        channel,
        revenue: round2(rev ?? 0),
        first_time_revenue: round2(revFt ?? 0),
        spend: round2(spend ?? 0),
        cac_first_time: cacFt != null ? round2(cacFt) : null,
        aov_first_time: aovFt != null ? round2(aovFt) : null,
        aov_first_time_ltv: aovFtLtv != null ? round2(aovFtLtv) : null,
        roas_first_time: get(colFor('roasFt')) ?? null,
        roas_first_time_ltv: get(colFor('roasFtLtv')) ?? null,
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
    const csv = await this.deps.nb.runExport(
      this.buildExport({
        dateRange: args.dateRange,
        attributionModel: 'northbeam_custom__va',
        metrics: NVR_METRICS,
        breakdown: { key: args.breakdownKey, values: breakdownValues },
        level: args.level,
        aggregateData: args.level === 'platform',
      }),
      { timeoutMs: 180_000 },
    );
    const breakdownColumn = breakdownColumnFor(args.breakdownKey);
    // Merge multi-(mode, window) rows so cac/cacFt + revFt/revRtn (which NB
    // splits across separate rows) end up on the same row per channel.
    const merged = mergeRowsByChannel(csv.rows, breakdownColumn, args.level === 'campaign' ? 'campaign_name' : undefined);
    const rows = [...merged.values()].map((r) => {
      const get = (col: string): number => {
        const v = r[col];
        return v == null || v === '' ? 0 : Number(v);
      };
      const channel = r[breakdownColumn] ?? 'unknown';
      const campaignName = r['campaign_name'] ?? null;
      const rev = get(colFor('rev'));
      const revFt = get(colFor('revFt'));
      const revRtn = get(colFor('revRtn'));
      return {
        channel,
        ...(campaignName ? { campaign: campaignName } : {}),
        revenue_total: round2(rev),
        revenue_new: round2(revFt),
        revenue_returning: round2(revRtn),
        pct_new_revenue: rev > 0 ? round2((revFt / rev) * 100) : 0,
        transactions_total: round2(get(colFor('txns'))),
        transactions_new: round2(get(colFor('txnsFt'))),
        transactions_returning: round2(get(colFor('txnsRtn'))),
        spend: round2(get(colFor('spend'))),
        cac: round2(get(colFor('cac'))),
        cac_new: round2(get(colFor('cacFt'))),
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
    // When filtering to one platform, push it through as a breakdown so NB
    // attaches breakdown_platform_northbeam to each campaign row (and only
    // returns campaigns from that platform). Without this, campaign-level
    // exports come back without any platform column at all.
    const breakdown = args.platformFilter
      ? { key: 'Platform (Northbeam)', values: [args.platformFilter] }
      : undefined;
    const fetchPeriod = async (range: { startDate: string; endDate: string }) => {
      return this.deps.nb.runExport(
        this.buildExport({
          dateRange: range,
          attributionModel: 'northbeam_custom__va',
          metrics: ['rev', 'spend', 'txns'],
          breakdown,
          level: 'campaign',
          aggregateData: false,
        }),
        { timeoutMs: 180_000 },
      );
    };
    // Sequential, not parallel — see attribution_compare_models for rationale.
    const current = await fetchPeriod(args.currentPeriod);
    const prior = await fetchPeriod(args.priorPeriod);
    const indexBy = (csv: { headers: string[]; rows: Array<Record<string, string>> }) => {
      // aggregate_data:false → one row per (campaign × day [× mode × window]).
      // Empirically NB returns only the Cash-snapshot/lifetime combo at campaign
      // level + non-aggregated, so a straight sum over all rows is correct.
      // Defensive: filter to that combo only in case NB starts expanding modes.
      const map = new Map<string, { rev: number; spend: number; txns: number; campaign: string; platform: string }>();
      for (const r of csv.rows) {
        if (r.accounting_mode && r.accounting_mode !== 'Cash snapshot') continue;
        const campaign = r['campaign_name'] || 'unknown';
        const platform = r['breakdown_platform_northbeam'] || '';
        const key = `${platform}::${campaign}`;
        const e = map.get(key) ?? { rev: 0, spend: 0, txns: 0, campaign, platform };
        e.rev += Number(r['rev'] || 0);
        e.spend += Number(r['spend'] || 0);
        e.txns += Number(r['transactions'] || 0);
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
