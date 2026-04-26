import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import { logger } from '../../logger.js';
import type { RollupRepo, RollupRow } from '../../storage/rollup-repo.js';

export interface PorterApiConfig {
  baseUrl: string;
  email: string;
  password: string;
  /**
   * Optional. When provided, `gantri.order_stats` falls back to the daily
   * rollup table for date ranges that would otherwise overflow Porter's
   * paginate-and-aggregate cap (~2000 rows). Without it, large ranges silently
   * return a sample-of-2000 breakdown — see the comments in `orderStats` below.
   */
  rollupRepo?: RollupRepo;
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
  readonly rollupRepo: RollupRepo | undefined;

  private token: string | null = null;
  private tokenFetchedAt = 0;
  private inflight: Promise<string> | null = null;

  constructor(private readonly cfg: PorterApiConfig) {
    this.rollupRepo = cfg.rollupRepo;
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

/** Convert a YYYY-MM-DD date (Pacific Time) to MM/DD/YYYY — the format Porter's
 *  controllers expect for startDate/endDate body params. They internally convert
 *  to PT unix-ms via moment + convertToPacificTZ. */
function toPorterDate(ymd: string): string {
  const [y, m, d] = ymd.split('-');
  return `${m}/${d}/${y}`;
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
  types: z.array(z.enum(TRANSACTION_TYPES)).optional()
    .describe('Transaction types to include. Omit to include all types (useful for wholesale-customer aggregates that span Wholesale + Third Party + refunds).'),
  search: z.string().min(1).max(200).optional()
    .describe('Free-text search (customer name, email, order id). Applies to the same field as gantri.orders_query.'),
});
type OrderStatsArgs = z.infer<typeof OrderStatsArgs>;

// ============================================================================

function buildPorterTools(conn: GantriPorterConnector): ToolDef[] {
  /** Normalize an order row: extract dollar amounts, unwrap nested fields.
   *  Handles both response shapes — the paginated list nests user info under
   *  `user.{id,email,firstName,lastName}` and drops `customerName`, while the
   *  detail endpoint has a top-level `customerName`/`userId` plus a richer
   *  `user` object. We surface `email` either way so the caller can filter
   *  by exact email (Porter's `search` param is a substring match, not an
   *  email filter, so the email field is the only way to disambiguate). */
  function normalizeOrder(o: any) {
    const amt = o.amount ?? {};
    const user = o.user ?? {};
    const email = user.email ?? o.email ?? null;
    const customerName =
      o.customerName ??
      ([user.firstName, user.lastName].filter(Boolean).join(' ') || null);
    const userId = o.userId ?? user.id ?? null;
    const totalCents = computeTotalCents(amt);
    return {
      id: o.id,
      type: o.type,
      status: o.status,
      customerName,
      email,
      userId,
      organizationId: o.organizationId,
      shopifyOrderId: o.shopifyOrderId ?? null,
      productIds: o.productIds ?? [],
      createdAt: o.createdAt,
      shipsAt: o.shipsAt ?? null,
      completedAt: o.completedAt ?? null,
      shipmentStatus: o.shipmentStatus ?? null,
      shippingTrackingNumber: o.shippingTrackingNumber ?? null,
      shippingProvider: o.shippingProvider ?? null,
      totalDollars: totalCents === null ? null : round2(totalCents / 100),
      subtotalDollars: typeof amt.subtotal === 'number' ? round2(amt.subtotal / 100) : null,
      shippingDollars: typeof amt.shipping === 'number' ? round2(amt.shipping / 100) : null,
      taxDollars: typeof amt.tax === 'number' ? round2(amt.tax / 100) : null,
      transactionFeeDollars: typeof amt.transactionFee === 'number' ? round2(amt.transactionFee / 100) : null,
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
        body.startDate = toPorterDate(args.dateRange.startDate);
        body.endDate = toPorterDate(args.dateRange.endDate);
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
      const o = data.order;
      // Slim the response: the raw payload includes every job's full metadata
      // (machine state, gcode, instructions, etc.) which can balloon to 100k+
      // tokens for a multi-part order. Surface only the fields useful for
      // human-facing analysis (status, lateness, blockers, notes).
      // A single order can carry thousands of jobs (1 stock = many parts × many
      // QC/print/sand attempts). Returning them all blows the model context
      // (we've seen 1.6k jobs / 2.3M tokens). Strategy:
      //  - Aggregate stats per stock (counts by status, lateness, attention)
      //  - Surface only "interesting" jobs flagged by the workflow
      //    (attention / rework / late / exceeding cycle time / has comment)
      //  - Cap the interesting set at 30 per order, sorted most-recent-first
      const isInteresting = (j: any) =>
        j.hasAttention || j.isRework || j.isLateOrder ||
        (j.reasonsForExceeding && Object.keys(j.reasonsForExceeding).length > 0) ||
        (typeof j.exceededCycleTime === 'number' && j.exceededCycleTime > 0) ||
        (j.comment && String(j.comment).trim().length > 0) ||
        (j.cause && String(j.cause).trim().length > 0) ||
        (j.failedReason && Object.keys(j.failedReason).length > 0 && j.status !== 'Completed');
      const slimJob = (j: any, stockId: number) => ({
        stockId,
        id: j.id,
        description: j.description ?? null,
        status: j.status ?? null,
        attempt: j.attempt ?? null,
        isRework: j.isRework ?? false,
        isLateOrder: j.isLateOrder ?? false,
        hasAttention: j.hasAttention ?? false,
        highPriority: j.highPriority ?? false,
        machineName: j.machineName ?? null,
        machineType: j.machineType ?? null,
        assignedTo: j.assignedTo ?? null,
        startDate: j.startDate ?? null,
        endDate: j.endDate ?? null,
        completedAt: j.failedReason?.completedAt ?? j.completedAt ?? null,
        notes: j.notes ?? null,
        comment: j.comment ?? null,
        cause: j.cause ?? null,
        reasonsForExceeding: j.reasonsForExceeding && Object.keys(j.reasonsForExceeding).length ? j.reasonsForExceeding : null,
        exceededCycleTime: j.exceededCycleTime ?? null,
      });
      const allInteresting: any[] = [];
      let totalJobs = 0, interestingTotal = 0;
      const stocksSummary = Array.isArray(o.stocks)
        ? o.stocks.map((s: any) => {
            const jobs = Array.isArray(s.jobs) ? s.jobs : [];
            totalJobs += jobs.length;
            const byStatus: Record<string, number> = {};
            let attention = 0, rework = 0, late = 0, exceeded = 0;
            for (const j of jobs) {
              const st = j.status ?? 'Unknown';
              byStatus[st] = (byStatus[st] ?? 0) + 1;
              if (j.hasAttention) attention++;
              if (j.isRework) rework++;
              if (j.isLateOrder) late++;
              if (typeof j.exceededCycleTime === 'number' && j.exceededCycleTime > 0) exceeded++;
              if (isInteresting(j)) {
                interestingTotal++;
                allInteresting.push(slimJob(j, s.id));
              }
            }
            return {
              id: s.id,
              sku: s.sku ?? null,
              color: s.color ?? null,
              size: s.size ?? null,
              productId: s.productId ?? null,
              status: s.status ?? null,
              isLateOrder: s.isLateOrder ?? null,
              completedJobPercent: s.completedJobPercent ?? null,
              jobCount: jobs.length,
              jobsByStatus: byStatus,
              attentionCount: attention,
              reworkCount: rework,
              lateJobCount: late,
              exceededCount: exceeded,
            };
          })
        : [];
      // Sort interesting jobs by endDate (most recent first), cap at 30.
      allInteresting.sort((a, b) => String(b.endDate ?? '').localeCompare(String(a.endDate ?? '')));
      const interestingJobs = allInteresting.slice(0, 30);
      const shipmentsSummary = Array.isArray(o.shipments)
        ? o.shipments.map((sh: any) => ({
            id: sh.id,
            status: sh.status ?? null,
            shipsAt: sh.shipsAt ?? null,
            shippingTrackingNumber: sh.shippingTrackingNumber ?? null,
            shippingProvider: sh.shippingProvider ?? null,
            stocks: Array.isArray(sh.stocks)
              ? sh.stocks.map((st: any) => ({ sku: st.sku, stockName: st.stockName }))
              : [],
          }))
        : [];
      return {
        order: {
          ...normalizeOrder(o),
          additionalEmails: o.additionalEmails ?? null,
          billingAddress: o.billingAddress ?? null,
          payment: o.payment
            ? { type: o.payment.type ?? null, number: o.payment.number ?? null, nameOnCard: o.payment.nameOnCard ?? null }
            : null,
          stocks: stocksSummary,
          shipments: shipmentsSummary,
          jobsTotal: totalJobs,
          jobsInterestingTotal: interestingTotal,
          interestingJobs,
        },
      };
    },
  };

  const orderStats: ToolDef<OrderStatsArgs> = {
    name: 'gantri.order_stats',
    description:
      'Aggregate order stats for a date range (Pacific Time): total count, total revenue in dollars, average order value, and breakdown by status and type. For ranges that fit under ~2000 transactions, paginates Porter directly. For larger ranges (e.g. multi-month / multi-year queries) without a `search` filter, automatically uses the pre-aggregated daily rollup so totals match Grafana exactly. Per-customer or text-search queries always go through Porter.',
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
        search: { type: 'string', description: 'Free-text search (customer name, email, order id).' },
      },
    },
    async execute(args) {
      const startDateStr = toPorterDate(args.dateRange.startDate);
      const endDateStr = toPorterDate(args.dateRange.endDate);

      // Probe page 1 once to learn the true total. If it fits under the
      // pagination cap we paginate Porter for full per-row breakdowns. If not,
      // fall back to the daily rollup (which has correct totals + per-type and
      // per-status breakdowns pre-aggregated, matching Grafana).
      const pageSize = 200;
      const maxPages = 10; // 2000 rows cap before rollup fallback

      const firstPage = await conn.fetchJson<{
        orders: any[];
        allOrders: number;
        maxPages: number;
      }>('/api/admin/paginated-transactions', {
        method: 'POST',
        body: JSON.stringify({
          page: 1,
          count: pageSize,
          ...(args.types?.length ? { types: args.types } : {}),
          ...(args.search ? { search: args.search } : {}),
          startDate: startDateStr,
          endDate: endDateStr,
        }),
      });
      const totalCount = firstPage.allOrders;
      const exceedsCap = totalCount > pageSize * maxPages;

      // Rollup fallback: only when there's no `search` (rollup has no
      // customer/email/text index) and the row count exceeds the pagination
      // cap. The rollup excludes Cancelled/Lost orders by construction; we mark
      // that explicitly in the response.
      if (exceedsCap && !args.search && conn.rollupRepo) {
        const rollupRows = await conn.rollupRepo.getRange(startDateStr, endDateStr);
        return aggregateFromRollup(rollupRows, args, totalCount);
      }

      // Pagination path — works for ranges under the cap, or whenever a search
      // filter is applied.
      const statusCounts: Record<string, { count: number; revenueDollars: number }> = {};
      const typeCounts: Record<string, { count: number; revenueDollars: number }> = {};
      let totalRevenueCents = 0;
      let truncated = false;

      const consume = (orders: any[]) => {
        for (const o of orders) {
          const total = computeTotalCents(o.amount ?? {}) ?? 0;
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
      };
      consume(firstPage.orders);
      let lastPageSize = firstPage.orders.length;

      for (let page = 2; page <= maxPages && lastPageSize === pageSize; page++) {
        const data = await conn.fetchJson<{ orders: any[]; allOrders: number; maxPages: number }>(
          '/api/admin/paginated-transactions',
          {
            method: 'POST',
            body: JSON.stringify({
              page,
              count: pageSize,
              ...(args.types?.length ? { types: args.types } : {}),
              ...(args.search ? { search: args.search } : {}),
              startDate: startDateStr,
              endDate: endDateStr,
            }),
          },
        );
        consume(data.orders);
        lastPageSize = data.orders.length;
        if (page === maxPages && data.maxPages > maxPages) truncated = true;
      }

      // If we still fell short of `totalCount` (search filter present, no rollup
      // available, or other reason), flag the truncation so the LLM doesn't
      // surface a sample as if it were the full breakdown.
      const breakdownCount = Object.values(typeCounts).reduce((s, v) => s + v.count, 0);
      const breakdownIncomplete = breakdownCount < totalCount;

      const totalRevenueDollars = round2(totalRevenueCents / 100);
      return {
        period: args.dateRange,
        typesFilter: args.types,
        source: 'porter' as const,
        totalOrders: totalCount,
        totalRevenueDollars: breakdownIncomplete ? null : totalRevenueDollars,
        avgOrderValueDollars: breakdownIncomplete || totalCount === 0
          ? null
          : round2(totalRevenueDollars / totalCount),
        statusBreakdown: Object.entries(statusCounts)
          .map(([status, v]) => ({ status, ...v, revenueDollars: round2(v.revenueDollars) }))
          .sort((a, b) => b.count - a.count),
        typeBreakdown: Object.entries(typeCounts)
          .map(([type, v]) => ({ type, ...v, revenueDollars: round2(v.revenueDollars) }))
          .sort((a, b) => b.count - a.count),
        truncated: truncated || breakdownIncomplete,
        breakdownIncomplete,
        ...(breakdownIncomplete
          ? {
              warning: `Porter pagination cap reached (${pageSize * maxPages} rows fetched of ${totalCount} matching). The breakdowns above reflect a SAMPLE, not the full range. Re-run without 'search' to use the rollup, or narrow the date range.`,
            }
          : {}),
      };
    },
  };

