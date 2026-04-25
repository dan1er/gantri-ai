import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import type { GrafanaConnector } from '../grafana/grafana-connector.js';

const Args = z.object({
  type: z.array(z.enum(['Order', 'Wholesale', 'Trade', 'Third Party', 'Refund', 'Replacement'])).optional(),
  customerName: z.string().min(1).max(100).optional(),
  organizationId: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
type Args = z.infer<typeof Args>;

export interface LateOrdersConnectorDeps {
  grafana: GrafanaConnector;
}

export class LateOrdersConnector implements Connector {
  readonly name = 'late_orders';
  readonly tools: readonly ToolDef[];

  constructor(private readonly deps: LateOrdersConnectorDeps) {
    this.tools = this.buildTools();
  }

  async healthCheck() { return { ok: true }; }

  private buildTools(): ToolDef[] {
    const tool: ToolDef<Args> = {
      name: 'gantri.late_orders_report',
      description:
        'One-shot report of currently-late orders (Porter\'s `Transactions.isLateOrder = true`, excluding Cancelled/Lost/Refunded/Delivered). Returns per-order: id, type, status, customerName, shipsAt, daysLate, totalDollars, primaryCause, plus job-level counts (attention/rework/late/exceeded) and a sample of flagged job descriptions. Also returns aggregate buckets: by days-late range (0-3 / 4-7 / 8-14 / 15+), by primaryCause, by type. Use this whenever the user asks about late / delayed / atrasadas / retrasadas orders, or wants a summary of why orders are running behind. Backed by a single Grafana SQL query — fast and consistent.',
      schema: Args as z.ZodType<Args>,
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: {
            type: 'array',
            items: { type: 'string', enum: ['Order', 'Wholesale', 'Trade', 'Third Party', 'Refund', 'Replacement'] },
            description: 'Optional transaction-type filter.',
          },
          customerName: { type: 'string', description: 'Substring match on Transactions.customerName (case-insensitive).' },
          organizationId: { type: 'integer', description: 'Filter to a single organizationId.' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max orders to list. Default 100.' },
        },
      },
      execute: (args) => this.run(args),
    };
    return [tool];
  }

  private async run(args: Args) {
    const sql = buildSql(args);
    // The query is current-state; no historical date range. Pick a wide ms window
    // because some Grafana proxy versions still want from/to even when SQL ignores them.
    const fromMs = Date.now() - 365 * 86_400_000;
    const toMs = Date.now() + 86_400_000;
    const { fields, rows } = await this.deps.grafana.runSql({
      sql,
      fromMs,
      toMs,
      maxRows: args.limit + 5,
    });
    const orders = rowsToOrders(fields, rows);
    return {
      totalLate: orders.length,
      ordersListed: orders.length,
      buckets: computeBuckets(orders),
      orders,
    };
  }
}

interface OrderOut {
  id: number;
  type: string;
  status: string;
  customerName: string | null;
  organizationId: number | null;
  shipsAt: string | null;
  daysLate: number;
  totalDollars: number | null;
  jobCount: number;
  attentionCount: number;
  reworkCount: number;
  lateJobCount: number;
  exceededCount: number;
  primaryCause: string;
  flaggedJobs: string[];
  causes: string[];
  adminLink: string;
}

function buildSql(args: Args): string {
  const filters: string[] = [];
  if (args.type && args.type.length > 0) {
    const list = args.type.map((t) => `'${t.replace(/'/g, "''")}'`).join(',');
    filters.push(`AND t.type IN (${list})`);
  }
  if (args.customerName) {
    const safe = args.customerName.replace(/'/g, "''");
    filters.push(`AND t."customerName" ILIKE '%${safe}%'`);
  }
  if (typeof args.organizationId === 'number') {
    filters.push(`AND t."organizationId" = ${args.organizationId}`);
  }
  const filterClause = filters.join('\n    ');
  return `
WITH late AS (
  SELECT
    t.id,
    t.type,
    t.status,
    t."customerName",
    t."organizationId",
    t."shipsAt",
    GREATEST(0, EXTRACT(DAY FROM (NOW() - t."shipsAt")))::int AS days_late,
    COALESCE((amount->>'total')::numeric,
             (amount->>'subtotal')::numeric
             + COALESCE((amount->>'shipping')::numeric, 0)
             + COALESCE((amount->>'tax')::numeric, 0)) / 100.0 AS total_dollars
  FROM "Transactions" t
  WHERE t."isLateOrder" = true
    -- Exclude completed statuses so we only see actionable in-flight orders.
    -- "Partially shipped" / "Partially delivered" stay because they still have
    -- open lines.
    AND t.status NOT IN ('Cancelled', 'Lost', 'Refunded', 'Delivered', 'Shipped', 'Partially refunded')
    -- Cap to the last 365 days. Orders flagged late but lingering for years
    -- are zombie data (should have been Cancelled or Lost long ago) and
    -- aren't actionable.
    AND t."shipsAt" >= NOW() - INTERVAL '365 days'
    ${filterClause}
),
job_summary AS (
  SELECT
    j."orderId",
    COUNT(*)::int AS job_count,
    COUNT(*) FILTER (WHERE j."hasAttention")::int AS attention_count,
    COUNT(*) FILTER (WHERE j."isRework")::int AS rework_count,
    COUNT(*) FILTER (WHERE j."isLateOrder")::int AS late_job_count,
    COUNT(*) FILTER (WHERE j."exceededCycleTime" > 0)::int AS exceeded_count,
    array_agg(j.description) FILTER (WHERE j."hasAttention" OR j."isRework" OR j."exceededCycleTime" > 0) AS flagged_descriptions,
    array_agg(DISTINCT j.cause) FILTER (WHERE j.cause IS NOT NULL AND j.cause <> '') AS distinct_causes
  FROM "Jobs" j
  WHERE j."orderId" IN (SELECT id FROM late)
  GROUP BY j."orderId"
)
SELECT
  l.id,
  l.type,
  l.status,
  l."customerName",
  l."organizationId",
  l."shipsAt",
  l.days_late,
  l.total_dollars,
  COALESCE(js.job_count, 0) AS job_count,
  COALESCE(js.attention_count, 0) AS attention_count,
  COALESCE(js.rework_count, 0) AS rework_count,
  COALESCE(js.late_job_count, 0) AS late_job_count,
  COALESCE(js.exceeded_count, 0) AS exceeded_count,
  js.flagged_descriptions,
  js.distinct_causes
FROM late l
LEFT JOIN job_summary js ON js."orderId" = l.id
ORDER BY l.days_late DESC
LIMIT ${args.limit};
`;
}

function rowsToOrders(fields: string[], rows: unknown[][]): OrderOut[] {
  const idx = (n: string) => fields.indexOf(n);
  const out: OrderOut[] = [];
  for (const row of rows) {
    const id = Number(row[idx('id')]);
    const flagged = parseStringArray(row[idx('flagged_descriptions')]);
    const causes = parseStringArray(row[idx('distinct_causes')]);
    const attentionCount = Number(row[idx('attention_count')] ?? 0);
    const reworkCount = Number(row[idx('rework_count')] ?? 0);
    const lateJobCount = Number(row[idx('late_job_count')] ?? 0);
    const exceededCount = Number(row[idx('exceeded_count')] ?? 0);
    out.push({
      id,
      type: String(row[idx('type')] ?? ''),
      status: String(row[idx('status')] ?? ''),
      customerName: (row[idx('customerName')] as string | null) ?? null,
      organizationId: row[idx('organizationId')] != null ? Number(row[idx('organizationId')]) : null,
      shipsAt: (row[idx('shipsAt')] as string | null) ?? null,
      daysLate: Number(row[idx('days_late')] ?? 0),
      totalDollars: row[idx('total_dollars')] != null ? Math.round(Number(row[idx('total_dollars')]) * 100) / 100 : null,
      jobCount: Number(row[idx('job_count')] ?? 0),
      attentionCount,
      reworkCount,
      lateJobCount,
      exceededCount,
      primaryCause: derivePrimaryCause({ attentionCount, reworkCount, lateJobCount, exceededCount, causes }),
      flaggedJobs: flagged.slice(0, 5),
      causes,
      adminLink: `http://admin.gantri.com/orders/${id}`,
    });
  }
  return out;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((s) => s.length > 0);
  if (typeof value === 'string') {
    // Postgres array-as-text fallback: "{a,b,\"c d\"}". Try a forgiving parse.
    if (value.startsWith('{') && value.endsWith('}')) {
      const inner = value.slice(1, -1);
      if (!inner) return [];
      return inner.split(',').map((s) => s.replace(/^"|"$/g, '').trim()).filter((s) => s.length > 0);
    }
    return [value];
  }
  return [];
}

export function derivePrimaryCause(input: {
  attentionCount: number;
  reworkCount: number;
  lateJobCount: number;
  exceededCount: number;
  causes: string[];
}): string {
  if (input.attentionCount > 0) return 'Has attention';
  if (input.reworkCount > 0) return 'Rework';
  if (input.exceededCount > 0) return 'Exceeded cycle time';
  if (input.lateJobCount > 0) return 'Late job(s)';
  if (input.causes.length > 0) return input.causes[0];
  return 'Unknown';
}

export function computeBuckets(orders: OrderOut[]) {
  const byDaysLate: Record<string, number> = { '0-3': 0, '4-7': 0, '8-14': 0, '15+': 0 };
  const byPrimaryCause: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const o of orders) {
    const bucket = o.daysLate <= 3 ? '0-3' : o.daysLate <= 7 ? '4-7' : o.daysLate <= 14 ? '8-14' : '15+';
    byDaysLate[bucket]++;
    byPrimaryCause[o.primaryCause] = (byPrimaryCause[o.primaryCause] ?? 0) + 1;
    byType[o.type] = (byType[o.type] ?? 0) + 1;
  }
  return { byDaysLate, byPrimaryCause, byType };
}
