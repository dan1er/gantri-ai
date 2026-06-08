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
  pending: string | undefined, deploymentUrl?: string, apiUrl?: string,
): string {
  const lines = [`*${name}* (${id})`];
  if (link) lines.push(`<${link}|Source>`);
  lines.push(url ? `<${url}|Preview>` : `Preview _(${pending ?? 'pending'})_`);
  if (apiUrl) lines.push(`API → ${apiUrl}`); // which backend this frontend is wired to
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

  // On a successful deploy, offer a one-click rollback of the backend by
  // re-promoting the deploy that was live before it. Native Slack confirm — it
  // touches prod.
  if (job.status === 'ready' && b?.prevDeployTag) {
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button', text: { type: 'plain_text', text: '↩️ Rollback backend' }, style: 'danger',
        action_id: 'deploy_rollback', value: job.id,
        confirm: {
          title: { type: 'plain_text', text: 'Roll back production?' },
          text: { type: 'mrkdwn', text: `Re-promote \`${b.prevDeployTag}\` to production — the deploy that was live before this one.` },
          confirm: { type: 'plain_text', text: 'Roll back' },
          deny: { type: 'plain_text', text: 'Cancel' },
        },
      }],
    });
  }
  if (blocks.length === 1) blocks.push(section('_starting…_'));
  return blocks;
}

export function renderJobBlocks(job: Job): unknown[] {
  if (job.kind === 'deploy') return renderDeploy(job);
  const icon = ICON[job.status];
  const titleTarget = job.target === 'fullstack' ? 'Full-stack' : job.target[0].toUpperCase() + job.target.slice(1);
  const header = `${icon} ${titleTarget} preview — requested by <@${job.requestedBy}>`;

  const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });
  const buttons = {
    type: 'actions',
    elements: [
      // Refresh re-provisions the backend at the branch HEAD (rebuild + migrations);
      // only meaningful when there's a backend preview.
      ...(job.spec.backend ? [{
        type: 'button', text: { type: 'plain_text', text: '🔄 Refresh backend' },
        action_id: 'preview_refresh', value: job.id,
      }] : []),
      {
        type: 'button', text: { type: 'plain_text', text: 'Tear down' },
        style: 'danger', action_id: 'preview_teardown', value: job.id,
      },
    ],
  };

  const blocks: unknown[] = [section(header)];
  if (job.spec.backend) {
    const b = job.spec.backend;
    blocks.push(section(componentBlock('Porter', b.slug, b.link, b.url, b.url ? undefined : 'provisioning…')));
  }
  // Action buttons sit right after Porter, before the frontends.
  if (job.status === 'ready') blocks.push(buttons);
  const apiUrl = job.spec.backend?.url ? `${job.spec.backend.url}/api` : undefined;
  for (const f of job.spec.frontends ?? []) {
    blocks.push(section(componentBlock(REPO_DISPLAY[f.repo] ?? f.repo, f.ref, f.link,
      f.url,
      f.url ? undefined : 'building…',
      f.url ? f.deploymentUrl : undefined, apiUrl)));
  }
  if (job.status === 'failed' && job.error) blocks.push(section(`*Error:* ${job.error}`));
  if (blocks.length === 1) blocks.push(section('_starting…_'));
  return blocks;
}
