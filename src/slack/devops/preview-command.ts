import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { DevopsJobsRepo, UpdateJobInput } from '../../devops/jobs-repo.js';
import type { GithubDispatcher } from '../../devops/github.js';
import type { VercelReader } from '../../devops/provisioner.js';
import type { JobTarget, FrontendRepo, JobSpec } from '../../devops/types.js';
import { slugFromRef } from '../../devops/slug.js';
import { renderJobBlocks } from '../../devops/messages.js';
import { decideCommandChannel, channelFromView } from './channel-access.js';
import { logger } from '../../logger.js';

export function isOpsChannel(channelId: string, opsChannelId: string): boolean {
  return channelId === opsChannelId;
}

// Sentinel option value for "I have no frontend changes — let the bot create a
// throwaway branch off the frontend's trunk and wire it to the backend preview".
// Only offered in the full-stack modal (a preview-target env override never
// applies to the production trunk, so we need a real non-trunk branch).
export const AUTO_TRUNK = '__auto_trunk__';

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

// An open-PR typeahead per repo; the option-load handler also offers a "use
// what you typed" entry so a branch / PR not in the list still works.
function prSelect(blockId: string, actionId: string, label: string, optional = false) {
  return {
    type: 'input', block_id: blockId, optional,
    label: { type: 'plain_text', text: label },
    element: {
      type: 'external_select', action_id: actionId, min_query_length: 0,
      placeholder: { type: 'plain_text', text: 'Pick an open PR or type a branch…' },
    },
  };
}

const FRONTEND_FIELDS: { repo: FrontendRepo; block: string; action: string }[] = [
  { repo: 'mantle', block: 'mantle_ref_block', action: 'mantle_ref_input' },
  { repo: 'core', block: 'core_ref_block', action: 'core_ref_input' },
  { repo: 'made', block: 'made_ref_block', action: 'made_ref_input' },
];

function frontendInputs() {
  return FRONTEND_FIELDS.map((fld) => prSelect(fld.block, fld.action, `${fld.repo} — PR or branch (optional)`, true));
}

export function buildBackendModal() {
  return {
    type: 'modal' as const, callback_id: 'preview_backend_submit',
    title: { type: 'plain_text' as const, text: 'Backend preview' },
    submit: { type: 'plain_text' as const, text: 'Create' },
    blocks: [prSelect('ref_block', 'ref_input', 'porter — PR or branch')],
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
      prSelect('be_ref_block', 'be_ref_input', 'porter — PR or branch'),
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
  dmUserIds: string[]; // users allowed to drive the bot from their DM with it
  gh: GithubDispatcher;
  vercel?: VercelReader;
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
  spec: { backend?: { ref: string; slug: string; link?: string }; frontends?: { repo: FrontendRepo; ref: string; link?: string; autoBranch?: boolean }[] },
  requestedBy: string, channel: string,
) {
  // Reuse an existing preview (anything not failed/torn down) for the same target + identity.
  const key = jobKey(spec);
  const existing = (await deps.repo.listReusable()).find((j) => j.target === target && jobKey(j.spec) === key);
  if (existing) {
    const url = existing.spec.backend?.url ?? existing.spec.frontends?.[0]?.url;
    const permalink = existing.messageTs
      ? await deps.slack.chat
          .getPermalink({ channel: existing.channelId, message_ts: existing.messageTs })
          .then((r) => r.permalink as string | undefined)
          .catch(() => undefined)
      : undefined;
    const ref = permalink ? `<${permalink}|the existing preview>` : 'the existing preview';
    const blocks: unknown[] = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `↻ <@${requestedBy}> that *${target}* preview is already up (${existing.status}) — see ${ref}${url ? `: ${url}` : ''}.` },
      },
    ];
    if (existing.status === 'ready') {
      blocks.push({
        type: 'actions',
        elements: [
          // Same buttons as the live job message: refresh the backend in place
          // (when there is one) or tear the whole preview down.
          ...(existing.spec.backend ? [{
            type: 'button', text: { type: 'plain_text', text: '🔄 Refresh backend' },
            action_id: 'preview_refresh', value: existing.id,
          }] : []),
          {
            type: 'button', text: { type: 'plain_text', text: 'Tear down' },
            style: 'danger', action_id: 'preview_teardown', value: existing.id,
          },
        ],
      });
    }
    await deps.slack.chat
      .postMessage({ channel, text: 'reusing existing preview', blocks: blocks as any })
      .catch(() => {});
    return;
  }
  const job = await deps.repo.create({ kind: 'preview', target, spec, requestedBy, channelId: channel });
  const posted = await deps.slack.chat.postMessage({
    channel, text: `🛠️ ${target} preview starting…`, blocks: renderJobBlocks(job) as any,
    unfurl_links: false, unfurl_media: false,
  });
  if (posted.ts) await deps.repo.update(job.id, { messageTs: posted.ts });
}

