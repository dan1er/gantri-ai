import { useEffect, useState } from 'react';
import { Card, Badge } from '@tremor/react';
import { fmtRelativeTime } from '../lib/format.js';

interface ReportRow {
  slug: string;
  title: string;
  description?: string | null;
  ownerSlackId: string;
  ownerDisplayName?: string;
  createdAt: string;
  lastVisitedAt?: string | null;
  visitCount: number;
  url: string;
}

export function ReportsIndex({ token }: { token: string | null }) {
  const [reports, setReports] = useState<ReportRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        // Try the cookie-based path first (set when a valid report URL was visited).
        // Fall back to ?t=<token> if the caller passed one explicitly.
        const url = token ? `/r/all.json?t=${encodeURIComponent(token)}` : '/r/all.json';
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) {
          if (res.status === 401) {
            setErr('No access token. Open a report URL first (you\'ll get a cookie), or DM @gantri-ai for the viewer link.');
          } else {
            const body = await res.text();
            setErr(`HTTP ${res.status}: ${body}`);
          }
        } else {
          const json = await res.json();
          setReports(json.reports);
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  return (
    <div>
      <header className="mb-10">
        <div className="flex items-center justify-between border-b border-gray-200 pb-6">
          <a href="/r" className="block"><img src="/r/logo-name.png" alt="Gantri" className="h-16 w-auto" /></a>
          <span className="text-xs text-gray-500">Live Reports · all reports</span>
        </div>
        <div className="mt-8">
          <h1 className="text-3xl font-semibold tracking-tight text-gantri-ink">All Live Reports</h1>
          <p className="text-base text-gray-500 mt-2">Reports the team has published. Click to view.</p>
        </div>
      </header>
      {loading && <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 animate-pulse">{[1, 2, 3, 4].map((i) => <div key={i} className="h-32 rounded-lg bg-gray-100" />)}</div>}
      {err && <Card><div className="py-6 text-sm text-red-600">{err}</div></Card>}
      {reports && reports.length === 0 && <Card><div className="py-12 text-center text-sm text-gray-500">No reports published yet. DM @gantri-ai with: <em>"create a live report on …"</em></div></Card>}
      {reports && reports.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {reports.map((r) => (
            <a key={r.slug} href={r.url} className="block group">
              <Card className="!p-5 transition-shadow hover:shadow-lg cursor-pointer">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-base font-semibold text-gantri-ink group-hover:text-blue-600 transition-colors flex-1">{r.title}</h3>
                  {r.visitCount > 0 && <Badge size="xs" color="blue">{r.visitCount} views</Badge>}
                </div>
                {r.description && <p className="text-sm text-gray-500 mt-2 line-clamp-2">{r.description}</p>}
                <div className="mt-4 flex items-center gap-3 text-xs text-gray-400">
                  <span>by <span className="text-gray-600">{r.ownerDisplayName ?? r.ownerSlackId}</span></span>
                  <span>·</span>
                  <span>{fmtRelativeTime(r.createdAt)}</span>
                  {r.lastVisitedAt && <><span>·</span><span>last viewed {fmtRelativeTime(r.lastVisitedAt)}</span></>}
                </div>
              </Card>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
