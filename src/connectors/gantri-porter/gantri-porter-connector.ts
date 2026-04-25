import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import { logger } from '../../logger.js';

export interface PorterApiConfig {
  baseUrl: string;
  email: string;
  password: string;
}

/**
 * Connector that talks to Gantri's Porter backend API as an admin user. The bot
 * authenticates via `POST /api/user/authenticate` and uses the returned HS256
 * JWT for subsequent calls. Tokens are cached in memory and refreshed on the
 * next 401 response.
 *
 * All tools here are READ ONLY — we never call PUT/POST/DELETE endpoints that
 * mutate data. Writes would require expanding this file deliberately.
 */
export class GantriPorterConnector implements Connector {
  readonly name = 'gantri';
  readonly tools: readonly ToolDef[];

  private token: string | null = null;
  private tokenFetchedAt = 0;
  private inflight: Promise<string> | null = null;

  constructor(private readonly cfg: PorterApiConfig) {
    this.tools = buildPorterTools(this);
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.getToken();
      return { ok: true, detail: `authenticated as ${this.cfg.email}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Returns a cached JWT, refreshing if >50 minutes old or missing. */
  async getToken(): Promise<string> {
    const FIFTY_MIN = 50 * 60 * 1000;
    if (this.token && Date.now() - this.tokenFetchedAt < FIFTY_MIN) return this.token;
    if (this.inflight) return this.inflight;
    this.inflight = this.login().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async login(): Promise<string> {
    const res = await fetch(`${this.cfg.baseUrl}/api/user/authenticate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: this.cfg.email, password: this.cfg.password }),
    });
    if (!res.ok) {
      throw new Error(`Porter authenticate failed: HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
    }
    const body = (await res.json()) as { success?: boolean; token?: string };
    if (!body.token) throw new Error('Porter authenticate returned no token');
    this.token = body.token;
    this.tokenFetchedAt = Date.now();
    logger.info('porter api token refreshed');
    return this.token;
  }

  /** HTTP request with auth + one-shot 401 retry (refreshes token once). */
  async fetchJson<T>(
    path: string,
    init: RequestInit = {},
    attempt = 0,
  ): Promise<T> {
    const token = await this.getToken();
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
    });
    if (res.status === 401 && attempt === 0) {
      this.token = null;
      return this.fetchJson<T>(path, init, 1);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Porter ${init.method ?? 'GET'} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }
}

// ============================================================================

const TRANSACTION_TYPES = [
  'Order', 'Refund', 'Marketing', 'Replacement', 'Wholesale', 'Third Party',
  'R&D', 'Trade', 'Wholesale Refund', 'Third Party Refund', 'Trade Refund',
  'Made', 'Designer',
] as const;

const ORDER_STATUSES = [
  'Processed', 'Ready to ship', 'Partially shipped', 'Shipped',
  'Partially delivered', 'Delivered', 'Cancelled', 'Refunded',
  'Partially refunded', 'Lost',
] as const;

const DateRange = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** Convert a YYYY-MM-DD range (Pacific Time) to unix-ms bounds. */
function toUnixMsRange(range: { startDate: string; endDate: string }): { startMs: number; endMs: number } {
  const startMs = Date.parse(`${range.startDate}T07:00:00.000Z`); // 00:00 PT
  const nextDay = new Date(`${range.endDate}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const endMs = Date.parse(`${nextDay.toISOString().slice(0, 10)}T06:59:59.999Z`); // 23:59:59 PT
  return { startMs, endMs };
}

const OrdersQueryArgs = z.object({
  types: z.array(z.enum(TRANSACTION_TYPES)).optional(),
  statuses: z.array(z.enum(ORDER_STATUSES)).optional(),
  search: z.string().min(1).max(200).optional()
    .describe('Free-text search matched against order id, customer name, email, etc.'),
  dateRange: DateRange.optional(),
  late: z.boolean().optional(),
  sortingField: z.enum(['id', 'createdAt', 'completedAt', 'amount']).default('id'),
  sortingType: z.enum(['ASC', 'DESC']).default('DESC'),
  page: z.number().int().min(1).default(1),
  count: z.number().int().min(1).max(200).default(25),
});
type OrdersQueryArgs = z.infer<typeof OrdersQueryArgs>;

const OrderGetArgs = z.object({
  id: z.number().int().positive(),
});
type OrderGetArgs = z.infer<typeof OrderGetArgs>;

const OrderStatsArgs = z.object({
  dateRange: DateRange,
  types: z.array(z.enum(TRANSACTION_TYPES)).default(['Order']),
});
type OrderStatsArgs = z.infer<typeof OrderStatsArgs>;

// ============================================================================

function buildPorterTools(conn: GantriPorterConnector): ToolDef[] {
  /** Normalize an order row: extract dollar amounts, unwrap nested fields. */
  function normalizeOrder(o: any) {
    const amt = o.amount ?? {};
    return {
      id: o.id,
      type: o.type,
      status: o.status,
      customerName: o.customerName,
      userId: o.userId,
      organizationId: o.organizationId,
      shopifyOrderId: o.shopifyOrderId ?? null,
      productIds: o.productIds ?? [],
      createdAt: o.createdAt,
      shipsAt: o.shipsAt ?? null,
      completedAt: o.completedAt ?? null,
      shipmentStatus: o.shipmentStatus ?? null,
      shippingTrackingNumber: o.shippingTrackingNumber ?? null,
      shippingProvider: o.shippingProvider ?? null,
      totalDollars: typeof amt.total === 'number' ? amt.total / 100 : null,
      subtotalDollars: typeof amt.subtotal === 'number' ? amt.subtotal / 100 : null,
      shippingDollars: typeof amt.shipping === 'number' ? amt.shipping / 100 : null,
      taxDollars: typeof amt.tax === 'number' ? amt.tax / 100 : null,
      transactionFeeDollars: typeof amt.transactionFee === 'number' ? amt.transactionFee / 100 : null,
      address: o.address ?? null,
      tradeOrderId: o.tradeOrderId ?? null,
      tradePartnerId: o.tradePartnerId ?? null,
      notes: o.notes ?? null,
      adminLink: `http://admin.gantri.com/orders/${o.id}`,
    };
  }

  const ordersQuery: ToolDef<OrdersQueryArgs> = {
    name: 'gantri.orders_query',
    description:
      'Query orders from Gantri\'s own Porter system (source of truth, authenticated admin API). Supports filtering by transaction type(s), status(es), date range (Pacific Time), free-text search (order id / customer name / email), and a "late" flag. Returns paginated order records with normalized dollar amounts. This is the internal system of record; Northbeam tools are for attribution. Every order in the response has an `adminLink` pointing at admin.gantri.com.',
    schema: OrdersQueryArgs as z.ZodType<OrdersQueryArgs>,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        types: { type: 'array', items: { type: 'string', enum: TRANSACTION_TYPES as unknown as string[] } },
        statuses: { type: 'array', items: { type: 'string', enum: ORDER_STATUSES as unknown as string[] } },
        search: { type: 'string' },
        dateRange: {
          type: 'object',
          additionalProperties: false,
          required: ['startDate', 'endDate'],
          properties: {
            startDate: { type: 'string', description: 'YYYY-MM-DD, Pacific Time.' },
            endDate: { type: 'string', description: 'YYYY-MM-DD, inclusive, Pacific Time.' },
          },
        },
        late: { type: 'boolean' },
        sortingField: { type: 'string', enum: ['id', 'createdAt', 'completedAt', 'amount'] },
        sortingType: { type: 'string', enum: ['ASC', 'DESC'] },
        page: { type: 'integer', minimum: 1 },
        count: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
    async execute(args) {
      const body: Record<string, unknown> = {
        page: args.page,
        count: args.count,
        sortingField: args.sortingField,
        sortingType: args.sortingType,
      };
      if (args.types?.length) body.types = args.types;
      if (args.statuses?.length) body.statuses = args.statuses;
      if (args.search) body.search = args.search;
      if (args.late) body.late = true;
      if (args.dateRange) {
        const { startMs, endMs } = toUnixMsRange(args.dateRange);
        body.startDate = startMs;
        body.endDate = endMs;
      }
      const data = await conn.fetchJson<{
        orders: unknown[];
        allOrders: number;
        maxPages: number;
        page: number;
      }>('/api/admin/paginated-transactions', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return {
        totalMatching: data.allOrders,
        maxPages: data.maxPages,
        page: data.page,
        returnedCount: data.orders.length,
        orders: data.orders.map(normalizeOrder),
      };
    },
  };

  const orderGet: ToolDef<OrderGetArgs> = {
    name: 'gantri.order_get',
    description:
      'Fetch a single Gantri order by its numeric ID from the Porter admin API. Returns the full record with customer info, amount breakdown, tracking, address, stocks, and notes.',
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
      const data = await conn.fetchJson<{ order: any }>(
        `/api/admin/transactions/${args.id}`,
        { method: 'GET' },
      );
      if (!data.order) {
        return { ok: false, error: { code: 'NOT_FOUND', message: `Order ${args.id} not found` } };
      }
      return { order: { ...normalizeOrder(data.order), raw: data.order } };
    },
  };

  const orderStats: ToolDef<OrderStatsArgs> = {
    name: 'gantri.order_stats',
    description:
      'Aggregate order stats for a date range (Pacific Time): total count, total revenue in dollars, average order value, and breakdown by status and type. Paginates through matching orders up to a cap of ~2000 rows.',
    schema: OrderStatsArgs as z.ZodType<OrderStatsArgs>,
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
            startDate: { type: 'string' },
            endDate: { type: 'string' },
          },
        },
        types: { type: 'array', items: { type: 'string', enum: TRANSACTION_TYPES as unknown as string[] } },
      },
    },
    async execute(args) {
      const { startMs, endMs } = toUnixMsRange(args.dateRange);
      const pageSize = 200;
      const maxPages = 10; // 2000 rows cap
      const statusCounts: Record<string, { count: number; revenueDollars: number }> = {};
      const typeCounts: Record<string, { count: number; revenueDollars: number }> = {};
      let totalCount = 0;
      let totalRevenueCents = 0;
      let truncated = false;

      for (let page = 1; page <= maxPages; page++) {
        const data = await conn.fetchJson<{
          orders: any[];
          allOrders: number;
          maxPages: number;
        }>('/api/admin/paginated-transactions', {
          method: 'POST',
          body: JSON.stringify({
            page,
            count: pageSize,
            types: args.types,
            startDate: startMs,
            endDate: endMs,
          }),
        });
        if (page === 1) totalCount = data.allOrders;
        for (const o of data.orders) {
          const total = typeof o.amount?.total === 'number' ? o.amount.total : 0;
          totalRevenueCents += total;
          const sKey = o.status ?? 'unknown';
          statusCounts[sKey] ??= { count: 0, revenueDollars: 0 };
          statusCounts[sKey].count++;
          statusCounts[sKey].revenueDollars += total / 100;
          const tKey = o.type ?? 'unknown';
          typeCounts[tKey] ??= { count: 0, revenueDollars: 0 };
          typeCounts[tKey].count++;
          typeCounts[tKey].revenueDollars += total / 100;
        }
        if (data.orders.length < pageSize) break;
        if (page === maxPages && data.maxPages > maxPages) truncated = true;
      }

      const totalRevenueDollars = totalRevenueCents / 100;
      return {
        period: args.dateRange,
        typesFilter: args.types,
        totalOrders: totalCount,
        totalRevenueDollars,
        avgOrderValueDollars: totalCount > 0 ? totalRevenueDollars / totalCount : 0,
        statusBreakdown: Object.entries(statusCounts)
          .map(([status, v]) => ({ status, ...v, revenueDollars: round2(v.revenueDollars) }))
          .sort((a, b) => b.count - a.count),
        typeBreakdown: Object.entries(typeCounts)
          .map(([type, v]) => ({ type, ...v, revenueDollars: round2(v.revenueDollars) }))
          .sort((a, b) => b.count - a.count),
        truncated,
      };
    },
  };

  return [ordersQuery, orderGet, orderStats];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
