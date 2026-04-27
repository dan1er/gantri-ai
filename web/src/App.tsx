import { useEffect, useState } from 'react';
import { fetchReport, type ReportPayload } from './lib/api.js';
import { KpiBlock } from './blocks/KpiBlock.js';
import { ChartBlock } from './blocks/ChartBlock.js';
import { TableBlock } from './blocks/TableBlock.js';
import { TextBlock } from './blocks/TextBlock.js';
import { DividerBlock } from './blocks/DividerBlock.js';
import { ReportHeader } from './components/ReportHeader.js';
import { ReportFooter } from './components/ReportFooter.js';
import { SpecDrawer } from './components/SpecDrawer.js';
import { ErrorState } from './components/ErrorState.js';
import { LoadingShimmer } from './components/LoadingShimmer.js';

function readSlugAndToken(): { slug: string; token: string } | null {
  const m = window.location.pathname.match(/^\/r\/([^/]+)\/?$/);
  if (!m) return null;
  const slug = m[1];
  const token = new URLSearchParams(window.location.search).get('t') ?? '';
  return { slug, token };
}

export function App() {
  const ctx = readSlugAndToken();
  const [data, setData] = useState<ReportPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(window.location.hash === '#spec');

  async function load(refresh: boolean) {
    if (!ctx) return;
    if (refresh) setRefreshing(true); else setLoading(true);
    try {
      const payload = await fetchReport(ctx.slug, ctx.token, refresh);
      setData(payload);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { void load(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => {
    const onHash = () => setDrawerOpen(window.location.hash === '#spec');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (!ctx) return <div className="p-10"><ErrorState title="Invalid URL" detail="Expected /r/<slug>" /></div>;
  if (err) return <div className="p-10"><ErrorState title="Couldn't load this report" detail={err} /></div>;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {data && (
        <ReportHeader
          title={data.meta.title}
          subtitle={data.meta.description ?? null}
          lastRefreshedAt={data.meta.lastRefreshedAt}
          onRefresh={() => load(true)}
          refreshing={refreshing}
          onShowSpec={() => { window.location.hash = '#spec'; setDrawerOpen(true); }}
        />
      )}
      {loading && <LoadingShimmer />}
      {data && (
        <main className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          {data.ui.map((block: any, i: number) => {
            const stepId = typeof block.value === 'string' ? block.value.split('.')[0]
              : typeof block.data === 'string' ? block.data.split('.')[0]
              : null;
            const stepError = stepId ? data.errors.find((e) => e.stepId === stepId) : null;
            if (stepError) {
              return <div key={i} className="col-span-4"><ErrorState title={`Couldn't load: ${stepError.tool}`} detail={stepError.message} /></div>;
            }
            switch (block.type) {
              case 'kpi': return <KpiBlock key={i} block={block} dataResults={data.dataResults} />;
              case 'chart': return <div key={i} className="col-span-4"><ChartBlock block={block} dataResults={data.dataResults} /></div>;
              case 'table': return <div key={i} className="col-span-4"><TableBlock block={block} dataResults={data.dataResults} /></div>;
              case 'text': return <div key={i} className="col-span-4"><TextBlock block={block} /></div>;
              case 'divider': return <div key={i} className="col-span-4"><DividerBlock /></div>;
              default: return null;
            }
          })}
        </main>
      )}
      {data && (
        <ReportFooter
          ownerSlackId={data.meta.owner_slack_id}
          createdAt={data.meta.createdAt}
          lastRefreshedAt={data.meta.lastRefreshedAt}
          intent={data.meta.intent}
          sources={data.meta.sources}
          onRefresh={() => load(true)}
          onReportFeedback={() => alert('To report a wrong number, DM the bot: feedback: <reason>')}
        />
      )}
      {data && (
        <SpecDrawer
          open={drawerOpen}
          onClose={() => { setDrawerOpen(false); if (window.location.hash === '#spec') history.replaceState(null, '', window.location.pathname + window.location.search); }}
          intent={data.meta.intent}
          spec={data.meta.spec}
          meta={{ owner_slack_id: data.meta.owner_slack_id, createdAt: data.meta.createdAt, lastRefreshedAt: data.meta.lastRefreshedAt, sources: data.meta.sources }}
          canModify={false}
        />
      )}
    </div>
  );
}
