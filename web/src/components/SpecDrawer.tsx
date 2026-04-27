import { useEffect, useState } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  intent: string;
  spec: any;
  meta: { owner_slack_id: string; createdAt: string; lastRefreshedAt: string; sources: string[] };
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
      <div onClick={onClose} className="fixed inset-0 bg-black/30 z-40 transition-opacity" />
      <aside className="fixed inset-y-0 left-0 z-50 w-full sm:w-[480px] bg-white border-r border-gray-200 shadow-xl overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex justify-between items-center">
          <h2 className="text-lg font-semibold">Spec</h2>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-900 text-xl leading-none">×</button>
        </div>
        <div className="px-6 py-5 space-y-6">
          <section>
            <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">Intent</h3>
            <blockquote className="border-l-4 border-blue-500 pl-3 text-sm text-gray-800">{intent}</blockquote>
          </section>
          <section>
            <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">Provenance</h3>
            <p className="text-sm">
              Created by <span className="text-blue-600">@{meta.owner_slack_id}</span><br/>
              <span className="text-gray-600">{new Date(meta.createdAt).toLocaleString('en-US')}</span><br/>
              Last refreshed <span className="text-gray-600">{new Date(meta.lastRefreshedAt).toLocaleString('en-US')}</span><br/>
              Spec version <span className="font-mono">v{spec?.version ?? 1}</span>
            </p>
          </section>
          <section>
            <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">Data sources</h3>
            <ul className="text-sm space-y-1">
              {Object.entries(sourcesCounts).map(([tool, n]) => (
                <li key={tool}><span className="font-mono text-blue-700">{tool}</span> <span className="text-gray-500">× {n}</span></li>
              ))}
            </ul>
          </section>
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs uppercase tracking-wide text-gray-500">Spec JSON</h3>
              <button onClick={async () => { await navigator.clipboard.writeText(specJson); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="text-xs text-blue-600 hover:underline">{copied ? 'Copied!' : 'Copy'}</button>
            </div>
            <pre className="text-xs bg-gray-50 border border-gray-200 rounded p-3 overflow-x-auto"><code>{specJson}</code></pre>
          </section>
          {canModify && (
            <section>
              <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">Actions</h3>
              <p className="text-xs text-gray-500">Use the bot to recompile or archive this report:</p>
              <ul className="text-xs mt-1 space-y-0.5">
                <li><code className="text-gray-700">recompile this report with: &lt;new intent&gt;</code></li>
                <li><code className="text-gray-700">archive this report</code></li>
              </ul>
            </section>
          )}
        </div>
      </aside>
    </>
  );
}
