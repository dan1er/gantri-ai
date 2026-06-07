import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { DevopsJobsRepo } from '../../devops/jobs-repo.js';
import type { GithubDispatcher } from '../../devops/github.js';
import type { JobTarget, FrontendRepo } from '../../devops/types.js';
import { slugFromRef } from '../../devops/slug.js';
import { renderJobBlocks } from '../../devops/messages.js';
import { logger } from '../../logger.js';

export function isOpsChannel(channelId: string, opsChannelId: string): boolean {
  return channelId === opsChannelId;
}

export function buildTypeButtons(): unknown[] {
  const btn = (text: string, action_id: string) => ({
    type: 'button', text: { type: 'plain_text', text }, action_id,
  });
  return [
    { type: 'section', text: { type: 'mrkdwn', text: '*Create a preview* — pick a type:' } },
    { type: 'actions', elements: [
      btn('Backend', 'preview_backend'),
      btn('Frontend', 'preview_frontend'),
      btn('Full stack', 'preview_fullstack'),
    ] },
  ];
}

function input(blockId: string, actionId: string, label: string, placeholder: string) {
  return {
    type: 'input', block_id: blockId, label: { type: 'plain_text', text: label },
    element: { type: 'plain_text_input', action_id: actionId, placeholder: { type: 'plain_text', text: placeholder } },
  };
}

function repoSelect(blockId: string, actionId: string) {
  const opt = (v: string) => ({ text: { type: 'plain_text', text: v }, value: v });
  return {
    type: 'input', block_id: blockId, label: { type: 'plain_text', text: 'Frontend repo' },
    element: { type: 'static_select', action_id: actionId, options: [opt('mantle'), opt('core'), opt('made')] },
  };
}

export function buildBackendModal() {
  return {
    type: 'modal' as const, callback_id: 'preview_backend_submit',
    title: { type: 'plain_text' as const, text: 'Backend preview' },
    submit: { type: 'plain_text' as const, text: 'Create' },
    blocks: [input('ref_block', 'ref_input', 'porter branch / PR# / URL', 'feat/as-2215-…')],
  };
}

export function buildFrontendModal() {
  return {
    type: 'modal' as const, callback_id: 'preview_frontend_submit',
    title: { type: 'plain_text' as const, text: 'Frontend preview' },
    submit: { type: 'plain_text' as const, text: 'Create' },
    blocks: [repoSelect('repo_block', 'repo_input'), input('ref_block', 'ref_input', 'branch / PR# / URL', 'feat/as-2300-…')],
  };
}

export function buildFullstackModal() {
  return {
    type: 'modal' as const, callback_id: 'preview_fullstack_submit',
    title: { type: 'plain_text' as const, text: 'Full-stack preview' },
    submit: { type: 'plain_text' as const, text: 'Create' },
    blocks: [
      input('be_ref_block', 'be_ref_input', 'porter branch / PR# / URL', 'feat/as-2215-…'),
      repoSelect('repo_block', 'repo_input'),
      input('fe_ref_block', 'fe_ref_input', 'frontend branch / PR# / URL', 'feat/as-2300-…'),
    ],
  };
}

type ViewState = { state: { values: Record<string, Record<string, { value?: string; selected_option?: { value: string } }>> } };
const val = (v: ViewState, block: string, action: string) =>
  v.state.values[block]?.[action]?.value ?? v.state.values[block]?.[action]?.selected_option?.value ?? '';

export function parseBackendSubmission(v: ViewState) {
  return { ref: val(v, 'ref_block', 'ref_input') };
}
export function parseFrontendSubmission(v: ViewState) {
  return { repo: val(v, 'repo_block', 'repo_input') as FrontendRepo, ref: val(v, 'ref_block', 'ref_input') };
}
export function parseFullstackSubmission(v: ViewState) {
  return {
    backendRef: val(v, 'be_ref_block', 'be_ref_input'),
    repo: val(v, 'repo_block', 'repo_input') as FrontendRepo,
    frontendRef: val(v, 'fe_ref_block', 'fe_ref_input'),
  };
}

export interface PreviewCommandDeps {
  repo: DevopsJobsRepo;
  slack: WebClient;
  opsChannelId: string;
  gh: GithubDispatcher;
}

