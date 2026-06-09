import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { DevopsJobsRepo } from '../../devops/jobs-repo.js';
import type { GithubDispatcher } from '../../devops/github.js';
import type { FrontendRepo, DeployItem, Job } from '../../devops/types.js';
import { renderJobBlocks } from '../../devops/messages.js';
import { decideCommandChannel, channelFromView } from './channel-access.js';

export interface DeployCommandDeps {
  repo: DevopsJobsRepo;
  slack: WebClient;
  opsChannelId: string;
  dmUserIds: string[]; // users allowed to drive the bot from their DM with it
  gh: GithubDispatcher;
}

/**
 * Tags still worth offering for deploy: those committed AFTER the most recent
 * already-deployed tag for this repo (the high-water mark). Deploying a tag
 * ships every earlier commit too (they're bundled into it), so any tag at or
 * before the live commit is already in production — hide it.
 *
 * Ordered by the tag's COMMIT date, not the PR number: a PR can merge out of
 * numeric order (a low-numbered PR merged late), so a higher already-deployed
 * PR# must not hide a newer, lower-numbered tag. The deployed tag's commit date
 * is read from `tags` (matched by tag string). A failed deploy drops out of
 * listDeployJobs, so its tag reappears for a retry (the mark falls back). Tags
 * with no commit date are never hidden (shown by default).
 */
export function candidateDeployTags<T extends { tag: string; committedAt: string }>(
  tags: T[], deployJobs: Job[], repo: string,
): T[] {
  const deployed = new Set<string>();
  for (const j of deployJobs) {
    if (repo === 'porter' && j.spec.deployBackend?.tag) deployed.add(j.spec.deployBackend.tag);
    for (const f of j.spec.deployFrontends ?? []) if (f.repo === repo && f.tag) deployed.add(f.tag);
  }
  // Newest commit among already-deployed tags = what's live in prod.
  let cutoff = '';
  for (const t of tags) if (deployed.has(t.tag) && t.committedAt > cutoff) cutoff = t.committedAt;
  return tags.filter((t) => !cutoff || !t.committedAt || t.committedAt > cutoff);
}

/**
 * The deploy tag of the most recent prior backend (porter) deploy = what's live
 * in prod right now = the rollback target for a deploy about to start. `jobs` is
 * listDeployJobs output (newest-first, failed excluded), captured before the new
 * job exists, so the first one carrying a backend is the previous release.
 */
export function previousBackendDeployTag(jobs: Job[]): string | undefined {
  for (const j of jobs) {
    if (j.spec.deployBackend?.tag) return j.spec.deployBackend.tag;
  }
  return undefined;
}

function buttons(): unknown[] {
  const btn = (text: string, action_id: string) => ({ type: 'button', text: { type: 'plain_text', text }, action_id });
  return [
    { type: 'section', text: { type: 'mrkdwn', text: '*Deploy to production* — pick a type:' } },
    { type: 'actions', elements: [
      btn('Backend', 'deploy_backend'),
      btn('Frontend', 'deploy_frontend'),
      btn('Full stack', 'deploy_fullstack'),
    ] },
  ];
}

function tagSelect(blockId: string, actionId: string, label: string, optional = false) {
  return {
    type: 'input', block_id: blockId, optional,
    label: { type: 'plain_text', text: label },
    element: {
      type: 'external_select', action_id: actionId, min_query_length: 0,
      placeholder: { type: 'plain_text', text: 'Pick a deploy tag…' },
    },
  };
}

const FE: { repo: FrontendRepo; block: string; action: string }[] = [
  { repo: 'mantle', block: 'd_mantle_block', action: 'd_mantle_input' },
  { repo: 'core', block: 'd_core_block', action: 'd_core_input' },
  { repo: 'made', block: 'd_made_block', action: 'd_made_input' },
];

function feSelects() {
  return FE.map((f) => tagSelect(f.block, f.action, `${f.repo} — deploy tag (optional)`, true));
}

function e2eSelect() {
  const opt = (text: string, value: string) => ({ text: { type: 'plain_text' as const, text }, value });
  // Skip is the default for now (gate opt-in, not opt-out).
  const skip = opt('Skip (default)', 'skip');
  return {
    type: 'input', block_id: 'e2e_block', optional: false,
    label: { type: 'plain_text', text: 'E2E before deploy' },
    element: {
      type: 'static_select', action_id: 'e2e_input',
      initial_option: skip,
      options: [skip, opt('Smoke', 'smoke'), opt('Smoke + Regression', 'both')],
    },
  };
}

