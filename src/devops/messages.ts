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

export function renderJobBlocks(job: Job): unknown[] {
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
