import type { Job, JobStatus } from './types.js';

const ICON: Record<JobStatus, string> = {
  pending: '⏳', backend_running: '⏳', frontend_running: '⏳',
  ready: '✅', failed: '✗', torn_down: '🧹',
};

function line(label: string, url?: string): string {
  return url ? `${label}: ${url}` : label;
}

export function renderJobBlocks(job: Job): unknown[] {
  const icon = ICON[job.status];
  const titleTarget = job.target === 'fullstack' ? 'Full-stack' : job.target[0].toUpperCase() + job.target.slice(1);
  const header = `${icon} ${titleTarget} preview — requested by <@${job.requestedBy}>`;

  const lines: string[] = [];
  if (job.spec.backend) {
    const b = job.spec.backend;
    lines.push(line(`*Backend* (${b.slug})`, job.status === 'ready' ? b.url : undefined) +
      (job.status === 'backend_running' ? ' — provisioning…' : ''));
  }
  if (job.spec.frontend) {
    const f = job.spec.frontend;
    lines.push(line(`*Frontend* (${f.repo})`, job.status === 'ready' ? f.url : undefined) +
      (job.status === 'frontend_running' ? ' — building…' : ''));
  }
  if (job.status === 'failed' && job.error) lines.push(`*Error:* ${job.error}`);

  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: header } },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') || '_starting…_' } },
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
