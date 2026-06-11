import type { Job, JobStatus, DeployItem, FrontendRepo } from './types.js';

const ICON: Record<JobStatus, string> = {
  pending: '⏳', e2e_running: '🧪', backend_running: '⏳', frontend_running: '⏳',
  ready: '✅', failed: '✗', torn_down: '🧹',
};

const E2E_FE_ENV: Record<FrontendRepo, string> = {
  mantle: 'MARKETPLACE_BASE_URL', core: 'FACTORYOS_BASE_URL', made: 'MADEOS_BASE_URL',
};

/**
 * For a ready preview that has a backend, a copy-paste block (gantri-e2e `.env`
 * + the tunnel command) to run the suite locally against THIS preview. Returns
 * null for frontend-only previews (no preview API/DB to target). Meant for the
 * preview thread, not the main message.
 */
export function e2eLocalConfig(job: Job): string | null {
  const b = job.spec.backend;
  if (job.kind !== 'preview' || job.status !== 'ready' || !b?.url) return null;
  const envLines = [`E2E_TARGET=preview`, `PORTER_API_URL=${b.url}`];
  for (const f of job.spec.frontends ?? []) {
    if (f.url) envLines.push(`${E2E_FE_ENV[f.repo]}=${f.url}`);
  }
  envLines.push(
    `PORTER_STAGING_DB_HOST=localhost`,
    `PORTER_STAGING_DB_USER=postgres`,
    `PORTER_STAGING_DB_PASSWORD=preview`,
    `PORTER_STAGING_DB_NAME=porter`,
    `PORTER_STAGING_DB_SSL=false`,
  );
  return [
    `🧪 *Run gantri-e2e locally against this preview*`,
    `1. Put this in \`gantri-e2e/.env\`:`,
    '```\n' + envLines.join('\n') + '\n```',
    `2. Open the DB tunnel (leave running): \`scripts/preview-db-tunnel.sh ${b.slug}\``,
    `3. Run a project, e.g. \`yarn test:marketplace\` (the suite ensures e2e fixtures on first run).`,
  ].join('\n');
}

/**
 * Hourly "is this still needed?" reminder for a ready backend preview, posted in
 * the preview's thread @-mentioning the requester. Backend previews run in EKS,
 * so an idle one costs money — offer a one-click tear down (or snooze).
 */
export function idlePingBlocks(job: Job, ageLabel: string): { text: string; blocks: unknown[] } {
  const slug = job.spec.backend?.slug ?? 'preview';
  const text = `⏰ <@${job.requestedBy}> your test environment \`${slug}\` has been running for ${ageLabel}. Still using it? Every open preview costs money while it's up — if you're done, hit *Tear down*.`;
  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text } },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Tear down' }, style: 'danger', action_id: 'preview_teardown', value: job.id },
        { type: 'button', text: { type: 'plain_text', text: 'Keep it (snooze 1h)' }, action_id: 'preview_keep', value: job.id },
      ],
    },
  ];
  return { text, blocks };
}

const REPO_DISPLAY: Record<string, string> = {
  mantle: 'Marketplace', core: 'Factoryos', made: 'Madeos',
};

/** "about an hour" / "5 hours" / "2 days" — for idle pings + teardown notes. */
export function humanAge(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return 'about an hour';
  if (h < 24) return h === 1 ? '1 hour' : `${h} hours`;
  const d = Math.floor(h / 24);
  return d === 1 ? '1 day' : `${d} days`;
}

function componentBlock(
  name: string, id: string, link: string | undefined, url: string | undefined,
  pending: string | undefined, deploymentUrl?: string, apiUrl?: string, autoBranch?: boolean,
): string {
  const lines = [`*${name}* (${id})`];
  if (link) lines.push(`<${link}|Source>`);
  lines.push(url ? `<${url}|Preview>` : `Preview _(${pending ?? 'pending'})_`);
  if (apiUrl) lines.push(`API → ${apiUrl}`); // which backend this frontend is wired to
  if (deploymentUrl) lines.push(`<${deploymentUrl}|Deployment>`);
  if (autoBranch) lines.push('_auto branch off trunk_'); // bot created this branch; deleted on teardown
  return lines.join('\n');
}

const ghRun = (id: number) => `https://github.com/gantri/gantri-e2e/actions/runs/${id}`;
const qaseRun = (id: number) => `https://app.qase.io/run/GANTRI/dashboard/${id}`;
// The deploy tag, clickable through to its GitHub tag page.
const tagLink = (repo: string, tag: string) => `<https://github.com/gantri/${repo}/releases/tag/${tag}|${tag}>`;

