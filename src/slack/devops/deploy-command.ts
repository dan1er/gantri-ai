import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { DevopsJobsRepo } from '../../devops/jobs-repo.js';
import type { GithubDispatcher } from '../../devops/github.js';
import type { FrontendRepo, DeployItem } from '../../devops/types.js';
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
    blocks: feSelects(),
  };
}
function fullstackModal() {
  return {
    type: 'modal' as const, callback_id: 'deploy_fullstack_submit',
    title: { type: 'plain_text' as const, text: 'Deploy full-stack' },
    submit: { type: 'plain_text' as const, text: 'Deploy' },
    blocks: [tagSelect('d_be_block', 'd_be_input', 'porter — deploy tag'), ...feSelects()],
  };
}

type ViewState = { state: { values: Record<string, Record<string, { selected_option?: { value: string } }>> } };
const sel = (v: ViewState, block: string, action: string) => v.state.values[block]?.[action]?.selected_option?.value ?? '';

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
  spec: { deployBackend?: DeployItem; deployFrontends?: DeployItem[] }, requestedBy: string,
) {
  const job = await deps.repo.create({ kind: 'deploy', target, spec, requestedBy, channelId: deps.opsChannelId });
  const posted = await deps.slack.chat.postMessage({
    channel: deps.opsChannelId, text: '🚀 deploy starting…', blocks: renderJobBlocks(job) as any,
  });
  if (posted.ts) await deps.repo.update(job.id, { messageTs: posted.ts });
}

const PROD_DOMAIN: Record<string, string> = { mantle: 'www.gantri.com', core: 'admin.gantri.com', made: 'made.gantri.com' };
const REPO_NAME: Record<string, string> = { mantle: 'Marketplace', core: 'Factoryos', made: 'Madeos' };

function confirmBlocks(target: string, spec: { deployBackend?: DeployItem; deployFrontends?: DeployItem[] }): unknown[] {
  const lines: string[] = [];
  if (spec.deployBackend) lines.push(`• *Porter* \`${spec.deployBackend.tag}\` → api.gantri.com`);
  for (const f of spec.deployFrontends ?? []) {
    lines.push(`• *${REPO_NAME[f.repo ?? ''] ?? f.repo}* \`${f.tag}\` → ${PROD_DOMAIN[f.repo ?? ''] ?? 'production'}`);
  }
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `:warning: *Deploy to PRODUCTION?*\n${lines.join('\n')}` } },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Deploy' }, style: 'primary', action_id: 'deploy_confirm', value: JSON.stringify({ target, spec }) },
        { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, action_id: 'deploy_cancel', value: 'x' },
      ],
    },
  ];
}

async function postConfirm(
  deps: DeployCommandDeps, userId: string, target: string,
  spec: { deployBackend?: DeployItem; deployFrontends?: DeployItem[] },
): Promise<void> {
  await deps.slack.chat
    .postEphemeral({ channel: deps.opsChannelId, user: userId, text: 'Confirm deploy', blocks: confirmBlocks(target, spec) as any })
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

  const open = (build: () => object, label: string) => async ({ ack, body, client, respond }: any) => {
    await ack();
    await respond({ replace_original: true, text: `🚀 Opening the ${label} deploy form…` });
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
        const tags = await deps.gh.listDeployTags(src.repo);
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
      await postConfirm(deps, body.user.id, 'frontend', { deployFrontends: fes });
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
      await postConfirm(deps, body.user.id, 'fullstack', { deployBackend: be, deployFrontends: fes });
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
}
