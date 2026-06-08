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
  const headline = job.status === 'ready' ? 'Deployed to production'
    : job.status === 'failed' ? 'Deploy failed'
    : 'Deploy → production';
  const header = `${icon} *${headline}* — requested by <@${job.requestedBy}>`;
  const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });
  const item = (name: string, tag: string, target: string, url: string | undefined, pending: string | undefined, inspector?: string, error?: string) => {
    const status = error ? ` ✗ _${error}_` : !url && pending ? ` _(${pending})_` : '';
    const lines = [`<${url ?? target}|${name}> · \`${tag}\`${status}`];
    if (inspector && !error) lines.push(`<${inspector}|Deployment>`);
    return lines.join('\n');
  };
  const blocks: unknown[] = [section(header)];
  if (job.spec.e2e && job.status === 'e2e_running') {
    const e = job.spec.e2e;
    const scope = e.scope === 'both' ? 'smoke + regression' : 'smoke';
    const lines = (e.runs ?? []).map((r) => {
      const run = r.runId
        ? `<https://github.com/gantri/gantri-e2e/actions/runs/${r.runId}|GitHub run>`
        : '_dispatching…_';
      const qase = r.qaseRunId
        ? `<https://app.qase.io/run/GANTRI/dashboard/${r.qaseRunId}|Qase>`
        : '<https://app.qase.io/run/GANTRI|Qase>';
      return `• *${r.project}* — ${run} · ${qase}`;
    });
    blocks.push(section(`🧪 E2E gate (${scope}) — deploy waits for green\n${lines.join('\n')}`));
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
      pendText(f.url, 'frontend_running'), f.deploymentUrl, f.error)));
  }
  if (job.status === 'failed') {
    const e = job.spec.e2e;
    if (e?.passed === false) {
      const links = (e.runs ?? []).filter((r) => r.passed === false).map((r) => {
        const qase = r.qaseRunId
          ? `<https://app.qase.io/run/GANTRI/dashboard/${r.qaseRunId}|${r.project} results in Qase>`
          : `*${r.project}*`;
        const gh = r.runId ? ` · <https://github.com/gantri/gantri-e2e/actions/runs/${r.runId}|run>` : '';
        return `• ${qase}${gh}`;
      });
      blocks.push(section(`🚫 *Deploy blocked — E2E gate failed.* Check results:\n${links.join('\n')}`));
    } else {
      // Deploy-phase failure (E2E already passed) — show it + a Retry button
      // that re-attempts only the failed components, skipping the gate.
      if (job.error) blocks.push(section(`✗ *Deploy failed:* ${job.error}`));
      blocks.push({
        type: 'actions',
        elements: [{
          type: 'button', text: { type: 'plain_text', text: '🔄 Retry failed' },
          style: 'primary', action_id: 'deploy_retry', value: job.id,
        }],
      });
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