async function postError(deps: PreviewCommandDeps, label: string, requestedBy: string, err: unknown, channel: string): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  await deps.slack.chat
    .postMessage({ channel, text: `✗ ${label} preview — <@${requestedBy}>: ${msg}` })
    .catch(() => {});
}

async function resolveFrontends(
  deps: PreviewCommandDeps, inputs: { repo: FrontendRepo; ref: string; autoBranch?: boolean }[],
): Promise<{ repo: FrontendRepo; ref: string; link: string; autoBranch?: boolean }[]> {
  return Promise.all(inputs.map(async (f) => {
    const { ref, link } = await deps.gh.resolveRef(f.repo, f.ref);
    return { repo: f.repo, ref, link, ...(f.autoBranch ? { autoBranch: true } : {}) };
  }));
}

// Expand any "auto-trunk" frontend pick into a real throwaway branch created off
// that frontend's trunk, named after the backend slug so it's unique + traceable.
async function expandAutoFrontends(
  deps: PreviewCommandDeps, inputs: { repo: FrontendRepo; ref: string }[], slug: string,
): Promise<{ repo: FrontendRepo; ref: string; autoBranch?: boolean }[]> {
  return Promise.all(inputs.map(async (f) => {
    if (f.ref !== AUTO_TRUNK) return { repo: f.repo, ref: f.ref };
    const branch = `preview-${slug}`;
    await deps.gh.ensureBranch(f.repo, branch);
    return { repo: f.repo, ref: branch, autoBranch: true };
  }));
}