  return [ordersQuery, orderGet, orderStats];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Aggregate the daily rollup into the same shape `gantri.order_stats` returns
 * from Porter pagination. Used as the fallback for date ranges that overflow
 * the pagination cap. Note the rollup excludes Cancelled/Lost orders by
 * construction — the response is marked accordingly so the LLM can surface
 * that to the user.
 */
export function aggregateFromRollup(
  rows: RollupRow[],
  args: { dateRange: { startDate: string; endDate: string }; types?: string[] },
  porterTotalCount: number,
): unknown {
  const typesFilter = args.types && args.types.length > 0 ? new Set(args.types) : null;
  const typeAgg: Record<string, { count: number; revenueCents: number }> = {};
  const statusAgg: Record<string, { count: number; revenueCents: number }> = {};
  let totalCount = 0;
  let totalRevenueCents = 0;

  for (const row of rows) {
    for (const [type, v] of Object.entries(row.by_type ?? {})) {
      if (typesFilter && !typesFilter.has(type)) continue;
      typeAgg[type] ??= { count: 0, revenueCents: 0 };
      typeAgg[type].count += v.orders;
      typeAgg[type].revenueCents += v.revenueCents;
      totalCount += v.orders;
      totalRevenueCents += v.revenueCents;
    }
    for (const [status, v] of Object.entries(row.by_status ?? {})) {
      // by_status doesn't carry per-type info, so we can't filter it by `types`
      // perfectly. When a type filter is set we omit the status breakdown to
      // avoid surfacing numbers that don't match the type-filtered totals.
      if (typesFilter) continue;
      statusAgg[status] ??= { count: 0, revenueCents: 0 };
      statusAgg[status].count += v.orders;
      statusAgg[status].revenueCents += v.revenueCents;
    }
  }

  const totalRevenueDollars = round2(totalRevenueCents / 100);
  return {
    period: args.dateRange,
    typesFilter: args.types,
    source: 'rollup' as const,
    note: 'Rollup excludes Cancelled and Lost orders by construction; numbers match Grafana Sales (which uses the same definition). Refund-type rows are negative (net of refunds).',
    porterTotalCount,
    totalOrders: totalCount,
    totalRevenueDollars,
    avgOrderValueDollars: totalCount > 0 ? round2(totalRevenueDollars / totalCount) : 0,
    statusBreakdown: typesFilter
      ? null
      : Object.entries(statusAgg)
          .map(([status, v]) => ({ status, count: v.count, revenueDollars: round2(v.revenueCents / 100) }))
          .sort((a, b) => b.count - a.count),
    typeBreakdown: Object.entries(typeAgg)
      .map(([type, v]) => ({ type, count: v.count, revenueDollars: round2(v.revenueCents / 100) }))
      .sort((a, b) => b.count - a.count),
    truncated: false,
  };
}

/**
 * Compute the order total in cents from the Porter `amount` JSON.
 *
 * Retail `Order` transactions store a precomputed `total` (already net of
 * discounts, including tax + shipping). Wholesale, Trade, and some other
 * non-Stripe transaction types skip `total` entirely — they just carry the
 * component pieces. Falling through to 0 in those cases makes wholesale
 * revenue collapse to $0 in any aggregate.
 *
 * Resolution order:
 *  1. `amount.total` if present → already the right number.
 *  2. Sum of `subtotal + shipping + tax` (the canonical billed components).
 *  3. null when nothing is parseable.
 */
function computeTotalCents(amt: Record<string, unknown>): number | null {
  if (typeof amt.total === 'number') return amt.total;
  const sub = typeof amt.subtotal === 'number' ? amt.subtotal : null;
  const ship = typeof amt.shipping === 'number' ? amt.shipping : 0;
  const tax = typeof amt.tax === 'number' ? amt.tax : 0;
  if (sub === null) return null;
  return sub + ship + tax;
}