// One line per frontend, reflecting its OWN pipeline phase: testing → deploying
// → live, or blocked (E2E failed) / errored (deploy failed). Each frontend is
// independent, so a deploy message can show some live while others still test.
function frontendLine(f: DeployItem): string {
  const name = REPO_DISPLAY[f.repo ?? ''] ?? f.repo ?? 'frontend';
  const tag = tagLink(f.repo ?? '', f.tag);
  const head = `*${name}* · ${tag}`;
  if (f.url) return `<${f.url}|${name}> · ${tag} ✅ live`;
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

// On-demand porter CronJob run (kind = 'cron', the /cron command).
function renderCron(job: Job): unknown[] {
  const r = job.spec.cronRun;
  const icon = ICON[job.status];
  const headline =
    job.status === 'ready'
      ? 'Cron run completed'
      : job.status === 'failed'
        ? 'Cron run failed'
        : 'Cron run';
  const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });
  const envBadge = r?.environment === 'production' ? '🔴 *production*' : '🟢 staging';
  // Lead with the human label when porter annotates one; the raw k8s name
  // stays visible so logs/kubectl cross-referencing is one copy-paste away.
  const cronLabel = r?.display
    ? `*${r.display}* (\`${r?.cronjob ?? '?'}\`)`
    : `\`${r?.cronjob ?? '?'}\``;
  const blocks: unknown[] = [
    section(`${icon} *${headline}* — requested by <@${job.requestedBy}>`),
    section(`*Cron:* ${cronLabel}  ·  *Environment:* ${envBadge}`),
    ...(r?.description ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: r.description }] }] : []),
    section(
      job.runId
        ? `<https://github.com/gantri/porter/actions/runs/${job.runId}|Workflow run (logs in the summary)>`
        : '_dispatching…_',
    ),
  ];
  if (job.status === 'failed' && job.error) blocks.push(section(`*Error:* ${job.error}`));
  return blocks;
}

// On-demand suite run (kind = 'e2e', the /e2e command): options + live links.
function renderE2e(job: Job): unknown[] {
  const r = job.spec.e2eRun;
  const icon = ICON[job.status];
  const headline = job.status === 'ready' ? 'E2E run passed'
    : job.status === 'failed' ? 'E2E run failed'
    : 'E2E run';
  const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });
  const opts = [
    `*Project:* ${r?.project ?? '?'}`,
    `*Scope:* ${r?.scope ?? '?'}`,
    `*Areas:* ${r?.areas?.length ? r.areas.join(', ') : '(all areas)'}`,
    ...(r?.includeLongRunning ? ['*Long-running:* included'] : []),
    ...(r?.grepOverride ? [`*Grep:* \`${r.grepOverride}\``] : []),
  ].join('  ·  ');
  const links = [
    job.runId ? `<${ghRun(job.runId)}|GitHub run>` : '_dispatching…_',
    ...(r?.qaseRunId ? [`<${qaseRun(r.qaseRunId)}|Qase run>`] : []),
  ].join('  ·  ');
  const blocks: unknown[] = [
    section(`${icon} *${headline}* — requested by <@${job.requestedBy}>`),
    section(opts),
    section(links),
  ];
  if (job.status === 'failed' && job.error) blocks.push(section(`*Error:* ${job.error}`));
  return blocks;
}

// One compact fragment per deploy component for the main message — name
// (linked to prod once live) + a phase emoji; verbose tags/links live in the
// threaded details.
function deployFragment(name: string, item: DeployItem, backendDeploying: boolean): string {
  if (item.url) return `<${item.url}|${name}> ✅`;
  if (item.error) return `*${name}* ✗`;
  if (item.e2ePassed === false) {
    const link = item.e2eQaseRunId ? qaseRun(item.e2eQaseRunId) : item.e2eRunId ? ghRun(item.e2eRunId) : undefined;
    return link ? `*${name}* 🚫 <${link}|E2E failed>` : `*${name}* 🚫 E2E failed`;
  }
  if (item.e2ePassed === true || backendDeploying) return `*${name}* 🚀`;
  if (item.e2eRunId) return `*${name}* <${ghRun(item.e2eRunId)}|🧪 testing>`;
  return `*${name}* ⏳`;
}

