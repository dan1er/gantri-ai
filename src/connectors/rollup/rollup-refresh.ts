import type { GrafanaConnector } from '../grafana/grafana-connector.js';
import type { RollupRepo, UpsertRollupInput } from '../../storage/rollup-repo.js';
import { logger } from '../../logger.js';

const PT_TZ = 'America/Los_Angeles';
const ROLLUP_SQL = `
WITH txn AS (
  SELECT
    DATE_TRUNC('day', t."createdAt" AT TIME ZONE 'America/Los_Angeles')::date AS day,
    t.type,
    t.status,
    COALESCE(t."organizationId"::text, 'null') AS org_key,
    COALESCE((t.amount->>'total')::numeric,
             (t.amount->>'subtotal')::numeric
             + COALESCE((t.amount->>'shipping')::numeric, 0)
             + COALESCE((t.amount->>'tax')::numeric, 0)) AS revenue_cents
  FROM "Transactions" t
  WHERE t."createdAt" >= ($__timeFrom())::timestamp
    AND t."createdAt" <  ($__timeTo())::timestamp
    AND t.status NOT IN ('Cancelled','Lost')
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
