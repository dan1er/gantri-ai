import pg from 'pg';
import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import { DateRangeArg, normalizeDateRange } from '../base/date-range.js';
import { logger } from '../../logger.js';

const { Pool } = pg;

export interface PorterDbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
}

/**
 * Connector for the Porter PostgreSQL database. All queries run in a session
 * that is pinned to `default_transaction_read_only = on`, so any attempt to
 * mutate data (accidental or via SQL injection) will fail at the database
 * boundary even though the supplied credentials may have write privileges.
 */
export class GantriDbConnector implements Connector {
  readonly name = 'gantri';
  readonly tools: readonly ToolDef[];

  private readonly pool: pg.Pool;

  constructor(cfg: PorterDbConfig) {
    this.pool = new Pool({
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      user: cfg.user,
      password: cfg.password,
      ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
      // Force every session into read-only mode — DDL and DML are rejected
      // with "cannot execute ... in a read-only transaction".
      options: '-c default_transaction_read_only=on',
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    this.pool.on('error', (err) => {
      logger.error({ err: err.message }, 'gantri-db pool error');
    });

    this.tools = buildGantriDbTools(this.pool);
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const r = await this.pool.query(
        'select current_user as u, current_database() as db, now() as ts',
      );
      return { ok: true, detail: `${r.rows[0].u}@${r.rows[0].db} ${r.rows[0].ts}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ============================================================================
// Tool definitions
// ============================================================================

const TRANSACTION_TYPES = [
  'Order',
  'Refund',
  'Marketing',
  'Replacement',
  'Wholesale',
  'Third Party',
  'R&D',
  'Trade',
  'Wholesale Refund',
  'Third Party Refund',
  'Trade Refund',
  'Made',
  'Designer',
] as const;

const ORDER_STATUSES = [
  'Processed',
  'Ready to ship',
  'Partially shipped',
  'Shipped',
  'Partially delivered',
  'Delivered',
  'Cancelled',
  'Refunded',
  'Partially refunded',
  'Lost',
] as const;

/** PT-to-UTC instant conversion matching our other date-range handling. */
function toIsoRange(range: { startDate: string; endDate: string }) {
  const nextDay = new Date(`${range.endDate}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return {
    start: `${range.startDate}T07:00:00.000Z`,
    end: `${nextDay.toISOString().slice(0, 10)}T06:59:59.999Z`,
  };
}

const OrdersQueryArgs = z.object({
  types: z
    .array(z.enum(TRANSACTION_TYPES))
    .optional()
    .describe('Transaction types. Defaults to ["Order"]. Use "Refund" etc. to include other types.'),
  statuses: z.array(z.enum(ORDER_STATUSES)).optional(),
  userId: z.number().int().positive().optional(),
  organizationId: z.number().int().positive().optional(),
  customerNameContains: z.string().min(1).max(100).optional(),
  dateRange: DateRangeArg.optional(),
  minTotalDollars: z.number().min(0).optional(),
  maxTotalDollars: z.number().min(0).optional(),
  limit: z.number().int().min(1).max(500).default(25),
  offset: z.number().int().min(0).default(0),
});
type OrdersQueryArgs = z.infer<typeof OrdersQueryArgs>;

const OrderGetArgs = z.object({
  id: z.number().int().positive(),
});
type OrderGetArgs = z.infer<typeof OrderGetArgs>;

const OrderStatsArgs = z.object({
  dateRange: DateRangeArg,
  types: z.array(z.enum(TRANSACTION_TYPES)).default(['Order']),
});
type OrderStatsArgs = z.infer<typeof OrderStatsArgs>;

// ============================================================================

function buildGantriDbTools(pool: pg.Pool): ToolDef[] {
  const ordersQuery: ToolDef<OrdersQueryArgs> = {
    name: 'gantri.orders_query',
    description:
      'Query orders/transactions directly from Gantri\'s own Porter database (source of truth). Use this when the user asks about order data from Gantri\'s own system: order statuses (Processed/Shipped/Delivered/Refunded/etc.), customer-name lookups, specific user IDs, organization IDs, or transaction types (Order, Refund, Wholesale, Trade, etc.). This is complementary to the Northbeam order tools — Northbeam is attribution-focused; this one is the internal system-of-record.',
    schema: OrdersQueryArgs as z.ZodType<OrdersQueryArgs>,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        types: { type: 'array', items: { type: 'string', enum: TRANSACTION_TYPES as unknown as string[] } },
        statuses: { type: 'array', items: { type: 'string', enum: ORDER_STATUSES as unknown as string[] } },
        userId: { type: 'integer', minimum: 1 },
        organizationId: { type: 'integer', minimum: 1 },
        customerNameContains: { type: 'string' },
        dateRange: {
          // Union: preset string | {start,end} | {startDate,endDate}.
          anyOf: [
            { type: 'string', description: 'PT preset (e.g. "last_30_days").' },
            { type: 'object', required: ['startDate', 'endDate'], properties: { startDate: { type: 'string', description: 'YYYY-MM-DD, interpreted in Pacific Time.' }, endDate: { type: 'string', description: 'YYYY-MM-DD, inclusive, interpreted in Pacific Time.' } } },
            { type: 'object', required: ['start', 'end'], properties: { start: { type: 'string' }, end: { type: 'string' } } },
          ],
        },
        minTotalDollars: { type: 'number', minimum: 0 },
        maxTotalDollars: { type: 'number', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
        offset: { type: 'integer', minimum: 0 },
      },
    },
    async execute(args) {
      const types = args.types ?? ['Order'];
      const conds: string[] = ['t.type = ANY($1::text[])'];
      const params: unknown[] = [types];
      let p = 2;
      if (args.statuses?.length) {
        conds.push(`t.status = ANY($${p++}::text[])`);
        params.push(args.statuses);
      }
      if (args.userId !== undefined) {
        conds.push(`t."userId" = $${p++}`);
        params.push(args.userId);
      }
      if (args.organizationId !== undefined) {
        conds.push(`t."organizationId" = $${p++}`);
        params.push(args.organizationId);
      }
      if (args.customerNameContains) {
        conds.push(`(t."customerName" ILIKE $${p} OR u.email ILIKE $${p})`);
        params.push(`%${args.customerNameContains}%`);
        p++;
      }
      if (args.dateRange) {
        const { start, end } = toIsoRange(normalizeDateRange(args.dateRange));
        conds.push(`t."createdAt" >= $${p++}`);
        params.push(start);
        conds.push(`t."createdAt" <= $${p++}`);
        params.push(end);
      }
      if (args.minTotalDollars !== undefined) {
        conds.push(`(t.amount->>'total')::numeric >= $${p++}`);
        params.push(args.minTotalDollars * 100);
      }
      if (args.maxTotalDollars !== undefined) {
        conds.push(`(t.amount->>'total')::numeric <= $${p++}`);
        params.push(args.maxTotalDollars * 100);
      }

      const sql = `
        select
          t.id, t.type, t.status, t."customerName", t."userId",
          u.email as "userEmail", u."firstName" as "userFirstName", u."lastName" as "userLastName",
          t."organizationId", t."shopifyOrderId", t."productIds",
          t."createdAt", t."shipsAt", t."completedAt",
          t."shipmentStatus", t."shippingTrackingNumber", t."shippingProvider",
          (t.amount->>'total')::numeric / 100 as "totalDollars",
          (t.amount->>'subtotal')::numeric / 100 as "subtotalDollars",
          (t.amount->>'shipping')::numeric / 100 as "shippingDollars",
          (t.amount->>'tax')::numeric / 100 as "taxDollars",
          t.address, t.notes, t."tradeOrderId", t."tradePartnerId"
        from "Transactions" t
        left join "Users" u on t."userId" = u.id
        where ${conds.join(' AND ')}
        order by t."createdAt" desc
        limit $${p++} offset $${p++}
      `;
      params.push(args.limit, args.offset);

      const countSql = `
        select count(*)::int as total
        from "Transactions" t
        left join "Users" u on t."userId" = u.id
        where ${conds.join(' AND ')}
      `;
      const [rowsRes, countRes] = await Promise.all([
        pool.query(sql, params),
        pool.query(countSql, params.slice(0, p - 3)),
      ]);
      return {
        totalCount: countRes.rows[0].total as number,
        returnedCount: rowsRes.rowCount ?? 0,
        orders: rowsRes.rows,
      };
    },
  };

  const orderGet: ToolDef<OrderGetArgs> = {
    name: 'gantri.order_get',
    description:
      'Fetch one Gantri order by its numeric ID, with customer info. Returns the full row (status, amount breakdown, address, tracking, product IDs, trade partner IDs if any, notes).',
    schema: OrderGetArgs as z.ZodType<OrderGetArgs>,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'integer', minimum: 1 },
      },
    },
    async execute(args) {
      const sql = `
        select
          t.*,
          u.email as "userEmail", u."firstName" as "userFirstName", u."lastName" as "userLastName",
          (t.amount->>'total')::numeric / 100 as "totalDollars",
          (t.amount->>'subtotal')::numeric / 100 as "subtotalDollars",
          (t.amount->>'shipping')::numeric / 100 as "shippingDollars",
          (t.amount->>'tax')::numeric / 100 as "taxDollars",
          (t.amount->>'transactionFee')::numeric / 100 as "transactionFeeDollars"
        from "Transactions" t
        left join "Users" u on t."userId" = u.id
        where t.id = $1
      `;
      const r = await pool.query(sql, [args.id]);
      if (r.rowCount === 0) return { ok: false, error: { code: 'NOT_FOUND', message: `Order ${args.id} not found` } };
      return { order: r.rows[0] };
    },
  };

