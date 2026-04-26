import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import type { GrafanaConnector } from '../grafana/grafana-connector.js';

/**
 * Wraps Grafana's Sales-dashboard "Full Total" panel SQL as a single tool. The
 * SQL is copied verbatim from the panel definition the Gantri team maintains,
 * so the numbers returned here match the dashboard byte-for-byte. Use this for
 * any question about revenue, subtotal, shipping, tax, discount, credit, AOV,
 * ASP, or order count broken out by transaction type.
 *
 * Why not the rollup? The pre-aggregated `sales_daily_rollup` table existed to
 * make these queries fast, but it diverged subtly from the Grafana panel
 * (Transaction-level vs StockAssociation-level discounts, in particular). The
 * team trusts Grafana, so we go through Grafana directly. Each call costs a
 * round-trip + ~1-3s of SQL execution; cache the result via the existing
 * CachingRegistry if needed.
 */
export interface SalesReportConnectorDeps {
  grafana: GrafanaConnector;
}

const Args = z.object({
  dateRange: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  }),
});
type Args = z.infer<typeof Args>;

const PT_TZ = 'America/Los_Angeles';

export class SalesReportConnector implements Connector {
  readonly name = 'sales-report';
  readonly tools: readonly ToolDef[];

  constructor(private readonly deps: SalesReportConnectorDeps) {
    this.tools = this.buildTools();
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true };
  }

  private buildTools(): ToolDef[] {
    const tool: ToolDef<Args> = {
      name: 'gantri.sales_report',
      description: [
        'Pull the per-type sales breakdown directly from the Grafana Sales dashboard SQL — the same numbers the team sees on Grafana. Use this for ANY revenue / subtotal / shipping / tax / discount / credit / AOV / ASP / order-count question, broken out by transaction type (Order, Wholesale, Trade, Third Party, Made, Refund, Wholesale Refund, Trade Refund, Third Party Refund, Replacement, Marketing, R&D, Designer).',
        'Time bucketing matches Grafana exactly:',
        '  - Non-refund types: filter by createdAt in the range, status NOT IN (Unpaid, Cancelled).',
        '  - Refund types: filter by completedAt in the range, status IN (Refunded, Delivered); revenue is signed negative so type-totals net out refunds.',
        'Revenue formula: subtotal + shipping + tax - discount, all summed at the StockAssociation + GiftCards line-item level (NOT the Transactions.amount level).',
        'Returns one row per type with these EXACT field names (use them as-is when building canvas tables — `row[column.key]` lookup is case-sensitive):',
        '  - `type` (string) — transaction type',
        '  - `orders` (int)  — count of transactions',
        '  - `items` (int)   — count of stock-association line items',
        '  - `giftCards` (int) — count of gift cards',
        '  - `subtotal` (number, dollars) — SA-level subtotal sum (signed negative for refund types)',
        '  - `shipping` (number, dollars) — SA-level shipping sum',
        '  - `tax` (number, dollars) — SA-level tax sum',
        '  - `discount` (number, dollars, signed negative) — Grafana-displayed value: -1 * (SUM(disc) - SUM(credit))',
        '  - `credit` (number, dollars, signed negative) — Grafana-displayed value: -1 * SUM(credit)',
        '  - `salesExclTax` (number, dollars) — sales excluding tax',
        '  - `fullTotal` (number, dollars) — the headline revenue number (signed negative for refund types)',
        'Always quote the period back to the user.',
      ].join('\n'),
      schema: Args as z.ZodType<Args>,
      jsonSchema: zodToJsonSchema(Args),
      execute: (args) => this.run(args),
    };
    return [tool];
  }

  private async run(args: Args) {
    const fromMs = wallClockToUtc(`${args.dateRange.startDate}T00:00:00.000`, PT_TZ);
    const toMs = wallClockToUtc(`${addDays(args.dateRange.endDate, 1)}T00:00:00.000`, PT_TZ);
    const result = await this.deps.grafana.runSql({ sql: SALES_REPORT_SQL, fromMs, toMs, maxRows: 50 });
    const idx = (name: string) => result.fields.indexOf(name);
    // Field names match what the LLM naturally references when building canvas
    // tables. Shorter is better — the canvas builder looks up `row[column.key]`
    // so e.g. `key:'shipping'` must find the value, not `key:'shippingDollars'`.
    const rows = result.rows.map((r) => ({
      type: r[idx('type')] as string,
      orders: Number(r[idx('orders')] ?? 0),
      items: Number(r[idx('items')] ?? 0),
      giftCards: Number(r[idx('gift_cards')] ?? 0),
      subtotal: roundCents(r[idx('subtotal')]),
      shipping: roundCents(r[idx('shipping')]),
      tax: roundCents(r[idx('tax')]),
      discount: roundCents(r[idx('discount')]),
      credit: roundCents(r[idx('credit')]),
      salesExclTax: roundCents(r[idx('sales_exl_tax')]),
      fullTotal: roundCents(r[idx('full_total')]),
    }));
    return {
      period: args.dateRange,
      source: 'grafana_sales_panel' as const,
      rows,
    };
  }
}