function backendModal() {
  return {
    type: 'modal' as const, callback_id: 'deploy_backend_submit',
    title: { type: 'plain_text' as const, text: 'Deploy backend' },
    submit: { type: 'plain_text' as const, text: 'Deploy' },
    blocks: [tagSelect('d_be_block', 'd_be_input', 'porter — deploy tag')],
  };
}
function frontendModal() {
  return {
    type: 'modal' as const, callback_id: 'deploy_frontend_submit',
    title: { type: 'plain_text' as const, text: 'Deploy frontend' },
    submit: { type: 'plain_text' as const, text: 'Deploy' },
    blocks: [...feSelects(), e2eSelect()],
  };
}
function fullstackModal() {
  return {
    type: 'modal' as const, callback_id: 'deploy_fullstack_submit',
    title: { type: 'plain_text' as const, text: 'Deploy full-stack' },
    submit: { type: 'plain_text' as const, text: 'Deploy' },
    blocks: [tagSelect('d_be_block', 'd_be_input', 'porter — deploy tag'), ...feSelects(), e2eSelect()],
  };
}

type ViewState = { state: { values: Record<string, Record<string, { selected_option?: { value: string } }>> } };
const sel = (v: ViewState, block: string, action: string) => v.state.values[block]?.[action]?.selected_option?.value ?? '';

function e2eSpec(v: ViewState): { e2e?: { scope: 'smoke' | 'both' } } {
  const c = sel(v, 'e2e_block', 'e2e_input');
  return c === 'smoke' || c === 'both' ? { e2e: { scope: c } } : {};
}

async function resolveDeployItem(gh: GithubDispatcher, repo: string, tag: string, isBackend: boolean): Promise<DeployItem | null> {
  const tags = await gh.listDeployTags(repo);
  const t = tags.find((x) => x.tag === tag);
  if (!t) return null;
  return { repo: isBackend ? undefined : (repo as FrontendRepo), tag: t.tag, sha: t.sha, pr: t.pr };
}

async function resolveFeItems(gh: GithubDispatcher, v: ViewState): Promise<DeployItem[]> {
  const picked = FE.map((f) => ({ repo: f.repo, tag: sel(v, f.block, f.action) })).filter((x) => x.tag);
  const items = await Promise.all(picked.map((p) => resolveDeployItem(gh, p.repo, p.tag, false)));
  return items.filter((x): x is DeployItem => x !== null);
}

async function postErr(deps: DeployCommandDeps, label: string, requestedBy: string, err: unknown, channel: string): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  await deps.slack.chat
    .postMessage({ channel, text: `✗ ${label} deploy — <@${requestedBy}>: ${msg}` })
    .catch(() => {});
}

async function createDeployAndPost(
  deps: DeployCommandDeps, target: 'backend' | 'frontend' | 'fullstack',
  spec: { deployBackend?: DeployItem; deployFrontends?: DeployItem[]; e2e?: { scope: 'smoke' | 'both' } }, requestedBy: string, channel: string,
) {
  // Snapshot the deploy tag currently live in prod as the rollback target, before
  // this job is created (so it's the PREVIOUS release, not this one).
  if (spec.deployBackend) {
    const prevDeployTag = previousBackendDeployTag(await deps.repo.listDeployJobs().catch(() => []));
    spec = { ...spec, deployBackend: { ...spec.deployBackend, prevDeployTag } };
  }
  const job = await deps.repo.create({ kind: 'deploy', target, spec, requestedBy, channelId: channel });
  const posted = await deps.slack.chat.postMessage({
    channel, text: '🚀 deploy starting…', blocks: renderJobBlocks(job) as any,
    unfurl_links: false, unfurl_media: false,
  });
  if (posted.ts) await deps.repo.update(job.id, { messageTs: posted.ts });
}

const PROD_DOMAIN: Record<string, string> = { mantle: 'www.gantri.com', core: 'admin.gantri.com', made: 'made.gantri.com' };
const REPO_NAME: Record<string, string> = { mantle: 'Marketplace', core: 'Factoryos', made: 'Madeos' };