async function createJobAndPost(
  deps: PreviewCommandDeps, target: JobTarget,
  spec: { backend?: { ref: string; slug: string }; frontend?: { repo: FrontendRepo; ref: string } },
  requestedBy: string,
) {
  const job = await deps.repo.create({ kind: 'preview', target, spec, requestedBy, channelId: deps.opsChannelId });
  const posted = await deps.slack.chat.postMessage({
    channel: deps.opsChannelId, text: `🛠️ ${target} preview starting…`, blocks: renderJobBlocks(job) as any,
  });
  if (posted.ts) await deps.repo.update(job.id, { messageTs: posted.ts });
}

async function postError(deps: PreviewCommandDeps, label: string, requestedBy: string, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  await deps.slack.chat
    .postMessage({ channel: deps.opsChannelId, text: `✗ ${label} preview — <@${requestedBy}>: ${msg}` })
    .catch(() => {});
}

export function registerPreviewCommand(app: App, deps: PreviewCommandDeps): void {
  app.command('/preview', async ({ ack, body, respond }) => {
    await ack();
    if (!isOpsChannel(body.channel_id, deps.opsChannelId)) {
      await respond({ response_type: 'ephemeral', text: `Run \`/preview\` in <#${deps.opsChannelId}>.` });
      return;
    }
    await respond({ response_type: 'ephemeral', blocks: buildTypeButtons() as any });
  });

  const openModal = (build: () => object, label: string) => async ({ ack, body, client, respond }: any) => {
    await ack();
    // Clear the ephemeral picker so the buttons can't be clicked again.
    await respond({ replace_original: true, text: `📝 Opening the ${label} preview form…` });
    await client.views.open({ trigger_id: body.trigger_id, view: build() });
  };
  app.action('preview_backend', openModal(buildBackendModal, 'Backend'));
  app.action('preview_frontend', openModal(buildFrontendModal, 'Frontend'));
  app.action('preview_fullstack', openModal(buildFullstackModal, 'Full-stack'));

  app.view('preview_backend_submit', async ({ ack, body, view }) => {
    await ack();
    const { ref } = parseBackendSubmission(view as any);
    try {
      const resolved = await deps.gh.resolveRef('porter', ref);
      await createJobAndPost(deps, 'backend', { backend: { ref: resolved, slug: slugFromRef(resolved) } }, body.user.id);
    } catch (err) {
      await postError(deps, 'Backend', body.user.id, err);
    }
  });
  app.view('preview_frontend_submit', async ({ ack, body, view }) => {
    await ack();
    const { repo, ref } = parseFrontendSubmission(view as any);
    try {
      const resolved = await deps.gh.resolveRef(repo, ref);
      await createJobAndPost(deps, 'frontend', { frontend: { repo, ref: resolved } }, body.user.id);
    } catch (err) {
      await postError(deps, 'Frontend', body.user.id, err);
    }
  });
  app.view('preview_fullstack_submit', async ({ ack, body, view }) => {
    await ack();
    const { backendRef, repo, frontendRef } = parseFullstackSubmission(view as any);
    try {
      const be = await deps.gh.resolveRef('porter', backendRef);
      const fe = await deps.gh.resolveRef(repo, frontendRef);
      await createJobAndPost(deps, 'fullstack', {
        backend: { ref: be, slug: slugFromRef(be) },
        frontend: { repo, ref: fe },
      }, body.user.id);
    } catch (err) {
      await postError(deps, 'Full-stack', body.user.id, err);
    }
  });

  app.action('preview_teardown', async ({ ack, body, action }: any) => {
    await ack();
    const jobId = action.value as string;
    await deps.repo.update(jobId, { status: 'torn_down' });
    // Refresh the message so the icon flips to 🧹 and the button disappears.
    const job = await deps.repo.get(jobId);
    if (job?.messageTs) {
      await deps.slack.chat
        .update({ channel: job.channelId, ts: job.messageTs, text: 'preview torn down', blocks: renderJobBlocks(job) as any })
        .catch(() => {});
    }
    logger.info({ jobId, by: body.user?.id }, 'devops preview torn down');
    // Phase 2: dispatch porter preview-teardown.yml here.
  });
}
