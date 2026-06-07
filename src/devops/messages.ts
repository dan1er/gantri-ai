import type { Job, JobStatus } from './types.js';

const ICON: Record<JobStatus, string> = {
  pending: '⏳', backend_running: '⏳', frontend_running: '⏳',
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
  if (link) lines.push(`Source: ${link}`);
  lines.push(`Preview: ${url ?? (pending ? `_${pending}_` : '_pending_')}`);
  if (deploymentUrl) lines.push(`Deployment: ${deploymentUrl}`);
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
    const lines = [`*${name}* · \`${tag}\``];
    lines.push(`Production: ${url ?? `${target}${pending ? ` _(${pending})_` : ''}`}`);
    if (inspector) lines.push(`Deployment: ${inspector}`);
    return lines.join('\n');
  };
  const blocks: unknown[] = [section(header)];
  const b = job.spec.deployBackend;
  if (b) {
    blocks.push(section(item('Porter', b.tag, 'https://api.gantri.com', b.url,
      job.status === 'backend_running' ? 'deploying…' : undefined)));
  }
  for (const f of job.spec.deployFrontends ?? []) {
    const name = REPO_DISPLAY[f.repo ?? ''] ?? f.repo ?? 'frontend';
    blocks.push(section(item(name, f.tag, PROD_URL[f.repo ?? ''] ?? 'production', f.url,
      f.url ? undefined : 'deploying…', f.deploymentUrl)));
  }
  if (job.status === 'failed' && job.error) blocks.push(section(`*Error:* ${job.error}`));
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
