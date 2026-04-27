interface Props {
  ownerSlackId: string;
  ownerDisplayName?: string;
  createdAt: string;
  lastRefreshedAt: string;
  intent: string;
  sources: string[];
  onRefresh: () => void;
  onReportFeedback: () => void;
}

export function ReportFooter({ ownerSlackId, ownerDisplayName, createdAt, lastRefreshedAt, intent, sources, onRefresh, onReportFeedback }: Props) {
  const sourcesPretty = [...new Set(sources.map((s) => s.split('.')[0]))].map((p) => ({
    northbeam: 'Northbeam', gantri: 'Porter', ga4: 'Google Analytics 4', grafana: 'Grafana',
  } as Record<string, string>)[p] ?? p).join(' · ');
  const ownerLabel = ownerDisplayName ?? ownerSlackId;
  return (
    <footer className="mt-12 border-t border-gray-200 pt-6 text-sm text-gray-600">
      <p><strong>Created by</strong> <span className="text-blue-600">{ownerLabel}</span> · <strong>{new Date(createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</strong> · last refreshed {new Date(lastRefreshedAt).toLocaleTimeString('en-US')}</p>
      <p className="mt-2"><strong>Generated from:</strong> <em>"{intent}"</em></p>
      <p className="mt-2"><strong>Data sources:</strong> {sourcesPretty}</p>
      <p className="mt-4 flex gap-4">
        <button className="text-blue-600 hover:underline" onClick={onRefresh}>Refresh now</button>
        <button className="text-blue-600 hover:underline" onClick={onReportFeedback}>Report a wrong number</button>
      </p>
    </footer>
  );
}
