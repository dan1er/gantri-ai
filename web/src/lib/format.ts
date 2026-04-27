export type FormatKind = 'currency' | 'number' | 'percent' | 'date_pt' | 'pct_delta' | 'admin_order_link';

const currencyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const integerFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const numberFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const percentFmt = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });

function isClose(n: number, target: number): boolean { return Math.abs(n - target) < 1e-6; }

export function fmt(v: unknown, kind: FormatKind): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string' && kind === 'admin_order_link') return v;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return typeof v === 'string' ? v : '—';
  switch (kind) {
    case 'currency': return currencyFmt.format(n);
    case 'percent': return percentFmt.format(n);
    case 'pct_delta': return `${n >= 0 ? '+' : ''}${percentFmt.format(n)}`;
    case 'date_pt':
      return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(n));
    case 'number':
    default: {
      // If it's effectively an integer (within float-rounding noise), show as integer.
      if (isClose(n, Math.round(n))) return integerFmt.format(Math.round(n));
      return numberFmt.format(n);
    }
  }
}

const RANGE_LABELS: Record<string, string> = {
  yesterday: 'Yesterday',
  last_7_days: 'Last 7 days',
  last_14_days: 'Last 14 days',
  last_30_days: 'Last 30 days',
  last_90_days: 'Last 90 days',
  last_180_days: 'Last 6 months',
  last_365_days: 'Last 12 months',
  this_month: 'This month',
  last_month: 'Last month',
  month_to_date: 'Month to date',
  quarter_to_date: 'Quarter to date',
  year_to_date: 'Year to date',
};

const PT_TZ = 'America/Los_Angeles';

/** Returns today's calendar date IN Pacific Time as { y, m, d } (1-based month). */
function todayInPt(): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: PT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const y = Number(parts.find((p) => p.type === 'year')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'month')?.value ?? '0');
  const d = Number(parts.find((p) => p.type === 'day')?.value ?? '0');
  return { y, m, d };
}

/** Build a Date that represents PT-noon on the given calendar date. We use noon
 * to be safe across DST shifts when formatting back through Intl. */
function ptDate(y: number, m: number, d: number): Date {
  // Construct "12:00 noon PT" by using the PT offset. For display purposes we
  // only need a Date whose local fields encode (y, m, d). The simplest stable
  // way: use a UTC Date at 18:00 (mid-PT-afternoon, never crosses midnight in
  // any DST scenario when formatted through Intl with PT zone).
  return new Date(Date.UTC(y, m - 1, d, 18, 0, 0));
}

function addDaysPt(base: { y: number; m: number; d: number }, deltaDays: number): { y: number; m: number; d: number } {
  // Use UTC arithmetic on a noon-anchor; never crosses TZ boundary with ±N days.
  const dt = new Date(Date.UTC(base.y, base.m - 1, base.d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function formatPtDate(d: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: PT_TZ, month: 'short', day: 'numeric', year: 'numeric' }).format(d);
}

function rangeBoundsForPreset(preset: string): { start: Date; end: Date } | null {
  const today = todayInPt();
  const sub = (n: number) => addDaysPt(today, -n);
  const toDate = (p: { y: number; m: number; d: number }) => ptDate(p.y, p.m, p.d);
  switch (preset) {
    case 'yesterday': { const y = sub(1); return { start: toDate(y), end: toDate(y) }; }
    case 'last_7_days': return { start: toDate(sub(6)), end: toDate(today) };
    case 'last_14_days': return { start: toDate(sub(13)), end: toDate(today) };
    case 'last_30_days': return { start: toDate(sub(29)), end: toDate(today) };
    case 'last_90_days': return { start: toDate(sub(89)), end: toDate(today) };
    case 'last_180_days': return { start: toDate(sub(179)), end: toDate(today) };
    case 'last_365_days': return { start: toDate(sub(364)), end: toDate(today) };
    case 'this_month':
    case 'month_to_date': return { start: toDate({ y: today.y, m: today.m, d: 1 }), end: toDate(today) };
    case 'last_month': {
      const lm = today.m === 1 ? { y: today.y - 1, m: 12 } : { y: today.y, m: today.m - 1 };
      const start = ptDate(lm.y, lm.m, 1);
      // Last day of last month = day 0 of this month
      const endNative = new Date(Date.UTC(today.y, today.m - 1, 0, 18, 0, 0));
      return { start, end: endNative };
    }
    case 'quarter_to_date': {
      const q = Math.floor((today.m - 1) / 3) * 3 + 1; // first month of quarter (1-based)
      return { start: toDate({ y: today.y, m: q, d: 1 }), end: toDate(today) };
    }
    case 'year_to_date': return { start: toDate({ y: today.y, m: 1, d: 1 }), end: toDate(today) };
    default: return null;
  }
}

export function describeEffectiveRange(range: unknown): string {
  if (typeof range === 'string') {
    const label = RANGE_LABELS[range] ?? range;
    const bounds = rangeBoundsForPreset(range);
    if (bounds) return `${label} · ${formatPtDate(bounds.start)} – ${formatPtDate(bounds.end)}`;
    return label;
  }
  if (range && typeof range === 'object' && 'start' in range && 'end' in range) {
    const r = range as { start: string; end: string };
    return `Custom · ${formatPtDate(new Date(r.start))} – ${formatPtDate(new Date(r.end))}`;
  }
  return '';
}

export function rangeKey(range: unknown): string {
  if (typeof range === 'string') return range;
  if (range && typeof range === 'object' && 'start' in range && 'end' in range) return 'custom';
  return 'last_7_days';
}

export function fmtRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}
