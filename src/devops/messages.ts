import type { Job, JobStatus, DeployItem } from './types.js';

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

const ghRun = (id: number) => `https://github.com/gantri/gantri-e2e/actions/runs/${id}`;
const qaseRun = (id: number) => `https://app.qase.io/run/GANTRI/dashboard/${id}`;

// One line per frontend, reflecting its OWN pipeline phase: testing → deploying
// → live, or blocked (E2E failed) / errored (deploy failed). Each frontend is
// independent, so a deploy message can show some live while others still test.
function frontendLine(f: DeployItem): string {
  const name = REPO_DISPLAY[f.repo ?? ''] ?? f.repo ?? 'frontend';
  const head = `*${name}* · \`${f.tag}\``;
  if (f.url) return `<${f.url}|${name}> · \`${f.tag}\` ✅ live`;
  if (f.error) return `${head} ✗ _${f.error}_`;
  if (f.e2ePassed === false) {
    const qase = f.e2eQaseRunId ? ` <${qaseRun(f.e2eQaseRunId)}|Check results>` : '';
    const gh = f.e2eRunId ? ` (<${ghRun(f.e2eRunId)}|run>)` : '';
    return `${head} 🚫 _E2E failed_ —${qase}${gh}`;
  }
  if (f.e2ePassed === true) return `${head} 🚀 _deploying…_`;
  const gh = f.e2eRunId ? `<${ghRun(f.e2eRunId)}|test run>` : '_dispatching…_';
  const qase = f.e2eQaseRunId ? ` · <${qaseRun(f.e2eQaseRunId)}|Qase>` : '';
  return `${head} 🧪 _testing_ — ${gh}${qase}`;
}

function renderDeploy(job: Job): unknown[] {
  const icon = ICON[job.status];
  const headline = job.status === 'ready' ? 'Deployed to production'
    : job.status === 'failed' ? 'Deploy failed'
    : 'Deploy → production';
  const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });
  const blocks: unknown[] = [section(`${icon} *${headline}* — requested by <@${job.requestedBy}>`)];

  const b = job.spec.deployBackend;
  if (b) {
    const head = b.url ? `<${b.url}|Porter>` : '*Porter*';
    const pend = b.url ? ' ✅ live' : job.status === 'backend_running' ? ' _(deploying…)_' : ' _(queued)_';
    blocks.push(section(`${head} · \`${b.tag}\`${pend}`));
  }

  let anyBlocked = false;
  for (const f of job.spec.deployFrontends ?? []) {
    blocks.push(section(frontendLine(f)));
    if (f.error || f.e2ePassed === false) anyBlocked = true;
  }

  // A frontend can fail its gate or its deploy without blocking the others;
  // offer a retry that re-attempts only the unfinished ones.
  if (job.status === 'failed' && anyBlocked) {
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button', text: { type: 'plain_text', text: '🔄 Retry failed' },
        style: 'primary', action_id: 'deploy_retry', value: job.id,
      }],
    });
  } else if (job.status === 'failed' && job.error) {
    blocks.push(section(`*Error:* ${job.error}`));
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
