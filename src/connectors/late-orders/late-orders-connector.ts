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
        'One-shot report of currently-late, in-flight orders (Porter\'s `Transactions.isLateOrder = true`, excluding shipped/delivered/cancelled/lost/refunded statuses, capped at last 365 days to skip zombie data). Returns per-order: id, type, status, customerName, **deliveryBy** (customer-facing committed delivery date), shipsAt (internal manufacturing target), **daysPastDeliveryBy**, **deadlineMissed**, daysLate, totalDollars, primaryCause, **causeSummary**, job-level counts, **notes** (raw Transactions.notes — customer comments, PO refs, project names, hold dates, etc.), **noteFlags** (regex-extracted important segments from notes). Also returns aggregate buckets: byDaysLate, byPrimaryCause, byType, **byDeadline = { customerDeadlineMissed, withinCustomerWindow, noCustomerDeadline }**. Results are sorted customer-deadline-missed first.\\n\\n**Required behavior when answering:**\\n1. Lead the chat summary with `buckets.byDeadline.customerDeadlineMissed` if > 0 — that is the actionable customer-facing signal.\\n2. **For every order with non-empty `noteFlags`, surface those flags in the canvas table\\u2019s Cause/Notes column AND mention any deadline-bearing notes in the chat summary headline** — these are customer commitments and special instructions (\\"need by 5/11\\", \\"hold shipment 4/30\\", \\"rush\\", \\"PO #...\\", project names) that are NOT captured in `deliveryBy` and would otherwise be missed. Treat note-flagged orders as just as urgent as `deadlineMissed=true` ones.\\n3. **NEVER label any of these orders \\"on track\\" — they are ALL late by construction (the report filters for `isLateOrder=true`).** When rendering the deadline breakdown, use phrasing like \\"customer deadline missed\\" / \\"still within customer window\\" / \\"no customer deadline set\\". The fact that an order is internally late but the customer hasn\\u2019t been let down yet is NOT \\"on track\\".\\n4. When rendering the per-row canvas table, include a column for `noteFlags` (or merge into `causeSummary`) so the maintainer sees these at a glance.',
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
  /** Customer-facing committed delivery date (Transactions.deliveryBy).
   *  Distinct from `shipsAt` — that's an internal manufacturing target. */
  deliveryBy: string | null;
  /** Positive = N days past the committed deliveryBy; 0/null = on track or no commitment. */
  daysPastDeliveryBy: number | null;
  /** Convenience flag: deliveryBy is set AND has already passed. */
  deadlineMissed: boolean;
  totalDollars: number | null;
  jobCount: number;
  failedJobCount: number;        // Jobs.status='Failed'
  cancelledJobCount: number;     // Jobs.status='Cancelled'
  reworkJobCount: number;        // Jobs with attempt > 1 (true reworks, not the noisy isRework flag)
  maxAttempt: number;            // worst-case rework number across all jobs
  lostPartCount: number;         // Stocks.status='Cancelled' for this order's stocks (parts scrapped)
  attentionCount: number;        // hasAttention flag — kept but deprioritized
  /** Top failure-mode keys derived from Jobs.failedReason.reason where status='Fail',
   *  cleaned up: e.g. ['Print: gunk', 'Print: layer lines'] sorted by count desc. */
  failureModes: string[];
  /** Free-text notes from Transactions.notes (truncated to 500 chars). Often
   *  contains delivery commitments ("need by 5/11"), project names, PO refs,
   *  hold instructions, special routing — anything that doesn't fit a
   *  structured field. The bot is instructed to scan these and surface
   *  important context in the report. */
  notes: string | null;
  /** Pre-extracted "important looking" segments from `notes` — date-like
   *  hints, rush/hold keywords, PO references, requested ship dates, etc.
   *  Regex-extracted server-side so the LLM can't miss them. Empty array
   *  means notes either are empty or contain no actionable phrases. */
  noteFlags: string[];
  primaryCause: string;
  /** One-line, table-friendly cause description suitable for a single Cause column
   *  (capped at ~90 chars). Examples:
   *    "Part scrapped (3) + rework gunk, layer lines"
   *    "Reworked 4× — feature damage, cracking"
   *    "Has attention (78 jobs)"
   */
  causeSummary: string;
  flaggedJobs: string[];
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
    t."deliveryBy",
    t.notes,
    GREATEST(0, EXTRACT(DAY FROM (NOW() - t."shipsAt")))::int AS days_late,
    CASE
      WHEN t."deliveryBy" IS NOT NULL AND t."deliveryBy" < NOW()
        THEN EXTRACT(DAY FROM (NOW() - t."deliveryBy"))::int
      ELSE NULL
    END AS days_past_deadline,
    COALESCE((amount->>'total')::numeric,
             (amount->>'subtotal')::numeric
             + COALESCE((amount->>'shipping')::numeric, 0)
             + COALESCE((amount->>'tax')::numeric, 0)) / 100.0 AS total_dollars
  FROM "Transactions" t
  WHERE t."isLateOrder" = true
    AND t.status NOT IN ('Cancelled', 'Lost', 'Refunded', 'Delivered', 'Shipped', 'Partially refunded')
    AND t."shipsAt" >= NOW() - INTERVAL '365 days'
    ${filterClause}
),
job_summary AS (
  SELECT
    j."orderId",
    COUNT(*)::int AS job_count,
    COUNT(*) FILTER (WHERE j.status = 'Failed')::int AS failed_job_count,
    COUNT(*) FILTER (WHERE j.status = 'Cancelled')::int AS cancelled_job_count,
    COUNT(*) FILTER (WHERE COALESCE(j.attempt, 1) > 1)::int AS rework_job_count,
    COALESCE(MAX(j.attempt), 1)::int AS max_attempt,
    COUNT(*) FILTER (WHERE j."hasAttention")::int AS attention_count,
    array_agg(DISTINCT j.description) FILTER (
      WHERE j.status = 'Failed'
         OR j.status = 'Cancelled'
         OR COALESCE(j.attempt, 1) > 1
         OR j."hasAttention"
    ) AS flagged_descriptions
  FROM "Jobs" j
  WHERE j."orderId" IN (SELECT id FROM late)
  GROUP BY j."orderId"
),
stock_summary AS (
  SELECT
    sa."orderId",
    COUNT(*) FILTER (WHERE s.status = 'Cancelled')::int AS lost_part_count
  FROM "StockAssociations" sa
  JOIN "Stocks" s ON s.id = sa."stockId"
  WHERE sa."orderId" IN (SELECT id FROM late)
  GROUP BY sa."orderId"
),
failure_modes AS (
  SELECT
    "orderId",
    array_agg(failure_key ORDER BY n DESC) AS modes,
    array_agg(n ORDER BY n DESC) AS mode_counts
  FROM (
    SELECT
      j."orderId",
      r.failure_key::text AS failure_key,
      COUNT(*)::int AS n
    FROM "Jobs" j
    JOIN late lo ON lo.id = j."orderId"
    CROSS JOIN LATERAL jsonb_each((j."failedReason"->'reason')::jsonb) AS r(failure_key, failure_val)
    WHERE j.status = 'Failed'
      AND failure_val->>'status' = 'Fail'
    GROUP BY j."orderId", r.failure_key
  ) per_mode
  GROUP BY "orderId"
)
SELECT
  l.id,
  l.type,
  l.status,
  l."customerName",
  l."organizationId",
  l."shipsAt",
  l."deliveryBy",
  l.notes,
  l.days_late,
  l.days_past_deadline,
  l.total_dollars,
  COALESCE(js.job_count, 0) AS job_count,
  COALESCE(js.failed_job_count, 0) AS failed_job_count,
  COALESCE(js.cancelled_job_count, 0) AS cancelled_job_count,
  COALESCE(js.rework_job_count, 0) AS rework_job_count,
  COALESCE(js.max_attempt, 1) AS max_attempt,
  COALESCE(js.attention_count, 0) AS attention_count,
  js.flagged_descriptions,
  COALESCE(ss.lost_part_count, 0) AS lost_part_count,
  fm.modes AS failure_modes
