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

function input(blockId: string, actionId: string, label: string, placeholder: string, optional = false) {
  return {
    type: 'input', block_id: blockId, optional, label: { type: 'plain_text', text: label },
    element: { type: 'plain_text_input', action_id: actionId, placeholder: { type: 'plain_text', text: placeholder } },
  };
}

// One optional ref input per frontend app; the user fills the ones they want.
const FRONTEND_FIELDS: { repo: FrontendRepo; block: string; action: string }[] = [
  { repo: 'mantle', block: 'mantle_ref_block', action: 'mantle_ref_input' },
  { repo: 'core', block: 'core_ref_block', action: 'core_ref_input' },
  { repo: 'made', block: 'made_ref_block', action: 'made_ref_input' },
];

function frontendInputs() {
  return FRONTEND_FIELDS.map((fld) =>
    input(fld.block, fld.action, `${fld.repo} — branch / PR# / URL (optional)`, 'feat/as-2300-…', true));
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
    blocks: frontendInputs(),
  };
}

export function buildFullstackModal() {
  return {
    type: 'modal' as const, callback_id: 'preview_fullstack_submit',
    title: { type: 'plain_text' as const, text: 'Full-stack preview' },
    submit: { type: 'plain_text' as const, text: 'Create' },
    blocks: [
      input('be_ref_block', 'be_ref_input', 'porter branch / PR# / URL', 'feat/as-2215-…'),
      ...frontendInputs(),
    ],
  };
}

type ViewState = { state: { values: Record<string, Record<string, { value?: string; selected_option?: { value: string } }>> } };
const val = (v: ViewState, block: string, action: string) =>
  v.state.values[block]?.[action]?.value ?? v.state.values[block]?.[action]?.selected_option?.value ?? '';

export function parseBackendSubmission(v: ViewState) {
  return { ref: val(v, 'ref_block', 'ref_input') };
}
export function parseFrontendSubmission(v: ViewState): { repo: FrontendRepo; ref: string }[] {
  return FRONTEND_FIELDS
    .map((fld) => ({ repo: fld.repo, ref: val(v, fld.block, fld.action).trim() }))
    .filter((x) => x.ref.length > 0);
}
export function parseFullstackSubmission(v: ViewState) {
  return { backendRef: val(v, 'be_ref_block', 'be_ref_input'), frontends: parseFrontendSubmission(v) };
}

export interface PreviewCommandDeps {
  repo: DevopsJobsRepo;
  slack: WebClient;
  opsChannelId: string;
  gh: GithubDispatcher;
}

function jobKey(spec: { backend?: { slug: string }; frontends?: { repo: string; ref: string }[] }): string {
  const parts: string[] = [];
  if (spec.backend) parts.push(`b:${spec.backend.slug}`);
  for (const f of [...(spec.frontends ?? [])].sort((a, b) => `${a.repo}:${a.ref}`.localeCompare(`${b.repo}:${b.ref}`))) {
    parts.push(`f:${f.repo}:${f.ref}`);
  }
  return parts.join('|');
}

async function createJobAndPost(
  deps: PreviewCommandDeps, target: JobTarget,
  spec: { backend?: { ref: string; slug: string; link?: string }; frontends?: { repo: FrontendRepo; ref: string; link?: string }[] },
  requestedBy: string,
) {
  // Reuse an existing preview (anything not failed/torn down) for the same target + identity.
  const key = jobKey(spec);
  const existing = (await deps.repo.listReusable()).find((j) => j.target === target && jobKey(j.spec) === key);
  if (existing) {
    const url = existing.spec.backend?.url ?? existing.spec.frontends?.[0]?.url;
    await deps.slack.chat
      .postMessage({
        channel: deps.opsChannelId,
        text: `↻ <@${requestedBy}> reusing the active *${target}* preview for \`${key}\` (${existing.status})${url ? `: ${url}` : ''}.`,
      })
      .catch(() => {});
    return;
  }
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

async function resolveFrontends(
  deps: PreviewCommandDeps, inputs: { repo: FrontendRepo; ref: string }[],
): Promise<{ repo: FrontendRepo; ref: string; link: string }[]> {
  return Promise.all(inputs.map(async (f) => {
    const { ref, link } = await deps.gh.resolveRef(f.repo, f.ref);
    return { repo: f.repo, ref, link };
  }));
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
      const { ref: resolved, link } = await deps.gh.resolveRef('porter', ref);
      await createJobAndPost(deps, 'backend', { backend: { ref: resolved, slug: slugFromRef(resolved), link } }, body.user.id);
    } catch (err) {
      await postError(deps, 'Backend', body.user.id, err);
    }
  });
  app.view('preview_frontend_submit', async ({ ack, body, view }) => {
    await ack();
    const inputs = parseFrontendSubmission(view as any);
    try {
      if (inputs.length === 0) throw new Error('pick at least one frontend');
      const frontends = await resolveFrontends(deps, inputs);
      await createJobAndPost(deps, 'frontend', { frontends }, body.user.id);
    } catch (err) {
      await postError(deps, 'Frontend', body.user.id, err);
    }
  });
  app.view('preview_fullstack_submit', async ({ ack, body, view }) => {
    await ack();
    const { backendRef, frontends: feInputs } = parseFullstackSubmission(view as any);
    try {
      const be = await deps.gh.resolveRef('porter', backendRef);
      const frontends = await resolveFrontends(deps, feInputs);
      await createJobAndPost(deps, 'fullstack', {
        backend: { ref: be.ref, slug: slugFromRef(be.ref), link: be.link },
        frontends,
      }, body.user.id);
    } catch (err) {
      await postError(deps, 'Full-stack', body.user.id, err);
    }
  });

  app.action('preview_teardown', async ({ ack, body, action }: any) => {
    await ack();
    const jobId = action.value as string;
    await deps.repo.update(jobId, { status: 'torn_down' });
    const job = await deps.repo.get(jobId);
    // Dispatch the (dumb) porter teardown workflow for backend previews.
    const slug = job?.spec.backend?.slug;
    if (slug) {
      await deps.gh
        .dispatch('porter', 'preview-teardown.yml', 'master', { slug, job_id: jobId })
        .catch((err) => logger.warn({ jobId, err: String((err as Error)?.message ?? err) }, 'teardown dispatch failed'));
    }
    // Leave the original message intact; post a separate note about what happened.
    const what = slug ? `\`${slug}\`` : (job?.target ?? 'preview');
    await deps.slack.chat
      .postMessage({
        channel: deps.opsChannelId,
        text: `🧹 <@${body.user?.id}> tore down the ${job?.target ?? ''} preview ${what}.`,
      })
      .catch(() => {});
    logger.info({ jobId, by: body.user?.id }, 'devops preview torn down');
  });
}
