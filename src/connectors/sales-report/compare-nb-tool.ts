import { z } from 'zod';
import type { ToolDef } from '../base/connector.js';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import type { GrafanaConnector } from '../grafana/grafana-connector.js';
import type { NorthbeamApiClient } from '../northbeam-api/client.js';

/**
 * Deterministic "Northbeam vs Porter" daily comparison. Uses ONE canonical
 * formula on each side and PT-day bucketing so the numbers always match for
 * settled days (and only diverge for the current day due to NB ingestion lag).
 *
 * Why a tool instead of leaving it to the LLM: every time we let the model
 * compose this comparison it has drifted on filters (forgetting to narrow
 * Porter to type=Order, or summing the wrong column) or arithmetic (revenue
 * totals across days). This tool eliminates that drift.
 */
/** Accept any of the date-range shapes the live-reports runner may substitute:
 *  - `{ startDate, endDate }` (the connector's canonical form)
 *  - `{ start, end }` (the runner's substituted shape from custom range)
 *  - A preset string (e.g. `last_7_days`) — resolved via the same PT calendar
 *    helper the connector uses for the rest of the system. This lets specs
 *    pass `dateRange: '$REPORT_RANGE'` and have the picker drive the window. */
const PT_PRESETS = new Set([
  'yesterday', 'last_7_days', 'last_14_days', 'last_30_days', 'last_90_days',
  'last_180_days', 'last_365_days', 'this_month', 'last_month',
  'month_to_date', 'quarter_to_date', 'year_to_date',
]);
const DateRangeArg = z.union([
  z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD PT'),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD PT'),
  }),
  z.object({
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD PT'),
    end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD PT'),
  }),
  z.string().refine((s) => PT_PRESETS.has(s), { message: 'Unknown date-range preset' }),
]);
const Args = z.object({
  dateRange: DateRangeArg,
  excludeToday: z.boolean().default(false).describe('Drop the current PT day from the result (avoids the NB ingestion-lag noise on the in-progress day).'),
});
type Args = z.infer<typeof Args>;

export interface CompareNbToolDeps {
  grafana: GrafanaConnector;
  nb: NorthbeamApiClient;
}

