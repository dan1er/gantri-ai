import type {
  TimeRef,
  TimeRefValue,
  ResolvedDateRange,
  ResolvedDateRangePair,
} from './plan-types.js';

/**
 * Resolve a TimeRef against the runner's `runAt` instant, in the given IANA
 * timezone. Returns either a single ResolvedDateRange or, for wow_compare_pt,
 * a pair of ranges.
 *
 * All ranges are inclusive PT calendar days. fromMs / toMs span the UTC range
 * that covers those PT days end-to-end. DST is handled correctly because the
 * conversion is done via the IANA timezone, not a fixed offset.
 */
export function resolveTimeRef(ref: TimeRef, runAt: Date, timezone: string): TimeRefValue {
  const today = pacificDay(runAt, timezone);
  switch (ref.$time) {
    case 'now_pt':
    case 'today_pt':
      return rangeFor(today, today, timezone);
    case 'yesterday_pt': {
      const y = addDays(today, -1);
      return rangeFor(y, y, timezone);
    }
    case 'this_week_pt': {
      const { mon, sun } = isoWeekBounds(today);
      return rangeFor(mon, sun, timezone);
    }
    case 'last_week_pt': {
      const { mon, sun } = isoWeekBounds(addDays(today, -7));
      return rangeFor(mon, sun, timezone);
    }
    case 'this_month_pt': {
      const { first, last } = monthBounds(today);
      return rangeFor(first, last, timezone);
    }
    case 'last_month_pt': {
      const prev = addDays(monthBounds(today).first, -1);
      const { first, last } = monthBounds(prev);
      return rangeFor(first, last, timezone);
    }
    case 'last_n_days_pt': {
      const start = addDays(today, -(ref.n - 1));
      return rangeFor(start, today, timezone);
    }
    case 'wow_compare_pt': {
      const cur = isoWeekBounds(today);
      const prev = isoWeekBounds(addDays(cur.mon, -7));
      return {
        current: rangeFor(cur.mon, cur.sun, timezone),
        previous: rangeFor(prev.mon, prev.sun, timezone),
      } satisfies ResolvedDateRangePair;
    }
  }
}

/** Return YYYY-MM-DD for the calendar day in `timezone` containing `at`. */
function pacificDay(at: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(at); // en-CA -> "2026-04-25"
}

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function isoWeekBounds(ymd: string): { mon: string; sun: string } {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay() || 7; // 1..7 (Mon..Sun)
  const monDate = new Date(dt);
  monDate.setUTCDate(dt.getUTCDate() - (dow - 1));
  const sunDate = new Date(monDate);
  sunDate.setUTCDate(monDate.getUTCDate() + 6);
  return {
    mon: monDate.toISOString().slice(0, 10),
    sun: sunDate.toISOString().slice(0, 10),
  };
}

function monthBounds(ymd: string): { first: string; last: string } {
  const [y, m] = ymd.split('-').map(Number);
  const first = `${pad(y, 4)}-${pad(m, 2)}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month
  const last = `${pad(y, 4)}-${pad(m, 2)}-${pad(lastDay, 2)}`;
  return { first, last };
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/**
 * Build a ResolvedDateRange. fromMs/toMs are the UTC instants that span the
 * PT calendar days [start..end] inclusive. Handles DST by routing the
 * boundary through the IANA timezone formatter.
 */
function rangeFor(startDate: string, endDate: string, timezone: string): ResolvedDateRange {
  const fromMs = wallClockToUtc(`${startDate}T00:00:00`, timezone);
  const toMs = wallClockToUtc(`${endDate}T23:59:59.999`, timezone);
  return { startDate, endDate, fromMs, toMs };
}

/**
 * Convert a wall-clock string in `timezone` to its UTC epoch ms.
 * Strategy: treat wallClock as if it were UTC, then iteratively correct by
 * the offset returned by formatting the candidate in the target tz. Two
 * passes converge across DST transitions.
 */
function wallClockToUtc(wallClock: string, timezone: string): number {
  let utc = Date.parse(`${wallClock}Z`);
  for (let i = 0; i < 2; i++) {
    const formatted = formatInTz(new Date(utc), timezone);
    const drift = Date.parse(`${formatted}Z`) - Date.parse(`${wallClock}Z`);
    utc -= drift;
  }
  return utc;
}

function formatInTz(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  // 24h handling: en-CA returns "24" for midnight; normalize to "00".
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}.${get('fractionalSecond') || '000'}`;
}
