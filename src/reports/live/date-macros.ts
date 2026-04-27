/**
 * Render-time date-macro resolution for live report specs.
 *
 * The compiler can't bake calendar dates into specs because the spec is
 * persisted once and then re-evaluated on every visit. A spec like "this
 * Monday → today" needs the dates re-resolved each render, in PT.
 *
 * Macros use the syntax `$DATE:<base>[±Nd]` and resolve to `YYYY-MM-DD`:
 *
 *   $DATE:today           today (PT)
 *   $DATE:yesterday       today − 1d
 *   $DATE:this_monday     Monday of the current ISO week (PT)
 *   $DATE:last_monday     Monday of the prior ISO week
 *   $DATE:monday_2w_ago   Monday two ISO weeks ago
 *   $DATE:last_sunday     Sunday of the prior ISO week (= last_monday + 6d)
 *   $DATE:sunday_2w_ago   Sunday two ISO weeks ago
 *
 * Optional offset: `$DATE:today-7d` (same day-of-week last week, useful for
 * apples-to-apples WTD comparisons), `$DATE:this_monday+6d` etc.
 *
 * All "today" / week-anchor calculations use the **Pacific Time** calendar
 * date (consistent with the rest of the system).
 */

const PT_TZ = 'America/Los_Angeles';

interface Ymd { y: number; m: number; d: number; }

function todayPt(now: Date = new Date()): Ymd {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === 'year')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'month')?.value ?? '0');
  const d = Number(parts.find((p) => p.type === 'day')?.value ?? '0');
  return { y, m, d };
}

/** UTC-noon anchor — never crosses TZ boundary under ±N day arithmetic. */
function toUtcNoon(p: Ymd): Date { return new Date(Date.UTC(p.y, p.m - 1, p.d, 12, 0, 0)); }
function fromUtcNoon(dt: Date): Ymd { return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }; }
function addDays(p: Ymd, n: number): Ymd {
  const dt = toUtcNoon(p);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fromUtcNoon(dt);
}

function format(p: Ymd): string {
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Day of week in PT for the given calendar date, ISO style (Mon=1..Sun=7). */
function isoDow(p: Ymd): number {
  // weekday() at noon UTC matches the PT calendar date because we anchor at noon.
  const w = toUtcNoon(p).getUTCDay(); // 0=Sun..6=Sat
  return w === 0 ? 7 : w;
}

function thisMonday(today: Ymd): Ymd { return addDays(today, -(isoDow(today) - 1)); }

/** Resolve a base name to a PT calendar date. Returns null if the base is unknown. */
function resolveBase(base: string, now: Date = new Date()): Ymd | null {
  const today = todayPt(now);
  switch (base) {
    case 'today': return today;
    case 'yesterday': return addDays(today, -1);
    case 'this_monday': return thisMonday(today);
    case 'last_monday': return addDays(thisMonday(today), -7);
    case 'monday_2w_ago': return addDays(thisMonday(today), -14);
    case 'last_sunday': return addDays(thisMonday(today), -1);
    case 'sunday_2w_ago': return addDays(thisMonday(today), -8);
    default: return null;
  }
}

/** Anchored form — matches a string that is ENTIRELY a date macro. Used by
 *  `resolveDateMacro` to return the resolved value as the right type when the
 *  macro stands alone (i.e. step args like `{ start: '$DATE:today' }`). */
const MACRO_RE_ANCHORED = /^\$DATE:([a-z][a-z0-9_]*)(?:([+-])(\d+)d)?$/;

/** Substring form — matches a date macro embedded inside longer text. Used to
 *  resolve macros inside prose (descriptions, text-block markdown, KPI labels,
 *  etc.) without affecting non-macro content. */
const MACRO_RE_GLOBAL = /\$DATE:([a-z][a-z0-9_]*)(?:([+-])(\d+)d)?/g;

function resolveOne(base: string, sign: string | undefined, mag: string | undefined, now: Date): string | null {
  const anchor = resolveBase(base, now);
  if (!anchor) return null;
  const offset = sign && mag ? (sign === '-' ? -Number(mag) : Number(mag)) : 0;
  return format(offset === 0 ? anchor : addDays(anchor, offset));
}

/** Resolve a single macro string. If the input doesn't match the macro syntax,
 *  returns the input unchanged (so non-macro strings flow through verbatim). */
export function resolveDateMacro(s: unknown, now: Date = new Date()): unknown {
  if (typeof s !== 'string') return s;
  // Anchored pass: whole-string macro → return the date string as-is so the
  // type stays `string` (not e.g. number/object).
  const m = s.match(MACRO_RE_ANCHORED);
  if (m) {
    const r = resolveOne(m[1], m[2], m[3], now);
    return r ?? s;
  }
  // Substring pass: replace every embedded $DATE:… occurrence in place. This
  // handles prose like "WTD (`$DATE:this_monday`–`$DATE:today`)".
  if (s.includes('$DATE:')) {
    return s.replace(MACRO_RE_GLOBAL, (orig, base: string, sign: string | undefined, mag: string | undefined) => {
      const r = resolveOne(base, sign, mag, now);
      return r ?? orig;
    });
  }
  return s;
}

/** Recursively walk a value tree (args, spec metadata, response payload) and
 *  resolve every $DATE:<…> macro in any string — anchored or embedded. */
export function substituteDateMacros<T>(value: T, now: Date = new Date()): T {
  if (typeof value === 'string') return resolveDateMacro(value, now) as T;
  if (Array.isArray(value)) return value.map((v) => substituteDateMacros(v, now)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteDateMacros(v, now);
    }
    return out as T;
  }
  return value;
}
