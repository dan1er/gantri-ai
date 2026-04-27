import { useEffect, useState } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  intent: string;
  spec: any;
  meta: { owner_slack_id: string; owner_display_name?: string; createdAt: string; lastRefreshedAt: string; sources: string[] };
  canModify: boolean;
}

export function SpecDrawer({ open, onClose, intent, spec, meta, canModify }: Props) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const specJson = JSON.stringify(spec, null, 2);
  const sourcesCounts: Record<string, number> = {};
  for (const step of spec?.data ?? []) sourcesCounts[step.tool] = (sourcesCounts[step.tool] ?? 0) + 1;
  return (
    <>
      <div onClick={onClose} className="fixed inset-0 bg-black/40 z-40 transition-opacity backdrop-blur-sm" />
      <aside className="fixed inset-y-0 right-0 z-50 w-full sm:w-[520px] bg-white border-l border-gray-200 shadow-2xl overflow-y-auto">
        <div className="sticky top-0 bg-white/95 backdrop-blur border-b border-gray-200 px-6 py-4 flex justify-between items-center z-10">
          <h2 className="text-lg font-semibold text-gantri-ink">Spec</h2>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-900 text-2xl leading-none transition-colors">×</button>
        </div>
        <div className="px-6 py-6 space-y-7">
          <section>
            <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-3 font-medium">Intent</h3>
            <blockquote className="border-l-4 border-blue-500 pl-4 py-1 text-sm text-gray-800 italic">{intent}</blockquote>
          </section>
          <section>
            <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-3 font-medium">Provenance</h3>
            <dl className="text-sm space-y-1.5">
              <div><dt className="inline text-gray-500">Created by </dt><dd className="inline text-blue-600 font-medium">{meta.owner_display_name ?? meta.owner_slack_id}</dd></div>
              <div><dt className="inline text-gray-500">Created </dt><dd className="inline text-gray-700">{new Date(meta.createdAt).toLocaleString('en-US')}</dd></div>
              <div><dt className="inline text-gray-500">Last refreshed </dt><dd className="inline text-gray-700">{new Date(meta.lastRefreshedAt).toLocaleString('en-US')}</dd></div>
              <div><dt className="inline text-gray-500">Spec version </dt><dd className="inline font-mono text-gray-700">v{spec?.version ?? 1}</dd></div>
            </dl>
          </section>
          <section>
            <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-3 font-medium">Data sources</h3>
            <ul className="text-sm space-y-1.5">
              {Object.entries(sourcesCounts).map(([tool, n]) => (
                <li key={tool} className="font-mono text-blue-700"><span>{tool}</span> <span className="text-gray-400">× {n}</span></li>
              ))}
            </ul>
          </section>
          <section>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs uppercase tracking-wider text-gray-500 font-medium">Spec JSON</h3>
              <button onClick={async () => { await navigator.clipboard.writeText(specJson); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="text-xs text-blue-600 hover:underline font-medium">{copied ? 'Copied!' : 'Copy'}</button>
            </div>
            <pre className="text-xs bg-gray-50 border border-gray-200 rounded-md p-4 overflow-x-auto leading-relaxed"><code className="font-mono text-gray-800">{specJson}</code></pre>
          </section>
          {canModify && (
            <section>
              <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-3 font-medium">Actions</h3>
              <p className="text-xs text-gray-500 mb-2">Use the bot to recompile or archive this report:</p>
              <ul className="text-xs space-y-1">
                <li className="font-mono text-gray-700 bg-gray-50 px-2 py-1 rounded">recompile this report with: &lt;new intent&gt;</li>
                <li className="font-mono text-gray-700 bg-gray-50 px-2 py-1 rounded">archive this report</li>
              </ul>
            </section>
          )}
        </div>
      </aside>
    </>
  );
}
