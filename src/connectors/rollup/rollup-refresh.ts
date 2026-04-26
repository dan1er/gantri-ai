import type { GrafanaConnector } from '../grafana/grafana-connector.js';
import type { RollupRepo, UpsertRollupInput } from '../../storage/rollup-repo.js';
import { logger } from '../../logger.js';

const PT_TZ = 'America/Los_Angeles';
// Replicates the Grafana Sales dashboard "Full Total" panel formula EXACTLY so
// the rollup matches what the Gantri team actually looks at. Two key choices,
// both copied from Grafana's per-type Sales panel:
//
// 1. Revenue components come from StockAssociations + GiftCards (the per-line
//    SA-level fields), NOT from Transactions.amount. Same row count, but
//    Transaction-level discount/shipping/tax can differ from the sum of the
//    per-line SA values (e.g. for Trade type the SA-level discount is $77k
//    while T.amount.discount is $47k). The Grafana panel uses SA-level, so we
//    do too.
//    full_total = SA.subtotal + GC.subtotal + SA.shipping + SA.tax - SA.discount
//    Note: gift and credit are NOT subtracted in the Grafana panel.
//
// 2. Non-refund types bucket by t.createdAt and require status NOT IN
//    ('Unpaid','Cancelled'). Refund types bucket by t.completedAt and
//    require status IN ('Refunded','Delivered'); their revenue is negated so
//    daily totals net out refunds.
const ROLLUP_SQL = `
WITH per_txn AS (
  SELECT
    t.id, t.type, t.status, t."createdAt", t."completedAt",
    COALESCE(t."organizationId"::text, 'null') AS org_key,
    (SUM(COALESCE((sa.amount->>'subtotal')::decimal, 0))
       + COALESCE(SUM((gc.amount)::decimal), 0)
     + SUM(COALESCE((sa.amount->>'shipping')::decimal, 0))
     + SUM(COALESCE((sa.amount->>'tax')::decimal, 0))
     - SUM(COALESCE((sa.amount->>'discount')::decimal, 0))) AS revenue_cents
  FROM "Transactions" t
  LEFT JOIN "StockAssociations" sa ON sa."orderId" = t.id
  LEFT JOIN "GiftCards" gc ON gc."orderId" = t.id
  WHERE
    -- Non-refund types: keyed by createdAt. Refund types: keyed by completedAt.
    -- Either bucket-day must fall within the window for the row to count.
    (
      (t.type NOT LIKE '%Refund'
        AND t."createdAt" >= ($__timeFrom())::timestamp
        AND t."createdAt" <  ($__timeTo())::timestamp
        AND t.status NOT IN ('Unpaid','Cancelled'))
      OR
      (t.type LIKE '%Refund'
        AND t."completedAt" >= ($__timeFrom())::timestamp
        AND t."completedAt" <  ($__timeTo())::timestamp
        AND t.status IN ('Refunded','Delivered'))
    )
  GROUP BY t.id, t.type, t.status, t."createdAt", t."completedAt", org_key
),
txn AS (
  SELECT
    -- Non-refund: bucket by createdAt PT. Refund: bucket by completedAt PT.
    CASE
      WHEN type LIKE '%Refund'
        THEN DATE_TRUNC('day', "completedAt" AT TIME ZONE 'America/Los_Angeles')::date
      ELSE DATE_TRUNC('day', "createdAt" AT TIME ZONE 'America/Los_Angeles')::date
    END AS day,
    type, status, org_key,
    -- Negate refund-type revenue so daily totals are net of refunds and the
    -- by_type breakdown sums to the daily total.
    (CASE WHEN type LIKE '%Refund' THEN -1 ELSE 1 END) * revenue_cents AS revenue_cents
  FROM per_txn
),
daily_totals AS (
  SELECT day,
         COUNT(*)::int AS total_orders,
         COALESCE(SUM(revenue_cents), 0)::bigint AS total_revenue_cents
  FROM txn GROUP BY day
),
by_type AS (
  SELECT day, jsonb_object_agg(type, agg) AS data
  FROM (
    SELECT day, type,
           jsonb_build_object('orders', COUNT(*), 'revenueCents', COALESCE(SUM(revenue_cents), 0)::bigint) AS agg
    FROM txn GROUP BY day, type
  ) x GROUP BY day
),
by_status AS (
  SELECT day, jsonb_object_agg(status, agg) AS data
  FROM (
    SELECT day, status,
           jsonb_build_object('orders', COUNT(*), 'revenueCents', COALESCE(SUM(revenue_cents), 0)::bigint) AS agg
    FROM txn GROUP BY day, status
  ) x GROUP BY day
),
by_org AS (
  SELECT day, jsonb_object_agg(org_key, agg) AS data
  FROM (
    SELECT day, org_key,
           jsonb_build_object('orders', COUNT(*), 'revenueCents', COALESCE(SUM(revenue_cents), 0)::bigint) AS agg
    FROM txn GROUP BY day, org_key
  ) x GROUP BY day
)
SELECT
  d.day,
  d.total_orders,
  d.total_revenue_cents,
  COALESCE(t.data, '{}'::jsonb) AS by_type,
  COALESCE(s.data, '{}'::jsonb) AS by_status,
  COALESCE(o.data, '{}'::jsonb) AS by_organization
FROM daily_totals d
LEFT JOIN by_type   t USING (day)
LEFT JOIN by_status s USING (day)
LEFT JOIN by_org    o USING (day)
ORDER BY d.day
`;

