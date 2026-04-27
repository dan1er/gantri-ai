import { Button } from '@tremor/react';
import { fmtRelativeTime } from '../lib/format.js';

interface Props {
  title: string;
  subtitle?: string | null;
  rangeLabel: string;
  currentRange: string;
  lastRefreshedAt: string;
  onRefresh: () => void;
  onChangeRange: (range: string | { start: string; end: string }) => void;
  refreshing: boolean;
  loading?: boolean;
  onShowSpec: () => void;
  /** When false, the report's data steps don't reference $REPORT_RANGE — the
   *  date picker is hidden because viewer interaction wouldn't change the data.
   *  The period subtitle is ALWAYS shown (driven by `effectivePeriod`). */
  parametric?: boolean;
  /** Concrete date range the report's data covers on this render. Always
   *  shown as the header subtitle so the viewer knows what period the
   *  numbers reflect. */
  effectivePeriod?: { startDate: string; endDate: string };
}

function Spinner() {
  return (
    <svg className="animate-spin h-3.5 w-3.5 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

const RANGE_PRESETS: Array<{ key: string; label: string }> = [
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last_7_days', label: 'Last 7 days' },
  { key: 'last_14_days', label: 'Last 14 days' },
  { key: 'last_30_days', label: 'Last 30 days' },
  { key: 'last_90_days', label: 'Last 90 days' },
  { key: 'last_180_days', label: 'Last 6 months' },
  { key: 'last_365_days', label: 'Last 12 months' },
  { key: 'month_to_date', label: 'Month to date' },
  { key: 'quarter_to_date', label: 'Quarter to date' },
  { key: 'year_to_date', label: 'Year to date' },
];

function formatPtIso(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, d, 18, 0, 0)));
}

function buildPeriodLabel(parametric: boolean, rangeLabel: string, effectivePeriod?: { startDate: string; endDate: string }): string {
  // Parametric reports already get a labeled range from the picker
  // ("Last 7 days · Apr 21 – Apr 27, 2026") via `rangeLabel`. Use that.
  if (parametric && rangeLabel) return rangeLabel;
  // Non-parametric reports: derive the label from the actual data window.
  if (effectivePeriod && effectivePeriod.startDate && effectivePeriod.endDate) {
    const a = formatPtIso(effectivePeriod.startDate);
    const b = formatPtIso(effectivePeriod.endDate);
    return effectivePeriod.startDate === effectivePeriod.endDate ? a : `${a} – ${b}`;
  }
  // Fallback (no period info at all): render the parametric label if available.
  return rangeLabel || '';
}

export function ReportHeader({ title, subtitle, rangeLabel, currentRange, lastRefreshedAt, onRefresh, onChangeRange, refreshing, loading, onShowSpec, parametric = true, effectivePeriod }: Props) {
  const periodLabel = buildPeriodLabel(parametric, rangeLabel, effectivePeriod);
  const isBusy = !!loading || !!refreshing;
  return (
    <header className="mb-10">
      <div className="flex items-center justify-between border-b border-gray-200 pb-6">
        <a href="/r" className="block">
          <img src="/r/logo-name.png" alt="Gantri" className="h-16 w-auto" />
        </a>
        <div className="flex items-center gap-3">
          {parametric && (
            <select
              className="text-xs border border-gray-300 rounded-md px-2 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-500 disabled:opacity-60"
              value={currentRange}
              onChange={(e) => onChangeRange(e.target.value)}
              aria-label="Date range"
              disabled={isBusy}
            >
              {RANGE_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          )}
          {isBusy ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-blue-600 font-medium" aria-live="polite">
              <Spinner />
              Loading…
            </span>
          ) : (
            <span className="text-xs text-gray-500" title={lastRefreshedAt}>Updated {fmtRelativeTime(lastRefreshedAt)}</span>
          )}
          <Button size="xs" variant="secondary" onClick={onRefresh} loading={refreshing}>Refresh</Button>
          <Button size="xs" variant="light" onClick={onShowSpec}>View spec</Button>
        </div>
      </div>
      <div className="mt-8">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight text-gantri-ink">{title}</h1>
          {isBusy && <Spinner />}
        </div>
        {periodLabel && <p className="text-sm text-blue-600 mt-2 font-medium">{periodLabel}</p>}
        {subtitle && <p className="text-base text-gray-500 mt-2 max-w-3xl leading-relaxed">{subtitle}</p>}
      </div>
    </header>
  );
}
