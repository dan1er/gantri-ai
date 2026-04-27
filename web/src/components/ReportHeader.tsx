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
  onShowSpec: () => void;
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

export function ReportHeader({ title, subtitle, rangeLabel, currentRange, lastRefreshedAt, onRefresh, onChangeRange, refreshing, onShowSpec }: Props) {
  return (
    <header className="mb-10">
      <div className="flex items-center justify-between border-b border-gray-200 pb-6">
        <a href="/r" className="block">
          <img src="/r/logo-name.png" alt="Gantri" className="h-16 w-auto" />
        </a>
        <div className="flex items-center gap-3">
          <select
            className="text-xs border border-gray-300 rounded-md px-2 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-500"
            value={currentRange}
            onChange={(e) => onChangeRange(e.target.value)}
            aria-label="Date range"
          >
            {RANGE_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          <span className="text-xs text-gray-500" title={lastRefreshedAt}>Updated {fmtRelativeTime(lastRefreshedAt)}</span>
          <Button size="xs" variant="secondary" onClick={onRefresh} loading={refreshing}>Refresh</Button>
          <Button size="xs" variant="light" onClick={onShowSpec}>View spec</Button>
        </div>
      </div>
      <div className="mt-8">
        <h1 className="text-3xl font-semibold tracking-tight text-gantri-ink">{title}</h1>
        <p className="text-sm text-blue-600 mt-2 font-medium">{rangeLabel}</p>
        {subtitle && <p className="text-base text-gray-500 mt-2 max-w-3xl leading-relaxed">{subtitle}</p>}
      </div>
    </header>
  );
}
