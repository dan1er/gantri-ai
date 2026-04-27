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
    <header className="mb-10">
      <div className="flex items-center justify-between border-b border-gray-200 pb-6">
        <a href="/r" className="block">
          <img src="/r/logo-name.png" alt="Gantri" className="h-10 w-auto" />
        </a>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500" title={lastRefreshedAt}>Updated {fmtRelativeTime(lastRefreshedAt)}</span>
          <Button size="xs" variant="secondary" onClick={onRefresh} loading={refreshing}>Refresh</Button>
          <Button size="xs" variant="light" onClick={onShowSpec}>View spec</Button>
        </div>
      </div>
      <div className="mt-8">
        <h1 className="text-3xl font-semibold tracking-tight text-gantri-ink">{title}</h1>
        {subtitle && <p className="text-base text-gray-500 mt-2 max-w-3xl leading-relaxed">{subtitle}</p>}
      </div>
    </header>
  );
}
