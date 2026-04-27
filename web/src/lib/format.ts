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

function formatPtDate(d: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric' }).format(d);
}

function rangeBoundsForPreset(preset: string): { start: Date; end: Date } | null {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterday = new Date(today); yesterday.setUTCDate(today.getUTCDate() - 1);
  const sub = (n: number) => { const d = new Date(today); d.setUTCDate(today.getUTCDate() - n); return d; };
  switch (preset) {
    case 'yesterday': return { start: yesterday, end: yesterday };
    case 'last_7_days': return { start: sub(6), end: today };
    case 'last_14_days': return { start: sub(13), end: today };
    case 'last_30_days': return { start: sub(29), end: today };
    case 'last_90_days': return { start: sub(89), end: today };
    case 'last_180_days': return { start: sub(179), end: today };
    case 'last_365_days': return { start: sub(364), end: today };
    case 'month_to_date': return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), end: today };
    case 'quarter_to_date': {
      const q = Math.floor(now.getUTCMonth() / 3) * 3;
      return { start: new Date(Date.UTC(now.getUTCFullYear(), q, 1)), end: today };
    }
    case 'year_to_date': return { start: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)), end: today };
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
