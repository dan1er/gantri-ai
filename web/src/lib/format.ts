export type FormatKind = 'currency' | 'number' | 'percent' | 'date_pt' | 'pct_delta' | 'admin_order_link';

const numberFmt = new Intl.NumberFormat('en-US');
const currencyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const percentFmt = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function fmt(v: unknown, kind: FormatKind): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') {
    if (kind === 'admin_order_link') return v;
    return v;
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  switch (kind) {
    case 'currency': return currencyFmt.format(n);
    case 'percent': return percentFmt.format(n);
    case 'pct_delta': return `${n >= 0 ? '+' : ''}${percentFmt.format(n)}`;
    case 'date_pt': return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(n));
    case 'number':
    default: return numberFmt.format(n);
  }
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