function roundCents(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'string' ? Number(v) : (v as number);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function wallClockToUtc(wall: string, tz: string): number {
  let utc = Date.parse(`${wall}Z`);
  for (let i = 0; i < 2; i++) {
    const formatted = formatInTz(new Date(utc), tz);
    const drift = Date.parse(`${formatted}Z`) - Date.parse(`${wall}Z`);
    utc -= drift;
  }
  return utc;
}

function formatInTz(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    fractionalSecondDigits: 3,
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}.${get('fractionalSecond') || '000'}`;
}

// Per-type sales breakdown — copy of the Grafana Sales-dashboard panel SQL.
// Source-of-truth formula:
//   - non-refund: filter by createdAt, status NOT IN ('Unpaid','Cancelled'),
//                 type NOT IN refund types
//   - refund:     filter by completedAt, status IN ('Refunded','Delivered'),
//                 type IN refund types; revenue components negated
//   - revenue components come from StockAssociations + GiftCards (line-level),
//     NOT from Transactions.amount (which can drift)
//   - displayed discount column = -1 * (SUM(disc) - SUM(credit))
//     displayed credit column   = -1 * SUM(credit)
//     full_total                = SUM(sub) + SUM(ship) + SUM(tax) - SUM(disc)
//     sales_exl_tax             = SUM(sub) + SUM(ship) - (SUM(disc) - SUM(credit))
const SALES_REPORT_SQL = `
WITH per_txn_non_refund AS (
  SELECT
    t.id, t.type, t.status,
    SUM(COALESCE((sa.amount->>'subtotal')::decimal, 0)) + COALESCE(SUM(gc.amount)::decimal, 0) AS subtotal,
    SUM(COALESCE((sa.amount->>'tax')::decimal, 0)) AS tax,
    SUM(COALESCE((sa.amount->>'shipping')::decimal, 0)) AS shipping,
    SUM(COALESCE((sa.amount->>'discount')::decimal, 0)) AS discount,
    COALESCE((t.amount->>'credit')::decimal, 0) AS credit,
    COUNT(DISTINCT sa.id) AS items,
    COUNT(DISTINCT gc.id) AS gift_cards
  FROM "Transactions" t
  LEFT JOIN "StockAssociations" sa ON sa."orderId" = t.id
  LEFT JOIN "GiftCards" gc ON gc."orderId" = t.id
  WHERE t."createdAt" >= ($__timeFrom())::timestamp
    AND t."createdAt" <  ($__timeTo())::timestamp
    AND t.status NOT IN ('Unpaid','Cancelled')
    AND t.type NOT IN ('Refund','Third Party Refund','Made Refund','Trade Refund','Wholesale Refund')
  GROUP BY t.id, t.type, t.status, (t.amount->>'credit')
),
per_type_non_refund AS (
  SELECT type,
    SUM(subtotal)  AS subtotal,
    SUM(tax)       AS tax,
    SUM(shipping)  AS shipping,
    SUM(discount)  AS discount_raw,
    SUM(credit)    AS credit_raw,
    COUNT(*)       AS orders,
    SUM(items)     AS items,
    SUM(gift_cards) AS gift_cards
  FROM per_txn_non_refund
  GROUP BY type
),
per_txn_refund AS (
  SELECT
    t.id, t.type, t.status,
    SUM(COALESCE((sa.amount->>'subtotal')::decimal, 0)) + COALESCE(SUM(gc.amount)::decimal, 0) AS subtotal,
    SUM(COALESCE((sa.amount->>'tax')::decimal, 0)) AS tax,
    SUM(COALESCE((sa.amount->>'shipping')::decimal, 0)) AS shipping,
    SUM(COALESCE((sa.amount->>'discount')::decimal, 0)) AS discount,
    COALESCE((t.amount->>'credit')::decimal, 0) AS credit,
    COUNT(DISTINCT sa.id) AS items,
    COUNT(DISTINCT gc.id) AS gift_cards
  FROM "Transactions" t
  LEFT JOIN "StockAssociations" sa ON sa."orderId" = t.id
  LEFT JOIN "GiftCards" gc ON gc."orderId" = t.id
  WHERE t."completedAt" >= ($__timeFrom())::timestamp
    AND t."completedAt" <  ($__timeTo())::timestamp
    AND t.status IN ('Refunded','Delivered')
    AND t.type IN ('Refund','Third Party Refund','Made Refund','Trade Refund','Wholesale Refund')
  GROUP BY t.id, t.type, t.status, (t.amount->>'credit')
),
per_type_refund AS (
  SELECT type,
    -SUM(subtotal) AS subtotal,
    -SUM(tax)      AS tax,
    -SUM(shipping) AS shipping,
    -SUM(discount) AS discount_raw,
    -SUM(credit)   AS credit_raw,
    COUNT(*)       AS orders,
    SUM(items)     AS items,
    SUM(gift_cards) AS gift_cards
  FROM per_txn_refund
  GROUP BY type
),
unioned AS (
  SELECT * FROM per_type_non_refund
  UNION ALL
  SELECT * FROM per_type_refund
)
SELECT
  type,
  SUM(orders)::int      AS orders,
  SUM(items)::int       AS items,
  SUM(gift_cards)::int  AS gift_cards,
  SUM(subtotal) / 100.0 AS subtotal,
  SUM(shipping) / 100.0 AS shipping,
  SUM(tax)      / 100.0 AS tax,
  -1 * (SUM(discount_raw) - SUM(credit_raw)) / 100.0 AS discount,
  -1 *  SUM(credit_raw) / 100.0 AS credit,
  (SUM(subtotal) + SUM(shipping) - (SUM(discount_raw) - SUM(credit_raw))) / 100.0 AS sales_exl_tax,
  (SUM(subtotal) + SUM(shipping) + SUM(tax) - SUM(discount_raw)) / 100.0 AS full_total
FROM unioned
GROUP BY type
ORDER BY full_total DESC NULLS LAST
`;
