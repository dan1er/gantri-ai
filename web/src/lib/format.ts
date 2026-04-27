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