export interface RollupRefreshDeps {
  grafana: GrafanaConnector;
  repo: RollupRepo;
}

export class RollupRefreshJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: RollupRefreshDeps) {}

  /** Start a 15-minute poll that triggers a 30-day refresh once a day at ~04:00 PT. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tickIfDue(); }, 15 * 60 * 1000);
    logger.info({}, 'rollup refresh job started (15-min poll)');
    // Run once on boot to backfill anything missed during downtime.
    void this.refreshWindow(30);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async tickIfDue(): Promise<void> {
    if (this.running) return;
    const now = new Date();
    // Run when current PT hour is 4 (04:00–04:59). The 15-min poll guarantees we hit the window.
    const hourPt = parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: PT_TZ, hour: '2-digit', hour12: false })
        .format(now)
        .replace(/\D/g, ''),
      10,
    );
    if (hourPt !== 4) return;
    await this.refreshWindow(30);
  }

  /** Recompute the past `days` PT calendar days and upsert. */
  async refreshWindow(days: number): Promise<{ daysWritten: number }> {
    if (this.running) return { daysWritten: 0 };
    this.running = true;
    const started = Date.now();
    try {
      const today = pacificDay(new Date());
      const startDate = addDays(today, -days);
      const fromMs = wallClockToUtc(`${startDate}T00:00:00.000`, PT_TZ);
      const toMs = wallClockToUtc(`${addDays(today, 1)}T00:00:00.000`, PT_TZ);
      const { fields, rows } = await this.deps.grafana.runSql({
        sql: ROLLUP_SQL,
        fromMs,
        toMs,
        maxRows: days + 5,
      });
      const upserts = rowsToUpserts(fields, rows);
      await this.deps.repo.upsertMany(upserts);
      logger.info(
        { days, written: upserts.length, durationMs: Date.now() - started },
        'rollup refreshed',
      );
      return { daysWritten: upserts.length };
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.stack : String(err) }, 'rollup refresh failed');
      return { daysWritten: 0 };
    } finally {
      this.running = false;
    }
  }
}

function rowsToUpserts(fields: string[], rows: unknown[][]): UpsertRollupInput[] {
  const idx = (name: string) => fields.indexOf(name);
  const dayIdx = idx('day');
  const totalOrdersIdx = idx('total_orders');
  const totalRevIdx = idx('total_revenue_cents');
  const byTypeIdx = idx('by_type');
  const byStatusIdx = idx('by_status');
  const byOrgIdx = idx('by_organization');
  const out: UpsertRollupInput[] = [];
  for (const row of rows) {
    const day = normalizeDay(row[dayIdx]);
    if (!day) continue; // skip rows where the date didn't parse
    out.push({
      date: day,
      total_orders: Number(row[totalOrdersIdx] ?? 0),
      total_revenue_cents: Number(row[totalRevIdx] ?? 0),
      by_type: parseJson(row[byTypeIdx]),
      by_status: parseJson(row[byStatusIdx]),
      by_organization: parseJson(row[byOrgIdx]),
    });
  }
  return out;
}

/**
 * Grafana's data API serializes the `date` column three different ways
 * depending on payload size and version: ISO string ("2025-03-15"), full
 * timestamp ("2025-03-15T00:00:00Z"), or unix epoch in seconds (1714867200)
 * or ms (1714867200000). Coerce all of them to YYYY-MM-DD (PT day) or null
 * when nothing reasonable comes through.
 */
function normalizeDay(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    // 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM...' — first 10 chars are the date.
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    // numeric-string fallback (e.g. "1714867200")
    const n = Number(value);
    if (Number.isFinite(n)) return msToDay(n > 1e12 ? n : n * 1000);
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return msToDay(value > 1e12 ? value : value * 1000);
  }
  return null;
}

/**
 * Convert an epoch-ms value (as Grafana wire-formats Postgres DATE columns)
 * back to its YYYY-MM-DD label. Critical: Postgres DATE values are serialized
 * as midnight UTC of the date. We must format in UTC, NOT in PT — formatting
 * in PT would shift each date back one day (midnight UTC = previous evening
 * in PT) and silently corrupt every row in the rollup.
 *
 * The SQL's `DATE_TRUNC('day', t."createdAt" AT TIME ZONE 'America/Los_Angeles')`
 * already produces the correct PT calendar day; the wire serialization just
 * carries it as `<day>T00:00:00Z`. Reading it as a UTC instant preserves
 * the day; reading it as a PT instant loses one.
 */
function msToDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function parseJson(value: unknown): Record<string, { orders: number; revenueCents: number }> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, { orders: number; revenueCents: number }>;
  }
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return {}; }
  }
  return {};
}

function pacificDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: PT_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
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
