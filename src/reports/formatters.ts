import type { ColumnSpec } from './plan-types.js';

const NA = '—';
const PT_TZ = 'America/Los_Angeles';

/** Format a single cell value according to a ColumnSpec.format (or pass through). */
export function formatCell(value: unknown, format?: ColumnSpec['format']): string {
  if (value === null || value === undefined) return NA;
  switch (format) {
    case 'currency_dollars': {
      const n = Number(value);
      if (!Number.isFinite(n)) return NA;
      return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    case 'integer': {
      const n = Number(value);
      if (!Number.isFinite(n)) return NA;
      return Math.round(n).toLocaleString('en-US');
    }
    case 'percent': {
      const n = Number(value);
      if (!Number.isFinite(n)) return NA;
      return `${(n * 100).toFixed(1)}%`;
    }
    case 'admin_order_link': {
      // Tolerant: accept either a bare numeric id ("51083") or a full
      // admin URL ("http://admin.gantri.com/orders/51083") and extract the
      // tail integer in either case. Plans sometimes wire field=adminLink
      // (already a URL) into a column with admin_order_link format; without
      // this fallback we'd stack URLs and the rendered cell would show the
      // full URL as the label.
      const raw = String(value);
      const m = raw.match(/(\d+)\s*$/);
      const id = m ? m[1] : raw;
      return `<http://admin.gantri.com/orders/${id}|#${id}>`;
    }
    case 'datetime_pt': {
      const d = new Date(value as string | number);
      if (Number.isNaN(d.getTime())) return NA;
      return ptWallClock(d, false);
    }
    case 'date_pt': {
      const d = new Date(value as string | number);
      if (Number.isNaN(d.getTime())) return NA;
      return ptWallClock(d, true);
    }
    default:
      // Floats like 627.2000000000001 leak from upstream FP arithmetic.
      // Cap at 2 decimals when no explicit format was requested.
      if (typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value)) {
        return value.toFixed(2);
      }
      return String(value);
  }
}

function ptWallClock(d: Date, dateOnly: boolean): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PT_TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(dateOnly ? {} : { hour: '2-digit', minute: '2-digit' }),
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  if (dateOnly) return date;
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${date} ${hour}:${get('minute')}`;
}