  const orderStats: ToolDef<OrderStatsArgs> = {
    name: 'gantri.order_stats',
    description:
      'Aggregate order stats for a date range: total count, total revenue (dollars), average order value, and breakdown by status and type. Useful for "how many orders did we have this week", "how many refunds vs orders this month", etc.',
    schema: OrderStatsArgs as z.ZodType<OrderStatsArgs>,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['dateRange'],
      properties: {
        dateRange: {
          // Union: preset string | {start,end} | {startDate,endDate}.
          anyOf: [
            { type: 'string' },
            { type: 'object', required: ['startDate', 'endDate'], properties: { startDate: { type: 'string' }, endDate: { type: 'string' } } },
            { type: 'object', required: ['start', 'end'], properties: { start: { type: 'string' }, end: { type: 'string' } } },
          ],
        },
        types: { type: 'array', items: { type: 'string', enum: TRANSACTION_TYPES as unknown as string[] } },
      },
    },
    async execute(args) {
      const period = normalizeDateRange(args.dateRange);
      const { start, end } = toIsoRange(period);
      const types = args.types ?? ['Order'];
      const totalSql = `
        select
          count(*)::int as "totalOrders",
          coalesce(sum((amount->>'total')::numeric) / 100, 0) as "totalRevenueDollars",
          case when count(*) > 0
            then coalesce(sum((amount->>'total')::numeric) / 100, 0) / count(*)
            else 0 end as "avgOrderValueDollars"
        from "Transactions"
        where type = ANY($1::text[]) and "createdAt" >= $2 and "createdAt" <= $3
      `;
      const statusSql = `
        select status, count(*)::int as count,
               coalesce(sum((amount->>'total')::numeric) / 100, 0) as "revenueDollars"
        from "Transactions"
        where type = ANY($1::text[]) and "createdAt" >= $2 and "createdAt" <= $3
        group by status order by count desc
      `;
      const typeSql = `
        select type, count(*)::int as count,
               coalesce(sum((amount->>'total')::numeric) / 100, 0) as "revenueDollars"
        from "Transactions"
        where type = ANY($1::text[]) and "createdAt" >= $2 and "createdAt" <= $3
        group by type order by count desc
      `;
      const [total, statuses, typesAgg] = await Promise.all([
        pool.query(totalSql, [types, start, end]),
        pool.query(statusSql, [types, start, end]),
        pool.query(typeSql, [types, start, end]),
      ]);
      return {
        period,
        typesFilter: types,
        totalOrders: total.rows[0].totalOrders as number,
        totalRevenueDollars: Number(total.rows[0].totalRevenueDollars),
        avgOrderValueDollars: Number(total.rows[0].avgOrderValueDollars),
        statusBreakdown: statuses.rows,
        typeBreakdown: typesAgg.rows,
      };
    },
  };

  return [ordersQuery, orderGet, orderStats];
}
