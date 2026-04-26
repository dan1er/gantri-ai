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
const Args = z.object({
  dateRange: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD PT'),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD PT'),
  }),
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
    async execute(args: Args) {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
      const endDate = args.excludeToday && args.dateRange.endDate >= today ? subDays(today, 1) : args.dateRange.endDate;

      // ---- Porter side: type=Order, PT-bucketed ----
      const porterSql = `
        SELECT
          DATE_TRUNC('day', t."createdAt" AT TIME ZONE 'America/Los_Angeles')::date AS day,
          COUNT(*)::int AS orders,
          SUM((t.amount->>'total')::numeric) / 100.0 AS revenue
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