export function buildCompareNbTool(deps: CompareNbToolDeps): ToolDef<Args> {
  return {
    name: 'gantri.compare_orders_nb_vs_porter',
    description: [
      'Side-by-side daily comparison of consumer orders (Porter `type=Order`, status NOT IN Unpaid/Cancelled) vs Northbeam (`/v2/orders`, NOT cancelled/deleted), PT-bucketed.',
      'Use this for ANY "compare NB vs Grafana/Porter" question — it eliminates the LLM-arithmetic drift the previous free-form CSV builds had.',
      'Returns one row per PT day with: date, porter_orders, porter_revenue (sum of amount.total), nb_orders, nb_revenue (sum of purchase_total), order_diff, revenue_diff. Plus grand totals.',
      'Settled days will all match exactly (or very nearly — sub-cent rounding). Only the current PT day is expected to show NB lag (NB count < Porter count) since orders take a few minutes to propagate via firePurchaseEvent.',
      'Result also has a top-level `csv` field — a pre-formatted CSV string with header, data rows, and a TOTAL row. To attach it as a file, pass `{"$ref": "comparison.csv"}` to `reports.attach_file` content. DO NOT rebuild the CSV yourself (it leads to arithmetic drift).',
    ].join(' '),
    schema: Args as z.ZodType<Args>,
    jsonSchema: zodToJsonSchema(Args),
    async execute(rawArgs: Args) {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
      // Collapse the union DateRangeArg (preset | {start,end} | {startDate,endDate})
      // into the canonical shape we use everywhere downstream. Done up front so
      // every reference below works against the same { startDate, endDate } object.
      const args: { dateRange: { startDate: string; endDate: string }; excludeToday: boolean } = {
        dateRange: normalizeDateRange(rawArgs.dateRange, today),
        excludeToday: rawArgs.excludeToday,
      };
      const endDate = args.excludeToday && args.dateRange.endDate >= today ? subDays(today, 1) : args.dateRange.endDate;

      // ---- Porter side: type=Order, PT-bucketed ----
      // Use `amount.total` as the source of truth when present — verified
      // empirically that modern `total` equals `subtotal + shipping + tax
      // − gift − credit − giftCardTotal` (Porter checkout writes the fully
      // net customer-paid amount into `total`). NB's purchase_total matches
      // `total` to the cent for every modern order, including those with
      // credits / gift-card redemptions.
      //
      // Schema history: `amount.total` was added to the Transactions JSON
      // in 2025; older rows only have { subtotal, shipping, tax,
      // transactionFee, gift?, credit?, giftCardTotal? }. The fallback
      // replicates the SAME formula modern `total` uses, so old-row rev
      // computations track NB just like new-row ones do. Without this,
      // SUM(NULL) silently zeroed Porter revenue for the entire pre-2025
      // window. transactionFee is Gantri's cut and is NOT part of
      // customer-paid revenue.
      const porterSql = `
        SELECT
          DATE_TRUNC('day', t."createdAt" AT TIME ZONE 'America/Los_Angeles')::date AS day,
          COUNT(*)::int AS orders,
          SUM(
            COALESCE(
              (t.amount->>'total')::numeric,
              COALESCE((t.amount->>'subtotal')::numeric, 0)
                + COALESCE((t.amount->>'shipping')::numeric, 0)
                + COALESCE((t.amount->>'tax')::numeric, 0)
                - COALESCE((t.amount->>'gift')::numeric, 0)
                - COALESCE((t.amount->>'credit')::numeric, 0)
                - COALESCE((t.amount->>'giftCardTotal')::numeric, 0)
            )
          ) / 100.0 AS revenue
        FROM "Transactions" t
        WHERE t."createdAt" >= ($__timeFrom())::timestamp
          AND t."createdAt" <  ($__timeTo())::timestamp
          AND t.type = 'Order'
          AND t.status NOT IN ('Unpaid','Cancelled')
        GROUP BY day
        ORDER BY day
      `;
      const fromMs = Date.parse(`${args.dateRange.startDate}T07:00:00.000Z`); // PT midnight roughly (DST imprecision absorbed by GROUP BY day in PT tz)
      const toMs = Date.parse(`${addDays(endDate, 1)}T08:00:00.000Z`);
      const grafResult = await deps.grafana.runSql({ sql: porterSql, fromMs, toMs, maxRows: 400 });
      const porterByDay = new Map<string, { orders: number; revenue: number }>();
      for (const row of grafResult.rows) {
        const dayRaw = row[grafResult.fields.indexOf('day')];
        const day = typeof dayRaw === 'string' ? dayRaw.slice(0, 10) : new Date(dayRaw as number).toISOString().slice(0, 10);
        porterByDay.set(day, {
          orders: Number(row[grafResult.fields.indexOf('orders')] ?? 0),
          revenue: Number(row[grafResult.fields.indexOf('revenue')] ?? 0),
        });
      }

      // ---- NB side: list_orders, PT-bucketed ----
      const nbOrders = await deps.nb.listOrders({ startDate: args.dateRange.startDate, endDate });
      const nbByDay = new Map<string, { orders: number; revenue: number }>();
      for (const o of nbOrders) {
        if (o.is_cancelled || o.is_deleted) continue;
        const t = o.time_of_purchase;
        if (typeof t !== 'string') continue;
        const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(Date.parse(t)));
        const entry = nbByDay.get(day) ?? { orders: 0, revenue: 0 };
        entry.orders += 1;
        entry.revenue += Number(o.purchase_total ?? 0);
        nbByDay.set(day, entry);
      }

      // ---- Merge per day ----
      const days: string[] = [];
      for (let d = args.dateRange.startDate; d <= endDate; d = addDays(d, 1)) days.push(d);
      const rows = days.map((day) => {
        const p = porterByDay.get(day) ?? { orders: 0, revenue: 0 };
        const n = nbByDay.get(day) ?? { orders: 0, revenue: 0 };
        return {
          date: day,
          porter_orders: p.orders,
          porter_revenue: round2(p.revenue),
          nb_orders: n.orders,
          nb_revenue: round2(n.revenue),
          order_diff: p.orders - n.orders,
          revenue_diff: round2(p.revenue - n.revenue),
        };
      });
      const totals = rows.reduce(
        (acc, r) => ({
          porter_orders: acc.porter_orders + r.porter_orders,
          porter_revenue: round2(acc.porter_revenue + r.porter_revenue),
          nb_orders: acc.nb_orders + r.nb_orders,
          nb_revenue: round2(acc.nb_revenue + r.nb_revenue),
          order_diff: acc.order_diff + r.order_diff,
          revenue_diff: round2(acc.revenue_diff + r.revenue_diff),
        }),
        { porter_orders: 0, porter_revenue: 0, nb_orders: 0, nb_revenue: 0, order_diff: 0, revenue_diff: 0 },
      );

      // Pre-formatted CSV string. Surfaced as a top-level `csv` field so
      // scheduled-report plans can use {"$ref": "comparison.csv"} as the
      // `content` arg to reports.attach_file without the LLM having to build
      // the CSV itself (which historically caused arithmetic drift).
      const header = 'date,porter_orders,porter_revenue,nb_orders,nb_revenue,order_diff,revenue_diff';
      const dataLines = rows.map((r) => `${r.date},${r.porter_orders},${r.porter_revenue.toFixed(2)},${r.nb_orders},${r.nb_revenue.toFixed(2)},${r.order_diff},${r.revenue_diff.toFixed(2)}`);
      const totalsLine = `TOTAL,${totals.porter_orders},${totals.porter_revenue.toFixed(2)},${totals.nb_orders},${totals.nb_revenue.toFixed(2)},${totals.order_diff},${totals.revenue_diff.toFixed(2)}`;
      const csv = [header, ...dataLines, totalsLine].join('\n');

      return {
        period: { startDate: args.dateRange.startDate, endDate },
        excludeToday: args.excludeToday,
        rows,
        totals,
        csv,
        notes: [
          'porter_revenue = SUM(amount.total) for type=Order, status NOT IN (Unpaid, Cancelled).',
          'nb_revenue = SUM(purchase_total) from /v2/orders, excluding is_cancelled/is_deleted.',
          'Both sides PT-day bucketed. Settled days should match exactly; current PT day may show NB ingestion lag.',
        ],
      };
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function subDays(ymd: string, n: number): string {
  return addDays(ymd, -n);
}

/** Translate a preset string (e.g. `last_7_days`) into a concrete
 *  `{ startDate, endDate }` range using the Pacific Time calendar. Returns
 *  null for unknown presets so the caller can fall through to validation. */
function presetToRange(preset: string, todayStr: string): { startDate: string; endDate: string } | null {
  const today = todayStr;
  switch (preset) {
    case 'yesterday': { const y = subDays(today, 1); return { startDate: y, endDate: y }; }
    case 'last_7_days': return { startDate: subDays(today, 6), endDate: today };
    case 'last_14_days': return { startDate: subDays(today, 13), endDate: today };
    case 'last_30_days': return { startDate: subDays(today, 29), endDate: today };
    case 'last_90_days': return { startDate: subDays(today, 89), endDate: today };
    case 'last_180_days': return { startDate: subDays(today, 179), endDate: today };
    case 'last_365_days': return { startDate: subDays(today, 364), endDate: today };
    case 'this_month':
    case 'month_to_date': {
      const [y, m] = today.split('-');
      return { startDate: `${y}-${m}-01`, endDate: today };
    }
    case 'last_month': {
      const [yStr, mStr] = today.split('-');
      const y = Number(yStr); const m = Number(mStr);
      const lmY = m === 1 ? y - 1 : y;
      const lmM = m === 1 ? 12 : m - 1;
      const startDate = `${lmY}-${String(lmM).padStart(2, '0')}-01`;
      // Last day of last month = day 0 of this month.
      const lastDay = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
      const endDate = `${lmY}-${String(lmM).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      return { startDate, endDate };
    }
    case 'quarter_to_date': {
      const [yStr, mStr] = today.split('-');
      const m = Number(mStr);
      const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
      return { startDate: `${yStr}-${String(qStartMonth).padStart(2, '0')}-01`, endDate: today };
    }
    case 'year_to_date': {
      const [y] = today.split('-');
      return { startDate: `${y}-01-01`, endDate: today };
    }
    default: return null;
  }
}

/** Normalize the union DateRangeArg shape into the canonical
 *  `{ startDate, endDate }` the rest of the connector uses. */
function normalizeDateRange(input: unknown, todayStr: string): { startDate: string; endDate: string } {
  if (typeof input === 'string') {
    const r = presetToRange(input, todayStr);
    if (!r) throw new Error(`Unknown date-range preset: ${input}`);
    return r;
  }
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (typeof obj.startDate === 'string' && typeof obj.endDate === 'string') {
      return { startDate: obj.startDate, endDate: obj.endDate };
    }
    if (typeof obj.start === 'string' && typeof obj.end === 'string') {
      return { startDate: obj.start, endDate: obj.end };
    }
  }
  throw new Error(`Invalid dateRange: ${JSON.stringify(input)}`);
}

/**
 * Per-order DIFF tool: which specific orders are in NB but not Porter, and
 * vice versa, joined by `order_id`. Use this when daily counts diverge and the
 * user wants to know exactly which orders cause the mismatch (and why).
 */
const DiffArgs = z.object({
  dateRange: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD PT'),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD PT'),
  }),
  maxExamples: z.number().int().min(1).max(200).default(50).describe('Max sample rows of each diff bucket to include in the response.'),
});
type DiffArgs = z.infer<typeof DiffArgs>;

export function buildDiffNbToolPair(): { tool: ToolDef<DiffArgs> } {
  return { tool: undefined as unknown as ToolDef<DiffArgs> };
}

export function buildDiffNbTool(deps: CompareNbToolDeps): ToolDef<DiffArgs> {
  return {
    name: 'gantri.diff_orders_nb_vs_porter',
    description: [
      'Per-order DIFF between Northbeam and Porter for a date range. Use when the user asks why two counts differ, or wants to see WHICH specific orders are missing/extra on either side.',
      'Pulls Porter orders (type=Order, status NOT IN Unpaid/Cancelled) and NB orders (/v2/orders, excluding is_cancelled/is_deleted), joins by `order_id`, and returns four buckets: only_in_nb, only_in_porter, status_mismatch (same id, Porter has it as Refunded/Lost while NB still treats it as active), revenue_mismatch (same id, totals differ by >$0.50).',
      'Each bucket entry includes order_id, both totals where available, both timestamps (NB time_of_purchase + Porter placedAt), Porter status, NB tags, and an automatically-classified `likelyCause` field: "tz_edge", "porter_refunded_after", "porter_cancelled_after", "nb_only_record", "porter_only_record", "rounding", or "unknown".',
      'Returns aggregate counts + a sampling of up to `maxExamples` rows per bucket (full lists can be huge). Always quote the period back. If totals match exactly, all buckets will be empty and the tool returns an explicit "perfect match" flag.',
    ].join(' '),
    schema: DiffArgs as z.ZodType<DiffArgs>,
    jsonSchema: zodToJsonSchema(DiffArgs),
    async execute(args: DiffArgs) {
      const { startDate, endDate } = args.dateRange;
      // ---- Porter: full per-order rows (id, status, placedAt PT, total, type) ----
      const porterSql = `
        SELECT
          t.id::text                                           AS order_id,
          t.status                                             AS status,
          t.type                                               AS type,
          to_char(t."createdAt"   AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS') AS created_pt,
          to_char(t."placedAt"    AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS') AS placed_pt,
          to_char(t."completedAt" AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS') AS completed_pt,
          ROUND((t.amount->>'total')::numeric / 100.0, 2)      AS total
        FROM "Transactions" t
        WHERE t."createdAt" >= ($__timeFrom())::timestamp
          AND t."createdAt" <  ($__timeTo())::timestamp
          AND t.type = 'Order'
          AND t.status NOT IN ('Unpaid','Cancelled')
        ORDER BY t."createdAt"
      `;
      const fromMs = Date.parse(`${startDate}T07:00:00.000Z`);
      const toMs = Date.parse(`${addDays(endDate, 1)}T08:00:00.000Z`);
      const porterRes = await deps.grafana.runSql({ sql: porterSql, fromMs, toMs, maxRows: 50000 });
      const idx = (k: string) => porterRes.fields.indexOf(k);
      const porterById = new Map<string, { orderId: string; total: number; placedPt: string | null; completedPt: string | null; status: string }>();
      for (const r of porterRes.rows) {
        const id = String(r[idx('order_id')] ?? '');
        if (!id) continue;
        porterById.set(id, {
          orderId: id,
          total: Number(r[idx('total')] ?? 0),
          placedPt: (r[idx('placed_pt')] as string | null) ?? (r[idx('created_pt')] as string | null) ?? null,
          completedPt: (r[idx('completed_pt')] as string | null) ?? null,
          status: String(r[idx('status')] ?? ''),
        });
      }

      // ---- NB: per-order rows, filter cancelled/deleted ----
      const nbAll = await deps.nb.listOrders({ startDate, endDate });
      const nbById = new Map<string, { orderId: string; total: number; timeOfPurchase: string | null; tags: string[]; isCancelled: boolean; isDeleted: boolean; customerEmail: string | null }>();
      for (const o of nbAll) {
        const id = String(o.order_id ?? '');
        if (!id) continue;
        nbById.set(id, {
          orderId: id,
          total: Number(o.purchase_total ?? 0),
          timeOfPurchase: typeof o.time_of_purchase === 'string' ? (o.time_of_purchase as string) : null,
          tags: Array.isArray(o.order_tags) ? (o.order_tags as string[]) : [],
          isCancelled: Boolean(o.is_cancelled),
          isDeleted: Boolean(o.is_deleted),
          customerEmail: typeof o.customer_email === 'string' ? (o.customer_email as string) : null,
        });
      }
      // Active NB only for the headline counts
      const nbActiveCount = [...nbById.values()].filter((o) => !o.isCancelled && !o.isDeleted).length;

      // ---- Bucketize ----
      type DiffEntry = {
        order_id: string;
        nb_total?: number;
        porter_total?: number;
        nb_time?: string | null;
        porter_placed?: string | null;
        porter_completed?: string | null;
        porter_status?: string;
        nb_tags?: string[];
        nb_is_cancelled?: boolean;
        nb_is_deleted?: boolean;
        diff?: number;
        likelyCause: string;
      };
      const onlyInNb: DiffEntry[] = [];
      const onlyInPorter: DiffEntry[] = [];
      const revenueMismatch: DiffEntry[] = [];
      const statusMismatch: DiffEntry[] = [];

      for (const [id, nb] of nbById) {
        if (nb.isCancelled || nb.isDeleted) continue; // active-only diff
        const p = porterById.get(id);
        if (!p) {
          onlyInNb.push({
            order_id: id,
            nb_total: round2(nb.total),
            nb_time: nb.timeOfPurchase,
            nb_tags: nb.tags,
            likelyCause: classifyOnlyInNb(nb.timeOfPurchase, startDate, endDate),
          });
          continue;
        }
        if (Math.abs(p.total - nb.total) > 0.5) {
          revenueMismatch.push({
            order_id: id,
            nb_total: round2(nb.total),
            porter_total: round2(p.total),
            diff: round2(nb.total - p.total),
            nb_time: nb.timeOfPurchase,
            porter_placed: p.placedPt,
            porter_status: p.status,
            likelyCause: classifyRevenueMismatch(nb.total, p.total, p.status),
          });
        }
        if (p.status === 'Refunded' || p.status === 'Lost') {
          statusMismatch.push({
            order_id: id,
            nb_total: round2(nb.total),
            porter_total: round2(p.total),
            porter_status: p.status,
            porter_completed: p.completedPt,
            nb_time: nb.timeOfPurchase,
            likelyCause: p.status === 'Refunded' ? 'porter_refunded_after' : 'porter_lost_after',
          });
        }
      }
      for (const [id, p] of porterById) {
        const nb = nbById.get(id);
        if (!nb || nb.isCancelled || nb.isDeleted) {
          onlyInPorter.push({
            order_id: id,
            porter_total: round2(p.total),
            porter_placed: p.placedPt,
            porter_status: p.status,
            likelyCause: classifyOnlyInPorter(nb, p.placedPt, startDate, endDate),
          });
        }
      }

      const summary = {
        period: args.dateRange,
        porter_count: porterById.size,
        nb_count: nbActiveCount,
        only_in_nb_count: onlyInNb.length,
        only_in_porter_count: onlyInPorter.length,
        revenue_mismatch_count: revenueMismatch.length,
        status_mismatch_count: statusMismatch.length,
        perfect_match: onlyInNb.length === 0 && onlyInPorter.length === 0 && revenueMismatch.length === 0 && statusMismatch.length === 0,
      };

      const cap = args.maxExamples;
      return {
        ...summary,
        only_in_nb: onlyInNb.slice(0, cap),
        only_in_porter: onlyInPorter.slice(0, cap),
        revenue_mismatch: revenueMismatch.slice(0, cap),
        status_mismatch: statusMismatch.slice(0, cap),
        notes: [
          'porter_count = transactions where type=Order AND status NOT IN (Unpaid, Cancelled), bucketed by createdAt PT.',
          'nb_count = /v2/orders excluding is_cancelled / is_deleted, bucketed by time_of_purchase PT.',
          'Bucket meanings: only_in_nb = NB has it, Porter does not (likely a TZ-edge order placed just outside the window or an NB-only test). only_in_porter = Porter has it, NB does not (likely firePurchaseEvent failed for that order). revenue_mismatch = same order_id, totals differ by >$0.50. status_mismatch = same order_id but Porter shows Refunded/Lost — NB does not auto-flag those.',
          'likelyCause classifications are heuristic. "tz_edge" means the order falls within ~8h of a window boundary; check the timestamp and confirm.',
        ],
      };
    },
  };
}

function classifyOnlyInNb(nbTime: string | null, startDate: string, endDate: string): string {
  if (!nbTime) return 'unknown';
  const ptDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(Date.parse(nbTime)));
  if (ptDay < startDate || ptDay > endDate) return 'tz_edge';
  return 'nb_only_record';
}

function classifyOnlyInPorter(_nb: unknown, _placedPt: string | null, _startDate: string, _endDate: string): string {
  return 'porter_only_record';
}

function classifyRevenueMismatch(nbTotal: number, porterTotal: number, porterStatus: string): string {
  if (porterStatus === 'Refunded' || porterStatus === 'Partially refunded') return 'porter_partial_refund_after';
  if (Math.abs(nbTotal - porterTotal) < 5.0) return 'rounding';
  return 'unknown';
}
