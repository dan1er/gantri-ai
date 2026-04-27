import { Button } from '@tremor/react';
import { fmtRelativeTime } from '../lib/format.js';

interface Props {
  title: string;
  subtitle?: string | null;
  lastRefreshedAt: string;
  onRefresh: () => void;
  refreshing: boolean;
  onShowSpec: () => void;
}

export function ReportHeader({ title, subtitle, lastRefreshedAt, onRefresh, refreshing, onShowSpec }: Props) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between border-b border-gray-200 pb-6 mb-8">
      <div className="flex items-center gap-4">
        <a href="/r"><img src="/r/logo-name.png" alt="Gantri" className="h-7 w-auto" /></a>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-gantri-ink">{title}</h1>
          {subtitle && <p className="text-sm text-gray-500 mt-1">{subtitle}</p>}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-500" title={lastRefreshedAt}>Updated {fmtRelativeTime(lastRefreshedAt)}</span>
        <Button size="xs" variant="secondary" onClick={onRefresh} loading={refreshing}>Refresh</Button>
        <Button size="xs" variant="light" onClick={onShowSpec}>View spec</Button>
      </div>
    </header>
  );
}
