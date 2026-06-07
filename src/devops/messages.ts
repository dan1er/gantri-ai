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
  const sections: string[] = [];
  if (job.spec.backend) {
    const b = job.spec.backend;
    sections.push(componentBlock('Porter', b.slug, b.link, showUrls ? b.url : undefined,
      job.status === 'backend_running' ? 'provisioning…' : undefined));
  }
  for (const f of job.spec.frontends ?? []) {
    sections.push(componentBlock(REPO_DISPLAY[f.repo] ?? f.repo, f.ref, f.link,
      showUrls ? f.url : undefined,
      job.status === 'frontend_running' && !f.url ? 'building…' : undefined,
      showUrls ? f.deploymentUrl : undefined));
  }
  if (job.status === 'failed' && job.error) sections.push(`*Error:* ${job.error}`);

  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: header } },
    { type: 'section', text: { type: 'mrkdwn', text: sections.join('\n\n') || '_starting…_' } },
  ];

  if (job.status === 'ready') {
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Tear down' },
        style: 'danger',
        action_id: 'preview_teardown',
        value: job.id,
      }],
    });
  }
  return blocks;
}