FROM late l
LEFT JOIN job_summary js ON js."orderId" = l.id
LEFT JOIN stock_summary ss ON ss."orderId" = l.id
LEFT JOIN failure_modes fm ON fm."orderId" = l.id
-- Sort: deadline-missed first (largest miss first), then plain days-late.
ORDER BY (l.days_past_deadline IS NOT NULL) DESC, l.days_past_deadline DESC NULLS LAST, l.days_late DESC
LIMIT ${args.limit};
`;
}

function rowsToOrders(fields: string[], rows: unknown[][]): OrderOut[] {
  const idx = (n: string) => fields.indexOf(n);
  const out: OrderOut[] = [];
  for (const row of rows) {
    const id = Number(row[idx('id')]);
    const flagged = parseStringArray(row[idx('flagged_descriptions')]);
    const failedJobCount = Number(row[idx('failed_job_count')] ?? 0);
    const cancelledJobCount = Number(row[idx('cancelled_job_count')] ?? 0);
    const reworkJobCount = Number(row[idx('rework_job_count')] ?? 0);
    const maxAttempt = Number(row[idx('max_attempt')] ?? 1);
    const attentionCount = Number(row[idx('attention_count')] ?? 0);
    const lostPartCount = Number(row[idx('lost_part_count')] ?? 0);
    const failureModes = parseStringArray(row[idx('failure_modes')]).map(humanizeFailureMode);
    const deliveryByRaw = row[idx('deliveryBy')];
    const daysPastRaw = row[idx('days_past_deadline')];
    const daysPastDeliveryBy = daysPastRaw != null ? Number(daysPastRaw) : null;
    const deadlineMissed = daysPastDeliveryBy !== null && daysPastDeliveryBy > 0;
    const notesRaw = row[idx('notes')];
    const notesText = typeof notesRaw === 'string' && notesRaw.trim().length > 0
      ? notesRaw.length > 500 ? notesRaw.slice(0, 497) + '…' : notesRaw
      : null;
    const noteFlags = notesText ? extractNoteFlags(notesText) : [];
    const stats = {
      failedJobCount, cancelledJobCount, reworkJobCount, maxAttempt,
      attentionCount, lostPartCount, failureModes,
      daysPastDeliveryBy,
    };
    out.push({
      id,
      type: String(row[idx('type')] ?? ''),
      status: String(row[idx('status')] ?? ''),
      customerName: (row[idx('customerName')] as string | null) ?? null,
      organizationId: row[idx('organizationId')] != null ? Number(row[idx('organizationId')]) : null,
      shipsAt: (row[idx('shipsAt')] as string | null) ?? null,
      deliveryBy: deliveryByRaw != null ? String(deliveryByRaw) : null,
      daysPastDeliveryBy,
      deadlineMissed,
      notes: notesText,
      noteFlags,
      daysLate: Number(row[idx('days_late')] ?? 0),
      totalDollars: row[idx('total_dollars')] != null ? Math.round(Number(row[idx('total_dollars')]) * 100) / 100 : null,
      jobCount: Number(row[idx('job_count')] ?? 0),
      failedJobCount,
      cancelledJobCount,
      reworkJobCount,
      maxAttempt,
      lostPartCount,
      attentionCount,
      failureModes,
      primaryCause: derivePrimaryCause(stats),
      causeSummary: deriveCauseSummary({ ...stats, flagged }),
      flaggedJobs: flagged.slice(0, 5),
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

export interface CauseStats {
  failedJobCount: number;
  cancelledJobCount: number;
  reworkJobCount: number;
  maxAttempt: number;
  attentionCount: number;
  lostPartCount: number;
  failureModes: string[];
  /** Set when the customer-facing `deliveryBy` deadline has been missed.
   *  Promoted above all production causes — this is the most actionable signal. */
  daysPastDeliveryBy?: number | null;
}

/**
 * Pick the dominant cause category for an order. Priority reflects what's
 * actionable for ops:
 *   0. Customer-facing deadline missed — promoted above everything else.
 *   1. Lost parts (stocks scrapped) — biggest production hit, longest tail.
 *   2. Heavy rework (≥2 attempts on the same op) — quality issues compounding.
 *   3. Failed jobs with concrete failure modes — actively blocked on rework.
 *   4. Mass cancellation (jobs cancelled, parts replaced).
 *   5. Has attention — generic "needs human review" flag (noisiest).
 *   6. Unknown.
 */
export function derivePrimaryCause(s: CauseStats): string {
  if (s.daysPastDeliveryBy != null && s.daysPastDeliveryBy > 0) {
    return `🚨 Deadline missed (${s.daysPastDeliveryBy}d)`;
  }
  if (s.lostPartCount > 0) return 'Part scrapped';
  if (s.maxAttempt >= 3) return `Reworked ${s.maxAttempt}×`;
  if (s.failedJobCount > 0 && s.failureModes.length > 0) return s.failureModes[0];
  if (s.failedJobCount > 0) return 'Failed jobs';
  if (s.reworkJobCount > 0) return 'Reworked';
  if (s.cancelledJobCount > 0) return 'Cancelled jobs';
  if (s.attentionCount > 0) return 'Needs attention';
  return 'Unknown';
}

/**
 * Compose a one-line cause summary suitable for a single Cause column cell.
 * Combines counts (parts scrapped, rework attempts) with concrete failure
 * modes from the failedReason JSON. Capped at ~90 characters.
 *
 * Example outputs:
 *   "Part scrapped (3) — gunk, layer lines (failed jobs: 12)"
 *   "Reworked 4× — feature damage, cracking"
 *   "Failed jobs (5): gunk, overhang texture, warping"
 *   "Needs attention (78 jobs flagged)"
 */
export function deriveCauseSummary(input: CauseStats & { flagged: string[] }): string {
  const parts: string[] = [];

  // Customer-facing deadline missed always leads — it's the signal ops needs to act on.
  if (input.daysPastDeliveryBy != null && input.daysPastDeliveryBy > 0) {
    parts.push(`🚨 Deadline missed by ${input.daysPastDeliveryBy}d`);
  }
  // Lead with the most actionable production signal.
  if (input.lostPartCount > 0) {
    parts.push(`Part scrapped (${input.lostPartCount})`);
  }
  if (input.maxAttempt >= 3) {
    parts.push(`reworked ${input.maxAttempt}×`);
  } else if (input.reworkJobCount > 0 && input.lostPartCount === 0) {
    parts.push(`reworked (${input.reworkJobCount} job${input.reworkJobCount === 1 ? '' : 's'})`);
  }

  // Top distinct failure modes from failedReason.reason (these are the real
  // production-quality causes — gunk, layer lines, cracking, etc.).
  if (input.failureModes.length > 0) {
    parts.push(input.failureModes.slice(0, 3).join(', '));
  } else if (input.failedJobCount > 0) {
    parts.push(`failed jobs: ${input.failedJobCount}`);
  }

  // Fallback: only show "Needs attention" if there's nothing more specific.
  if (parts.length === 0) {
    if (input.attentionCount > 0) {
      parts.push(`Needs attention (${input.attentionCount} jobs flagged)`);
    } else {
      parts.push('Unknown');
    }
  }

  const lead = parts[0];
  const tail = parts.slice(1).join(', ');
  const summary = tail ? `${lead} — ${tail}` : lead;
  return summary.length > 90 ? summary.slice(0, 87) + '…' : summary;
}

/**
 * Pull "important looking" segments from a free-text Transactions.notes
 * field. Splits on natural separators (\\n, |, ;, " - ", or sentence end)
 * and keeps any segment that:
 *   - Mentions a date-ish pattern (M/D, M/D/YYYY, "by <month>", "by N", ISO date)
 *   - Contains an action keyword (rush, expedite, hold, asap, deadline, deliver,
 *     promised, project, PO, ship date, requested, need by, no later than)
 * Each kept segment is trimmed and capped at 140 chars. Up to 6 returned.
 *
 * Heuristic by design — false positives are fine, the LLM will use these as
 * hints, not as ground truth.
 */
export function extractNoteFlags(notes: string): string[] {
  const segments = notes
    .split(/\n+|\|+|;+|(?<=[.!?])\s+(?=[A-Z])| - /)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0);
  const datePatterns: RegExp[] = [
    /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/, // 5/11, 04/30/2026
    /\b\d{4}-\d{2}-\d{2}\b/, // ISO
    /\b(?:by|before|need(?:ed)? by|no later than|requested|due|delivered? by)\b[^.]{0,50}/i,
    /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b\s*\d{0,2}/i,
  ];
  const keywordPattern = /\b(?:rush|expedite|asap|hold|deadline|promise|project|po\s*(?:#|number|:)|ship\s*date|requested|need\s+by|no later than|priority)\b/i;
  const flags: string[] = [];
  const seen = new Set<string>();
  for (const seg of segments) {
    if (flags.length >= 6) break;
    const matchesDate = datePatterns.some((re) => re.test(seg));
    const matchesKeyword = keywordPattern.test(seg);
    if (!matchesDate && !matchesKeyword) continue;
    const trimmed = seg.length > 140 ? seg.slice(0, 137) + '…' : seg;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    flags.push(trimmed);
  }
  return flags;
}

/** Convert a snake_case failure-mode key from failedReason.reason into a
 *  short, sentence-case string. e.g. `layer_lines` → "layer lines". */
function humanizeFailureMode(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function computeBuckets(orders: OrderOut[]) {
  const byDaysLate: Record<string, number> = { '0-3': 0, '4-7': 0, '8-14': 0, '15+': 0 };
  const byPrimaryCause: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let deadlineMissed = 0;
  let withinCustomerWindow = 0;
  let noCustomerDeadline = 0;
  for (const o of orders) {
    const bucket = o.daysLate <= 3 ? '0-3' : o.daysLate <= 7 ? '4-7' : o.daysLate <= 14 ? '8-14' : '15+';
    byDaysLate[bucket]++;
    byPrimaryCause[o.primaryCause] = (byPrimaryCause[o.primaryCause] ?? 0) + 1;
    byType[o.type] = (byType[o.type] ?? 0) + 1;
    if (o.deadlineMissed) deadlineMissed++;
    else if (o.deliveryBy) withinCustomerWindow++;
    else noCustomerDeadline++;
  }
  return {
    byDaysLate,
    byPrimaryCause,
    byType,
    /** Customer-deadline rollup. ALL orders here are already late vs the
     *  internal `shipsAt` target — that's the report's filter. The split
     *  reflects how late they are RELATIVE TO THE CUSTOMER COMMITMENT only:
     *  - `customerDeadlineMissed`: deliveryBy already passed (lead with this).
     *  - `withinCustomerWindow`: deliveryBy is set but still in the future,
     *    so we're internally late but the customer hasn't been let down YET.
     *  - `noCustomerDeadline`: no deliveryBy on the order at all.
     *  Phrasing matters in the canvas — never call these "on track", because
     *  every order in the report is late vs ops by construction.
     */
    byDeadline: {
      customerDeadlineMissed: deadlineMissed,
      withinCustomerWindow,
      noCustomerDeadline,
    },
  };
}
