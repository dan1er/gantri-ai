import type { Job, JobStatus } from './types.js';

const ICON: Record<JobStatus, string> = {
  pending: '⏳', e2e_running: '🧪', backend_running: '⏳', frontend_running: '⏳',
  ready: '✅', failed: '✗', torn_down: '🧹',
};

const REPO_DISPLAY: Record<string, string> = {
  mantle: 'Marketplace', core: 'Factoryos', made: 'Madeos',
};

function componentBlock(
  name: string, id: string, link: string | undefined, url: string | undefined,
  pending: string | undefined, deploymentUrl?: string,
): string {
  const lines = [`*${name}* (${id})`];
  if (link) lines.push(`<${link}|Source>`);
  lines.push(url ? `<${url}|Preview>` : `Preview _(${pending ?? 'pending'})_`);
  if (deploymentUrl) lines.push(`<${deploymentUrl}|Deployment>`);
  return lines.join('\n');
}

const PROD_URL: Record<string, string> = {
  mantle: 'https://www.gantri.com', core: 'https://admin.gantri.com', made: 'https://made.gantri.com',
};

function renderDeploy(job: Job): unknown[] {
  const icon = ICON[job.status];
  const header = `${icon} Deploy → production — requested by <@${job.requestedBy}>`;
  const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });
  const item = (name: string, tag: string, target: string, url: string | undefined, pending: string | undefined, inspector?: string) => {
    const status = !url && pending ? ` _(${pending})_` : '';
    const lines = [`<${url ?? target}|${name}> · \`${tag}\`${status}`];
    if (inspector) lines.push(`<${inspector}|Deployment>`);
    return lines.join('\n');
  };
  const blocks: unknown[] = [section(header)];
  if (job.spec.e2e && job.status === 'e2e_running') {
    const e = job.spec.e2e;
    const scope = e.scope === 'both' ? 'smoke + regression' : 'smoke';
    const run = e.runId
      ? `<https://github.com/gantri/gantri-e2e/actions/runs/${e.runId}|GitHub run>`
      : '_dispatching…_';
    const qase = e.qaseRunId
      ? `<https://app.qase.io/run/GANTRI/dashboard/${e.qaseRunId}|Qase>`
      : '<https://app.qase.io/run/GANTRI|Qase>';
    blocks.push(section(`🧪 E2E gate (${scope}) — ${run} · ${qase} — deploy waits for green`));
  }
  // Status-aware "pending" text: a component isn't "deploying" until its own
  // phase — during the E2E gate or while waiting on the backend it says so.
  const pendText = (url: string | undefined, deployStatus: JobStatus): string | undefined => {
    if (url) return undefined;
    if (job.status === deployStatus) return 'deploying…';
    if (job.status === 'e2e_running') return 'waiting for E2E';
    if (job.status === 'backend_running') return 'waiting for backend';
    return 'queued';
  };
  const b = job.spec.deployBackend;
  if (b) {
    blocks.push(section(item('Porter', b.tag, 'https://api.gantri.com', b.url, pendText(b.url, 'backend_running'))));
  }
  for (const f of job.spec.deployFrontends ?? []) {
    const name = REPO_DISPLAY[f.repo ?? ''] ?? f.repo ?? 'frontend';
    blocks.push(section(item(name, f.tag, PROD_URL[f.repo ?? ''] ?? 'production', f.url,
      pendText(f.url, 'frontend_running'), f.deploymentUrl)));
  }
  if (job.status === 'failed') {
    const e = job.spec.e2e;
    if (e?.passed === false && e.qaseRunId) {
      const ghRun = e.runId ? ` · <https://github.com/gantri/gantri-e2e/actions/runs/${e.runId}|GitHub run>` : '';
      blocks.push(section(`🚫 *Deploy blocked — E2E gate failed.* <https://app.qase.io/run/GANTRI/dashboard/${e.qaseRunId}|Check results in Qase>${ghRun}`));
    } else if (job.error) {
      blocks.push(section(`*Error:* ${job.error}`));
    }
  }
  if (blocks.length === 1) blocks.push(section('_starting…_'));
  return blocks;
}

export function renderJobBlocks(job: Job): unknown[] {
  if (job.kind === 'deploy') return renderDeploy(job);
  const icon = ICON[job.status];
  const titleTarget = job.target === 'fullstack' ? 'Full-stack' : job.target[0].toUpperCase() + job.target.slice(1);
  const header = `${icon} ${titleTarget} preview — requested by <@${job.requestedBy}>`;

  const showUrls = job.status === 'ready' || job.status === 'torn_down';
  const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });
  const tearDownButton = {
    type: 'actions',
    elements: [{
      type: 'button', text: { type: 'plain_text', text: 'Tear down' },
      style: 'danger', action_id: 'preview_teardown', value: job.id,
    }],
  };

  const blocks: unknown[] = [section(header)];
  if (job.spec.backend) {
    const b = job.spec.backend;
    blocks.push(section(componentBlock('Porter', b.slug, b.link, showUrls ? b.url : undefined,
      job.status === 'backend_running' ? 'provisioning…' : undefined)));
  }
  // Tear down sits right after Porter, before the frontends.
  if (job.status === 'ready') blocks.push(tearDownButton);
  for (const f of job.spec.frontends ?? []) {
    blocks.push(section(componentBlock(REPO_DISPLAY[f.repo] ?? f.repo, f.ref, f.link,
      showUrls ? f.url : undefined,
      job.status === 'frontend_running' && !f.url ? 'building…' : undefined,
      showUrls ? f.deploymentUrl : undefined)));
  }
  if (job.status === 'failed' && job.error) blocks.push(section(`*Error:* ${job.error}`));
  if (blocks.length === 1) blocks.push(section('_starting…_'));
  return blocks;
}
