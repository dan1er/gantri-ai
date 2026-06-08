import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { DevopsJobsRepo } from '../../devops/jobs-repo.js';
import type { GithubDispatcher } from '../../devops/github.js';
import type { FrontendRepo, DeployItem, Job } from '../../devops/types.js';
import { renderJobBlocks } from '../../devops/messages.js';

export interface DeployCommandDeps {
  repo: DevopsJobsRepo;
  slack: WebClient;
  opsChannelId: string;
  gh: GithubDispatcher;
}

function isOps(channelId: string, opsChannelId: string): boolean {
  return channelId === opsChannelId;
}

/**
 * Tags still worth offering for deploy: those whose PR# is above the highest
 * already-deployed PR# for this repo (the high-water mark). Deploying a tag
 * ships every earlier commit too (they're bundled into it), so any tag at or
 * below the mark is already in production — hide it. This keeps the picker to
 * genuine candidates (on staging, not yet promoted) and prevents re-deploying
 * an old tag, which would roll prod back. A failed deploy drops out of
 * listDeployJobs, so its tag reappears for a retry (the mark falls back).
 *
 * One rule for every repo: porter reads the backend item, frontends read their
 * own item. Tags without a parseable PR# are never hidden (shown by default).
 */
export function candidateDeployTags<T extends { pr: number | null }>(
  tags: T[], deployJobs: Job[], repo: string,
): T[] {
  let maxDeployedPr = 0;
  const bump = (it?: DeployItem): void => {
    if (it?.pr != null) maxDeployedPr = Math.max(maxDeployedPr, it.pr);
  };
  for (const j of deployJobs) {
    if (repo === 'porter') bump(j.spec.deployBackend);
    for (const f of j.spec.deployFrontends ?? []) if (f.repo === repo) bump(f);
  }
  return tags.filter((t) => (t.pr ?? Infinity) > maxDeployedPr);
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
  return {
    type: 'input', block_id: 'e2e_block', optional: false,
    label: { type: 'plain_text', text: 'E2E before deploy' },
    element: {
      type: 'static_select', action_id: 'e2e_input',
      initial_option: opt('Smoke (default)', 'smoke'),
      options: [opt('Smoke (default)', 'smoke'), opt('Smoke + Regression', 'both'), opt('Skip', 'skip')],
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

async function postErr(deps: DeployCommandDeps, label: string, requestedBy: string, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  await deps.slack.chat
    .postMessage({ channel: deps.opsChannelId, text: `✗ ${label} deploy — <@${requestedBy}>: ${msg}` })
    .catch(() => {});
}

async function createDeployAndPost(
  deps: DeployCommandDeps, target: 'backend' | 'frontend' | 'fullstack',
  spec: { deployBackend?: DeployItem; deployFrontends?: DeployItem[]; e2e?: { scope: 'smoke' | 'both' } }, requestedBy: string,
) {
  const job = await deps.repo.create({ kind: 'deploy', target, spec, requestedBy, channelId: deps.opsChannelId });
  const posted = await deps.slack.chat.postMessage({
    channel: deps.opsChannelId, text: '🚀 deploy starting…', blocks: renderJobBlocks(job) as any,
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

/** Per repo, earlier (lower PR#) tags that haven't been deployed and are being skipped. */
async function findSkipped(deps: DeployCommandDeps, spec: { deployBackend?: DeployItem; deployFrontends?: DeployItem[]; e2e?: { scope: 'smoke' | 'both' } }): Promise<string[]> {
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
  const check = async (repo: string, name: string, pickedTag: string, pickedPr: number | null) => {
    if (pickedPr == null) return;
    const used = usedFor(repo);
    const tags = await deps.gh.listDeployTags(repo);
    const skipped = tags
      .filter((t) => t.pr != null && t.pr < pickedPr && t.tag !== pickedTag && !used.has(t.tag))
      .map((t) => `\`${t.tag}\``);
    if (skipped.length) out.push(`*${name}*: ${skipped.join(', ')}`);
  };
  if (spec.deployBackend) await check('porter', 'Porter', spec.deployBackend.tag, spec.deployBackend.pr);
  for (const f of spec.deployFrontends ?? []) await check(f.repo ?? '', REPO_NAME[f.repo ?? ''] ?? (f.repo ?? ''), f.tag, f.pr);
  return out;
}

async function postConfirm(
  deps: DeployCommandDeps, userId: string, target: string,
  spec: { deployBackend?: DeployItem; deployFrontends?: DeployItem[]; e2e?: { scope: 'smoke' | 'both' } },
): Promise<void> {
  const skipped = await findSkipped(deps, spec).catch(() => [] as string[]);
  await deps.slack.chat
    .postEphemeral({ channel: deps.opsChannelId, user: userId, text: 'Confirm deploy', blocks: confirmBlocks(target, spec, skipped) as any })
    .catch(() => {});
}

export function registerDeployCommand(app: App, deps: DeployCommandDeps): void {
  app.command('/deploy', async ({ ack, body, respond }) => {
    await ack();
    if (!isOps(body.channel_id, deps.opsChannelId)) {
      await respond({ response_type: 'ephemeral', text: `Run \`/deploy\` in <#${deps.opsChannelId}>.` });
      return;
    }
    await respond({ response_type: 'ephemeral', blocks: buttons() as any });
  });

  const open = (build: () => object, _label: string) => async ({ ack, body, client, respond }: any) => {
    await ack();
    // Remove the picker buttons; the modal opening is feedback enough.
    await respond({ delete_original: true });
    await client.views.open({ trigger_id: body.trigger_id, view: build() });
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
    try {
      const item = await resolveDeployItem(deps.gh, 'porter', sel(view as any, 'd_be_block', 'd_be_input'), true);
      if (!item) throw new Error('tag not found');
      await postConfirm(deps, body.user.id, 'backend', { deployBackend: item });
    } catch (err) {
      await postErr(deps, 'Backend', body.user.id, err);
    }
  });
  app.view('deploy_frontend_submit', async ({ ack, body, view }) => {
    await ack();
    try {
      const fes = await resolveFeItems(deps.gh, view as any);
      if (fes.length === 0) throw new Error('pick at least one frontend tag');
      await postConfirm(deps, body.user.id, 'frontend', { deployFrontends: fes, ...e2eSpec(view as any) });
    } catch (err) {
      await postErr(deps, 'Frontend', body.user.id, err);
    }
  });
  app.view('deploy_fullstack_submit', async ({ ack, body, view }) => {
    await ack();
    try {
      const be = await resolveDeployItem(deps.gh, 'porter', sel(view as any, 'd_be_block', 'd_be_input'), true);
      if (!be) throw new Error('porter tag not found');
      const fes = await resolveFeItems(deps.gh, view as any);
      await postConfirm(deps, body.user.id, 'fullstack', { deployBackend: be, deployFrontends: fes, ...e2eSpec(view as any) });
    } catch (err) {
      await postErr(deps, 'Full-stack', body.user.id, err);
    }
  });

  app.action('deploy_confirm', async ({ ack, body, action, respond }: any) => {
    await ack();
    await respond({ delete_original: true });
    try {
      const { target, spec } = JSON.parse(action.value as string);
      await createDeployAndPost(deps, target, spec, body.user.id);
    } catch (err) {
      await postErr(deps, 'Deploy', body.user?.id ?? '', err);
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
      await postErr(deps, 'Retry', body.user?.id ?? '', err);
    }
  });

  // One-click backend rollback: redeploy the release that was live before this
  // deploy (captured at dispatch). The button carries a native Slack confirm, so
  // by the time we get here the user has already confirmed.
  app.action('deploy_rollback', async ({ ack, body, action }: any) => {
    await ack();
    try {
      const jobId = action.value as string;
      const job = await deps.repo.get(jobId);
      const prev = job?.spec.deployBackend?.prevRelease;
      if (!job || !prev) {
        await deps.slack.chat
          .postEphemeral({
            channel: body.channel?.id ?? deps.opsChannelId, user: body.user?.id,
            text: 'No previous release recorded for this deploy — roll back manually via Actions → Rollback Production.',
          })
          .catch(() => {});
        return;
      }
      // rollback-production.yml gates on confirm === 'rollback'.
      await deps.gh.dispatch('porter', 'rollback-production.yml', 'master', { release_tag: prev, confirm: 'rollback' });
      const channel = body.channel?.id ?? job.channelId;
      const ts = job.messageTs ?? body.container?.message_ts;
      await deps.slack.chat
        .postMessage({
          channel, thread_ts: ts ?? undefined,
          text: `↩️ <@${body.user?.id}> dispatched a production rollback to \`${prev}\` — watch: https://github.com/gantri/porter/actions/workflows/rollback-production.yml`,
          unfurl_links: false, unfurl_media: false,
        })
        .catch(() => {});
    } catch (err) {
      await postErr(deps, 'Rollback', body.user?.id ?? '', err);
    }
  });
}