function renderDeploy(job: Job): unknown[] {
  const icon = ICON[job.status];
  const headline = job.status === 'ready' ? 'Deployed to production'
    : job.status === 'failed' ? 'Deploy failed'
    : 'Deploy → production';
  const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });
  const blocks: unknown[] = [section(`${icon} *${headline}* — requested by <@${job.requestedBy}>`)];

  const b = job.spec.deployBackend;
  const frags: string[] = [];
  if (b) frags.push(deployFragment('Porter', b, job.status === 'backend_running'));
  let anyBlocked = false;
  for (const f of job.spec.deployFrontends ?? []) {
    frags.push(deployFragment(REPO_DISPLAY[f.repo ?? ''] ?? f.repo ?? 'frontend', f, false));
    if (f.error || f.e2ePassed === false) anyBlocked = true;
  }
  if (frags.length) blocks.push(section(frags.join('  ·  ')));

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

/**
 * The compact main-channel message: 1-2 lines + action buttons. Everything
 * verbose (per-component Source/API/Deployment links) goes to the thread via
 * renderJobDetailBlocks — the channel stays scannable.
 */
export function renderJobBlocks(job: Job): unknown[] {
  if (job.kind === 'deploy') return renderDeploy(job);
  if (job.kind === 'e2e') return renderE2e(job);
  if (job.kind === 'cron') return renderCron(job);
  const titleTarget = job.target === 'fullstack' ? 'Full-stack' : job.target[0].toUpperCase() + job.target.slice(1);
  // The preview's identifier: the backend slug, or the first frontend branch.
  const id = job.spec.backend?.slug ?? job.spec.frontends?.[0]?.ref;
  const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });

  // Torn down = terminal: the environment is gone. Two lines, no dead links;
  // the teardown handler appends who/when as context.
  if (job.status === 'torn_down') {
    return [
      section(`🧹 *${titleTarget} preview torn down*${id ? ` \`${id}\`` : ''} — requested by <@${job.requestedBy}>`),
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '_Environment deleted — preview URLs no longer work. Run `/preview` to spin up a fresh one._' }],
      },
    ];
  }

  const header = `${ICON[job.status]} *${titleTarget} preview*${id ? ` \`${id}\`` : ''} — requested by <@${job.requestedBy}>`;
  const blocks: unknown[] = [section(header)];

  // One links line: whatever is already up, pending markers for the rest.
  const links: string[] = [];
  const b = job.spec.backend;
  if (b) links.push(b.url ? `<${b.url}|API>` : '_API (provisioning…)_');
  for (const f of job.spec.frontends ?? []) {
    const name = REPO_DISPLAY[f.repo] ?? f.repo;
    links.push(f.url ? `<${f.url}|${name}>` : `_${name} (building…)_`);
  }
  if (links.length) blocks.push(section(links.join('  ·  ')));

  if (job.status === 'ready') {
    blocks.push({
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
    });
  }
  if (job.status === 'failed' && job.error) blocks.push(section(`*Error:* ${job.error}`));
  if (blocks.length === 1) blocks.push(section('_starting…_'));
  return blocks;
}

/**
 * The verbose per-component breakdown, posted to the job's THREAD when it
 * settles: branches, Source links, API URLs, deploy tags. Null when there is
 * nothing beyond what the compact main message already shows.
 */
export function renderJobDetailBlocks(job: Job): unknown[] | null {
  const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });

  if (job.kind === 'preview') {
    const blocks: unknown[] = [];
    if (job.spec.backend) {
      const b = job.spec.backend;
      blocks.push(section(componentBlock('Porter', b.slug, b.link, b.url, b.url ? undefined : 'provisioning…')));
    }
    const apiUrl = job.spec.backend?.url ? `${job.spec.backend.url}/api` : undefined;
    for (const f of job.spec.frontends ?? []) {
      blocks.push(section(componentBlock(REPO_DISPLAY[f.repo] ?? f.repo, f.ref, f.link,
        f.url,
        f.url ? undefined : 'building…',
        f.url ? f.deploymentUrl : undefined, apiUrl, f.autoBranch)));
    }
    return blocks.length ? blocks : null;
  }

  if (job.kind === 'deploy') {
    const blocks: unknown[] = [];
    const b = job.spec.deployBackend;
    if (b) {
      const head = b.url ? `<${b.url}|Porter>` : '*Porter*';
      const state = b.url ? ' ✅ live' : ' _(not deployed)_';
      blocks.push(section(`${head} · ${tagLink('porter', b.tag)}${state}`));
    }
    for (const f of job.spec.deployFrontends ?? []) blocks.push(section(frontendLine(f)));
    return blocks.length ? blocks : null;
  }

  return null; // e2e + cron main messages are already compact
}