function confirmBlocks(target: string, spec: { deployBackend?: DeployItem; deployFrontends?: DeployItem[]; e2e?: { scope: 'smoke' | 'both' } }, skipped: string[]): unknown[] {
  const lines: string[] = [];
  if (spec.deployBackend) lines.push(`• *Porter* \`${spec.deployBackend.tag}\` → api.gantri.com`);
  for (const f of spec.deployFrontends ?? []) {
    lines.push(`• *${REPO_NAME[f.repo ?? ''] ?? f.repo}* \`${f.tag}\` → ${PROD_DOMAIN[f.repo ?? ''] ?? 'production'}`);
  }
  lines.push(`🧪 *E2E gate:* ${spec.e2e ? (spec.e2e.scope === 'both' ? 'Smoke + Regression' : 'Smoke') + ' (runs before deploy)' : '_skipped_'}`);
  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `:warning: *Deploy to PRODUCTION?*\n${lines.join('\n')}` } },
  ];
  if (skipped.length) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `:rotating_light: *This also ships earlier un-deployed PRs* (they're bundled into your tag):\n${skipped.join('\n')}\n_Their changes go to production with this deploy — confirm that's intended._` },
    });
  }
  blocks.push({
    type: 'actions',
    elements: [
      { type: 'button', text: { type: 'plain_text', text: 'Deploy' }, style: 'primary', action_id: 'deploy_confirm', value: JSON.stringify({ target, spec }) },
      { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, action_id: 'deploy_cancel', value: 'x' },
    ],
  });
  return blocks;
}

/**
 * Per repo, tags being skipped over by this deploy: committed AFTER what's live
 * in prod (same commit-date cutoff as candidateDeployTags — anything at/before
 * the live commit is already shipped, bundled into a prior deploy) and BEFORE
 * the picked tag, and never themselves deployed.
 */
export async function findSkipped(deps: Pick<DeployCommandDeps, 'repo' | 'gh'>, spec: { deployBackend?: DeployItem; deployFrontends?: DeployItem[]; e2e?: { scope: 'smoke' | 'both' } }): Promise<string[]> {
  const jobs = await deps.repo.listDeployJobs();
  const usedFor = (repo: string): Set<string> => {
    const s = new Set<string>();
    for (const j of jobs) {
      if (repo === 'porter' && j.spec.deployBackend) s.add(j.spec.deployBackend.tag);
      for (const f of j.spec.deployFrontends ?? []) if (f.repo === repo) s.add(f.tag);
    }
    return s;
  };
  const out: string[] = [];
  const check = async (repo: string, name: string, pickedTag: string) => {
    const used = usedFor(repo);
    const tags = await deps.gh.listDeployTags(repo);
    const picked = tags.find((t) => t.tag === pickedTag);
    if (!picked?.committedAt) return;
    // Newest commit among already-deployed tags = what's live in prod.
    let cutoff = '';
    for (const t of tags) if (used.has(t.tag) && t.committedAt > cutoff) cutoff = t.committedAt;
    const skipped = tags
      .filter((t) =>
        t.committedAt && t.committedAt < picked.committedAt && t.committedAt > cutoff &&
        t.tag !== pickedTag && !used.has(t.tag))
      .map((t) => `\`${t.tag}\``);
    if (skipped.length) out.push(`*${name}*: ${skipped.join(', ')}`);
  };
  if (spec.deployBackend) await check('porter', 'Porter', spec.deployBackend.tag);
  for (const f of spec.deployFrontends ?? []) await check(f.repo ?? '', REPO_NAME[f.repo ?? ''] ?? (f.repo ?? ''), f.tag);
  return out;
}

async function postConfirm(
  deps: DeployCommandDeps, userId: string, target: string,
  spec: { deployBackend?: DeployItem; deployFrontends?: DeployItem[]; e2e?: { scope: 'smoke' | 'both' } },
  channel: string,
): Promise<void> {
  const skipped = await findSkipped(deps, spec).catch(() => [] as string[]);
  await deps.slack.chat
    .postEphemeral({ channel, user: userId, text: 'Confirm deploy', blocks: confirmBlocks(target, spec, skipped) as any })
    .catch(() => {});
}