export function registerPreviewCommand(app: App, deps: PreviewCommandDeps): void {
  app.command('/preview', async ({ ack, body, respond }) => {
    await ack();
    const decision = decideCommandChannel('/preview', deps.opsChannelId, deps.dmUserIds, body.channel_id, body.user_id);
    if (!decision.allowed) {
      await respond({ response_type: 'ephemeral', text: decision.message });
      return;
    }
    await respond({ response_type: 'ephemeral', blocks: buildTypeButtons() as any });
  });

  const openModal = (build: () => object, _label: string) => async ({ ack, body, client, respond }: any) => {
    await ack();
    // Remove the picker buttons; the modal opening is feedback enough.
    await respond({ delete_original: true });
    // Carry the channel the command was invoked from (ops channel or a DM) so the
    // result posts where the user is, not always the ops channel.
    const channel = body.channel?.id ?? deps.opsChannelId;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: { ...build(), private_metadata: JSON.stringify({ channel }) },
    });
  };
  app.action('preview_backend', openModal(buildBackendModal, 'Backend'));
  app.action('preview_frontend', openModal(buildFrontendModal, 'Frontend'));
  app.action('preview_fullstack', openModal(buildFullstackModal, 'Full-stack'));

  // Populate each PR picker: matching open PRs + a "use what you typed" entry.
  const OPTION_SOURCES: { action: string; repo: string }[] = [
    { action: 'ref_input', repo: 'porter' },
    { action: 'be_ref_input', repo: 'porter' },
    ...FRONTEND_FIELDS.map((f) => ({ action: f.action, repo: f.repo as string })),
  ];
  const FRONTEND_ACTIONS = new Set(FRONTEND_FIELDS.map((f) => f.action));
  for (const src of OPTION_SOURCES) {
    app.options(src.action, async ({ ack, payload }: any) => {
      const query = String(payload?.value ?? '').trim();
      let opts: { text: { type: 'plain_text'; text: string }; value: string }[] = [];
      try {
        const prs = await deps.gh.listOpenPRs(src.repo);
        const matched = query
          ? prs.filter((p) => `#${p.number} ${p.title} ${p.head}`.toLowerCase().includes(query.toLowerCase()))
          : prs;
        opts = matched.slice(0, 24).map((p) => ({
          text: { type: 'plain_text' as const, text: `#${p.number} ${p.title}`.slice(0, 75) },
          value: p.url,
        }));
      } catch {
        // ignore — still offer the literal entry below
      }
      if (query) {
        opts.unshift({ text: { type: 'plain_text' as const, text: `✍︎ Use "${query}"`.slice(0, 75) }, value: query.slice(0, 75) });
      } else if (FRONTEND_ACTIONS.has(src.action) && payload?.view?.callback_id === 'preview_fullstack_submit') {
        // Backend-only change but you still want a UI: let the bot branch off trunk.
        opts.unshift({ text: { type: 'plain_text' as const, text: '🌱 No frontend changes — use latest trunk' }, value: AUTO_TRUNK });
      }
      await ack({ options: opts });
    });
  }

  app.view('preview_backend_submit', async ({ ack, body, view }) => {
    await ack();
    const channel = channelFromView(view as any, deps.opsChannelId);
    const { ref } = parseBackendSubmission(view as any);
    try {
      const { ref: resolved, link } = await deps.gh.resolveRef('porter', ref);
      await createJobAndPost(deps, 'backend', { backend: { ref: resolved, slug: slugFromRef(resolved), link } }, body.user.id, channel);
    } catch (err) {
      await postError(deps, 'Backend', body.user.id, err, channel);
    }
  });
  app.view('preview_frontend_submit', async ({ ack, body, view }) => {
    await ack();
    const channel = channelFromView(view as any, deps.opsChannelId);
    const inputs = parseFrontendSubmission(view as any);
    try {
      if (inputs.length === 0) throw new Error('pick at least one frontend');
      if (inputs.some((f) => f.ref === AUTO_TRUNK)) {
        throw new Error('“use latest trunk” needs a backend to point at — use *Full stack* instead.');
      }
      const frontends = await resolveFrontends(deps, inputs);
      await createJobAndPost(deps, 'frontend', { frontends }, body.user.id, channel);
    } catch (err) {
      await postError(deps, 'Frontend', body.user.id, err, channel);
    }
  });
  app.view('preview_fullstack_submit', async ({ ack, body, view }) => {
    await ack();
    const channel = channelFromView(view as any, deps.opsChannelId);
    const { backendRef, frontends: feInputs } = parseFullstackSubmission(view as any);
    try {
      const be = await deps.gh.resolveRef('porter', backendRef);
      const slug = slugFromRef(be.ref);
      // Turn any "use latest trunk" pick into a real throwaway branch first.
      const expanded = await expandAutoFrontends(deps, feInputs, slug);
      const frontends = await resolveFrontends(deps, expanded);
      await createJobAndPost(deps, 'fullstack', {
        backend: { ref: be.ref, slug, link: be.link },
        frontends,
      }, body.user.id, channel);
    } catch (err) {
      await postError(deps, 'Full-stack', body.user.id, err, channel);
    }
  });

  app.action('preview_refresh', async ({ ack, body, action }: any) => {
    await ack();
    const jobId = action.value as string;
    const job = await deps.repo.get(jobId);
    const b = job?.spec.backend;
    if (!job || !b) return; // nothing to refresh without a backend preview
    // Only a settled, live preview can be refreshed. This guards stale buttons
    // (on an orphaned/old message) from resurrecting a torn-down preview or
    // re-dispatching one that's already mid-refresh (rapid double-click).
    if (job.status !== 'ready') {
      await deps.slack.chat
        .postEphemeral({
          channel: body.channel?.id ?? job.channelId, user: body.user?.id,
          text: job.status === 'torn_down'
            ? 'That preview was torn down — run `/preview` to make a new one.'
            : 'That preview is already updating — give it a moment.',
        })
        .catch(() => {});
      return;
    }
    // Re-provision the backend at the branch HEAD without tearing down: clear its
    // URL and reset to pending so the runner re-dispatches preview-from-branch
    // against the same slug (rebuild + run-migrations init-container). The
    // frontends keep their URLs — the slug, hence the backend URL they're wired
    // to, is unchanged — so no re-wire is needed. Bump `attempt` so the new run
    // gets a unique marker (job_id#N) and findRunByMarker can't latch the old run.
    const attempt = (b.attempt ?? 0) + 1;
    const spec: JobSpec = { ...job.spec, backend: { ...b, url: undefined, attempt } };
    // The button can live on a "reuse" note — a different message than the job's
    // canonical one (job.messageTs), which is what the runner keeps updating as
    // the refresh progresses. Adopt the clicked message (same channel) as the new
    // canonical one so the runner drives the message the user is actually looking
    // at, rather than leaving it frozen while a stale message elsewhere updates.
    const clickedTs: string | undefined = body.container?.message_ts ?? body.message?.ts;
    const adopt = !!clickedTs && body.channel?.id === job.channelId && clickedTs !== job.messageTs;
    const patch: UpdateJobInput = { status: 'pending', runId: null, error: null, spec };
    if (adopt) patch.messageTs = clickedTs;
    await deps.repo.update(jobId, patch);
    const refreshed = await deps.repo.get(jobId);
    const channel = body.channel?.id ?? job.channelId;
    const ts = adopt ? clickedTs : job.messageTs;
    if (refreshed && channel && ts) {
      await deps.slack.chat
        .update({ channel, ts, text: 'refreshing backend preview', blocks: renderJobBlocks(refreshed) as any, unfurl_links: false, unfurl_media: false } as any)
        .catch(() => {});
    }
    logger.info({ jobId, by: body.user?.id, adopted: adopt, attempt }, 'devops preview backend refresh requested');
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
    // Remove each frontend's branch-scoped API-URL env var so the branch stops
    // pointing at the now-gone backend preview (future auto-deploys revert to default).
    for (const f of job?.spec.frontends ?? []) {
      await deps.vercel?.removeBranchEnv(f.repo, f.ref)
        .catch((err) => logger.warn({ jobId, repo: f.repo, err: String((err as Error)?.message ?? err) }, 'env cleanup failed'));
      // Delete branches the bot created off trunk (auto-trunk picks) — the user
      // never made them, so they shouldn't linger after the preview is gone.
      if (f.autoBranch) {
        await deps.gh.deleteBranch(f.repo, f.ref)
          .catch((err) => logger.warn({ jobId, repo: f.repo, err: String((err as Error)?.message ?? err) }, 'auto branch cleanup failed'));
      }
    }
    // Update BOTH the message the button was clicked from AND the job's canonical
    // message: tearing down from a "reuse" note leaves the original message
    // otherwise showing a stale "live" preview with active buttons. The torn-down
    // render (status='torn_down') drops the buttons; sync them to the same state.
    const channel = body.channel?.id ?? job?.channelId;
    if (job && channel) {
      const blocks = [
        ...(renderJobBlocks(job) as any[]),
        { type: 'context', elements: [{ type: 'mrkdwn', text: `🧹 <@${body.user?.id}> tore down this preview` }] },
      ];
      const targets = new Set<string>();
      const clickedTs = body.container?.message_ts ?? body.message?.ts;
      if (clickedTs) targets.add(clickedTs);
      if (job.messageTs) targets.add(job.messageTs);
      for (const ts of targets) {
        await deps.slack.chat
          .update({ channel, ts, text: 'preview torn down', blocks })
          .catch(() => {});
      }
    }
    logger.info({ jobId, by: body.user?.id }, 'devops preview torn down');
  });

  // "Keep it (snooze 1h)" on an idle-preview ping: reset the idle timer so the
  // next reminder is another hour out. Non-destructive — just silences the nag.
  app.action('preview_keep', async ({ ack, body, action }: any) => {
    await ack();
    const jobId = action.value as string;
    await deps.repo.update(jobId, { idlePingedAt: new Date().toISOString() }).catch(() => {});
    await deps.slack.chat
      .postEphemeral({
        channel: body.channel?.id ?? deps.opsChannelId, user: body.user?.id,
        text: '👍 Kept — I’ll check again in about an hour.',
      })
      .catch(() => {});
    logger.info({ jobId, by: body.user?.id }, 'devops idle preview kept (snoozed)');
  });
}
