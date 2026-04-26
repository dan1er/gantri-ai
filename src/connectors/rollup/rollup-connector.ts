import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import type { RollupRepo, RollupRow } from '../../storage/rollup-repo.js';

const Args = z.object({
  dateRange: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  dimension: z.enum(['type', 'status', 'organization', 'none']).default('none'),
  // 'period' = collapse the whole window into one bucket per dimensionKey (or
  // a single total row when dimension='none'). Use this whenever the question
  // does NOT need a time series — e.g. "revenue by type", "orders by status",
  // "wholesale total this year". Avoids returning thousands of day-rows that
  // blow up the LLM context.
  granularity: z.enum(['period', 'day', 'week', 'month']).default('period'),
});
type Args = z.infer<typeof Args>;

export interface RollupConnectorDeps {
  repo: RollupRepo;
}

export class RollupConnector implements Connector {
  readonly name = 'rollup';
  readonly tools: readonly ToolDef[];

  constructor(private readonly deps: RollupConnectorDeps) {
    this.tools = this.buildTools();
  }

  async healthCheck() { return { ok: true }; }

  private buildTools(): ToolDef[] {
    const tool: ToolDef<Args> = {
      name: 'gantri.daily_rollup',
      description:
        'Fast pre-aggregated read for revenue and order count over a PT date range. Backed by a nightly-refreshed Supabase rollup table that covers from 2019-09-29 to today. Use this INSTEAD of grafana.sql for any aggregate revenue/orders question. Returns rows with optional `date`, optional `dimensionKey`, `totalOrders`, `totalRevenueDollars`. Excludes Cancelled orders only (matches Grafana Sales). Refund-type rows carry NEGATIVE revenue so totals are net of refunds. **Pick `granularity` carefully:** `period` (default) returns ONE row per dimension key totaled across the whole window — use this for non-time-series questions like "revenue by type", "top platform last month", "wholesale total this year". `day`/`week`/`month` return one row per (period × dimension key) — use ONLY when the user explicitly wants a time series. Calling with `dimension:type` + `granularity:day` over multi-year ranges returns thousands of rows and blows up the LLM context — DO NOT do this. **The response includes the `period` (start/end dates) so you MUST quote those dates back to the user in the answer**, e.g. "For 2024-01-01 to 2026-04-25, Order revenue is $3.9M". Never give a number without stating the window.',
      schema: Args as z.ZodType<Args>,
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['dateRange'],
        properties: {
          dateRange: {
            type: 'object',
            additionalProperties: false,
            required: ['startDate', 'endDate'],
            properties: {
              startDate: { type: 'string', description: 'YYYY-MM-DD, Pacific Time, inclusive.' },
              endDate: { type: 'string', description: 'YYYY-MM-DD, Pacific Time, inclusive.' },
            },
          },
          dimension: { type: 'string', enum: ['type', 'status', 'organization', 'none'] },
          granularity: { type: 'string', enum: ['day', 'week', 'month'] },
        },
      },
      execute: (args) => this.run(args),
    };
    return [tool];
  }

  private async run(args: Args) {
    const days = await this.deps.repo.getRange(args.dateRange.startDate, args.dateRange.endDate);
    const flat = explode(days, args.dimension);
    const grouped = groupByGrain(flat, args.granularity);
    return {
      period: args.dateRange,
      dimension: args.dimension,
      granularity: args.granularity,
      rows: grouped,
      sourceDayCount: days.length,
    };
  }
}

interface FlatRow {
  date: string;
  dimensionKey: string | null;
  totalOrders: number;
  totalRevenueCents: number;
}

function explode(days: RollupRow[], dimension: Args['dimension']): FlatRow[] {
  const out: FlatRow[] = [];
  for (const d of days) {
    if (dimension === 'none') {
      out.push({
        date: d.date,
        dimensionKey: null,
        totalOrders: d.total_orders,
        totalRevenueCents: d.total_revenue_cents,
      });
      continue;
    }
    const map =
      dimension === 'type' ? d.by_type
      : dimension === 'status' ? d.by_status
      : d.by_organization;
    for (const [key, agg] of Object.entries(map ?? {})) {
      out.push({
        date: d.date,
        dimensionKey: key,
        totalOrders: agg.orders,
        totalRevenueCents: agg.revenueCents,
      });
    }
  }
  return out;
}

function groupByGrain(rows: FlatRow[], granularity: Args['granularity']) {
  if (granularity === 'day') {
    return rows.map((r) => formatRow(r, false));
  }
  if (granularity === 'period') {
    // One bucket per dimensionKey across the whole window. The `date` column
    // is omitted from the formatted output since it's meaningless here — the
    // caller already has the period via the response's `period` field.
    const buckets = new Map<string, FlatRow>();
    for (const r of rows) {
      const key = r.dimensionKey ?? '__total__';
      const existing = buckets.get(key);
      if (existing) {
        existing.totalOrders += r.totalOrders;
        existing.totalRevenueCents += r.totalRevenueCents;
      } else {
        buckets.set(key, { date: '', dimensionKey: r.dimensionKey, totalOrders: r.totalOrders, totalRevenueCents: r.totalRevenueCents });
      }
    }
    return [...buckets.values()]
      .sort((a, b) => b.totalRevenueCents - a.totalRevenueCents)
      .map((r) => formatRow(r, true));
  }
  const buckets = new Map<string, FlatRow>();
  for (const r of rows) {
    const bucketDate = granularity === 'week' ? mondayOf(r.date) : firstOfMonth(r.date);
    const key = `${bucketDate}|${r.dimensionKey ?? ''}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.totalOrders += r.totalOrders;
      existing.totalRevenueCents += r.totalRevenueCents;
    } else {
      buckets.set(key, { date: bucketDate, dimensionKey: r.dimensionKey, totalOrders: r.totalOrders, totalRevenueCents: r.totalRevenueCents });
    }
  }
  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date)).map((r) => formatRow(r, false));
}

function formatRow(r: FlatRow, omitDate: boolean) {
  const obj: Record<string, unknown> = {
    totalOrders: r.totalOrders,
    totalRevenueDollars: Math.round(r.totalRevenueCents) / 100,
  };
  if (!omitDate) obj.date = r.date;
  if (r.dimensionKey !== null) obj.dimensionKey = r.dimensionKey;
  return obj;
}

function mondayOf(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() - (dow - 1));
  return dt.toISOString().slice(0, 10);
}

function firstOfMonth(ymd: string): string {
  return ymd.slice(0, 7) + '-01';
}