export function registerDeployCommand(app: App, deps: DeployCommandDeps): void {
  app.command('/deploy', async ({ ack, body, respond }) => {
    await ack();
    const decision = decideCommandChannel('/deploy', deps.opsChannelId, deps.dmUserIds, body.channel_id, body.user_id);
    if (!decision.allowed) {
      await respond({ response_type: 'ephemeral', text: decision.message });
      return;
    }
    await respond({ response_type: 'ephemeral', blocks: buttons() as any });
  });

  const open = (build: () => object, _label: string) => async ({ ack, body, client, respond }: any) => {
    await ack();
    // Remove the picker buttons; the modal opening is feedback enough.
    await respond({ delete_original: true });
    // Carry the invoking channel (ops channel or a DM) through the modal so the
    // confirm + result post where the user is.
    const channel = body.channel?.id ?? deps.opsChannelId;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: { ...build(), private_metadata: JSON.stringify({ channel }) },
    });
  };
  app.action('deploy_backend', open(backendModal, 'Backend'));
  app.action('deploy_frontend', open(frontendModal, 'Frontend'));
  app.action('deploy_fullstack', open(fullstackModal, 'Full-stack'));

  // Tag pickers: matching deploy-* tags for each repo.
  const SOURCES: { action: string; repo: string }[] = [
    { action: 'd_be_input', repo: 'porter' },
    ...FE.map((f) => ({ action: f.action, repo: f.repo as string })),
  ];
  for (const src of SOURCES) {
    app.options(src.action, async ({ ack, payload }: any) => {
      const q = String(payload?.value ?? '').trim().toLowerCase();
      let opts: { text: { type: 'plain_text'; text: string }; value: string }[] = [];
      try {
        const tags = candidateDeployTags(
          await deps.gh.listDeployTags(src.repo),
          await deps.repo.listDeployJobs(),
          src.repo,
        );
        const matched = (q ? tags.filter((t) => t.tag.toLowerCase().includes(q)) : tags).slice(0, 15);
        opts = await Promise.all(matched.map(async (t) => {
          let branch = '';
          if (t.pr) {
            try { branch = (await deps.gh.resolveRef(src.repo, String(t.pr))).ref; } catch { /* keep empty */ }
          }
          const ctx = branch || (t.pr ? `#${t.pr}` : '');
          return {
            text: { type: 'plain_text' as const, text: `${t.tag}${ctx ? ` · ${ctx}` : ''}`.slice(0, 75) },
            value: t.tag,
          };
        }));
      } catch {
        // ignore — empty list
      }
      await ack({ options: opts });
    });
  }

  app.view('deploy_backend_submit', async ({ ack, body, view }) => {
    await ack();
    const channel = channelFromView(view as any, deps.opsChannelId);
    try {
      const item = await resolveDeployItem(deps.gh, 'porter', sel(view as any, 'd_be_block', 'd_be_input'), true);
      if (!item) throw new Error('tag not found');
      await postConfirm(deps, body.user.id, 'backend', { deployBackend: item }, channel);
    } catch (err) {
      await postErr(deps, 'Backend', body.user.id, err, channel);
    }
  });
  app.view('deploy_frontend_submit', async ({ ack, body, view }) => {
    await ack();
    const channel = channelFromView(view as any, deps.opsChannelId);
    try {
      const fes = await resolveFeItems(deps.gh, view as any);
      if (fes.length === 0) throw new Error('pick at least one frontend tag');
      await postConfirm(deps, body.user.id, 'frontend', { deployFrontends: fes, ...e2eSpec(view as any) }, channel);
    } catch (err) {
      await postErr(deps, 'Frontend', body.user.id, err, channel);
    }
  });
  app.view('deploy_fullstack_submit', async ({ ack, body, view }) => {
    await ack();
    const channel = channelFromView(view as any, deps.opsChannelId);
    try {
      const be = await resolveDeployItem(deps.gh, 'porter', sel(view as any, 'd_be_block', 'd_be_input'), true);
      if (!be) throw new Error('porter tag not found');
      const fes = await resolveFeItems(deps.gh, view as any);
      await postConfirm(deps, body.user.id, 'fullstack', { deployBackend: be, deployFrontends: fes, ...e2eSpec(view as any) }, channel);
    } catch (err) {
      await postErr(deps, 'Full-stack', body.user.id, err, channel);
    }
  });

  app.action('deploy_confirm', async ({ ack, body, action, respond }: any) => {
    await ack();
    await respond({ delete_original: true });
    const channel = body.channel?.id ?? deps.opsChannelId;
    try {
      const { target, spec } = JSON.parse(action.value as string);
      await createDeployAndPost(deps, target, spec, body.user.id, channel);
    } catch (err) {
      await postErr(deps, 'Deploy', body.user?.id ?? '', err, channel);
    }
  });
  app.action('deploy_cancel', async ({ ack, respond }: any) => {
    await ack();
    await respond({ replace_original: true, text: '🚫 Deploy cancelled.' });
  });

  // Retry after a deploy-phase failure (E2E already passed): clear the failed
  // frontends' progress and re-enter the deploy phase, skipping the gate.
  // Succeeded components keep their URLs and aren't redeployed.
  app.action('deploy_retry', async ({ ack, body, action }: any) => {
    await ack();
    try {
      const jobId = action.value as string;
      const job = await deps.repo.get(jobId);
      if (!job) throw new Error('job not found');
      const deployFrontends = (job.spec.deployFrontends ?? []).map((f: DeployItem) => {
        // E2E-blocked → re-run its gate + deploy from scratch.
        if (f.e2ePassed === false) {
          return {
            ...f, e2ePassed: undefined, e2eDispatched: undefined, e2eRunId: undefined, e2eQaseRunId: undefined,
            deploymentId: undefined, projectId: undefined, deploymentUrl: undefined, error: undefined,
          };
        }
        // Deploy-errored (gate already green) → just re-deploy.
        if (f.error) return { ...f, error: undefined, deploymentId: undefined, projectId: undefined, deploymentUrl: undefined };
        return f; // already live — keep it
      });
      const spec = { ...job.spec, deployFrontends };
      await deps.repo.update(jobId, { status: 'frontend_running', error: null, spec });
      if (job.messageTs) {
        await deps.slack.chat.update({
          channel: job.channelId, ts: job.messageTs, text: 'retrying deploy…',
          blocks: renderJobBlocks({ ...job, status: 'frontend_running', error: null, spec } as any) as any,
          unfurl_links: false, unfurl_media: false,
        } as any).catch(() => undefined);
      }
    } catch (err) {
      await postErr(deps, 'Retry', body.user?.id ?? '', err, body.channel?.id ?? deps.opsChannelId);
    }
  });

  // One-click backend rollback: re-promote the deploy tag that was live before
  // this deploy (captured at creation) through the same prod-deploy path. The
  // button carries a native Slack confirm, so the user has already confirmed.
  app.action('deploy_rollback', async ({ ack, body, action }: any) => {
    await ack();
    try {
      const jobId = action.value as string;
      const job = await deps.repo.get(jobId);
      const prev = job?.spec.deployBackend?.prevDeployTag;
      if (!job || !prev) {
        await deps.slack.chat
          .postEphemeral({
            channel: body.channel?.id ?? deps.opsChannelId, user: body.user?.id,
            text: 'No previous deploy recorded for this one — roll back manually with `/deploy` (or dispatch prod-deploy with the earlier tag).',
          })
          .catch(() => {});
        return;
      }
      // Rollback = a normal prod-deploy of the previous tag (resolves tag → its
      // staging-built image → prod). Fire-and-forget; the user watches the run.
      await deps.gh.dispatch('porter', 'prod-deploy.yml', 'master', { tag: prev, job_id: `rollback-${job.id}` });
      const channel = body.channel?.id ?? job.channelId;
      const ts = job.messageTs ?? body.container?.message_ts;
      await deps.slack.chat
        .postMessage({
          channel, thread_ts: ts ?? undefined,
          text: `↩️ <@${body.user?.id}> rolling production back to \`${prev}\` — watch: https://github.com/gantri/porter/actions/workflows/prod-deploy.yml`,
          unfurl_links: false, unfurl_media: false,
        })
        .catch(() => {});
    } catch (err) {
      await postErr(deps, 'Rollback', body.user?.id ?? '', err, body.channel?.id ?? deps.opsChannelId);
    }
  });
}
