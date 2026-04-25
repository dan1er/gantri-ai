import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import type { RollupRepo, RollupRow } from '../../storage/rollup-repo.js';

const Args = z.object({
  dateRange: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  dimension: z.enum(['type', 'status', 'organization', 'none']).default('none'),
  granularity: z.enum(['day', 'week', 'month']).default('day'),
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
        'Fast pre-aggregated read for revenue and order count over a PT date range. Backed by a nightly-refreshed Supabase rollup table — use this INSTEAD of grafana.sql for any aggregate revenue/orders question that fits its grain (day/week/month, optionally broken down by type/status/organization). Returns rows with `date`, optional `dimensionKey`, `totalOrders`, `totalRevenueDollars`. Excludes Cancelled and Lost orders. The rollup refreshes daily at 04:00 PT and covers the trailing 30 days plus all historical data; queries that span the very current PT day may be incomplete by up to one refresh cycle.',
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
    return rows.map((r) => formatRow(r));
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
  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date)).map((r) => formatRow(r));
}

function formatRow(r: FlatRow) {
  const obj: Record<string, unknown> = {
    date: r.date,
    totalOrders: r.totalOrders,
    totalRevenueDollars: Math.round(r.totalRevenueCents) / 100,
  };
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
