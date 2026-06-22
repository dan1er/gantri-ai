import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { DevopsJobsRepo } from '../../devops/jobs-repo.js';
import type { GithubDispatcher } from '../../devops/github.js';
import type { JobSpec } from '../../devops/types.js';
import { renderJobBlocks } from '../../devops/messages.js';
import { decideCommandChannel, channelFromView } from './channel-access.js';
import { logger } from '../../logger.js';

export interface E2eCommandDeps {
  repo: DevopsJobsRepo;
  slack: WebClient;
  opsChannelId: string;
  dmUserIds: string[];
  gh: GithubDispatcher;
}

const PROJECTS = ['marketplace', 'factoryOs', 'madeOs', 'cross-product'] as const;
const SCOPES = ['smoke', 'regression', 'all'] as const;
const ALL_AREAS = '(all areas)';

export interface AreaEntry {
  area: string;
  /** Owning Playwright project(s); empty = unknown → offered for every project. */
  projects: string[];
}

/**
 * Areas come from gantri-e2e's qase-trigger.yml — the AUTO-GENERATED block kept
 * in sync by `yarn sync:qase-trigger-areas`, where each option carries a YAML
 * comment with its owning project(s) (`- 'Batches · access' # factoryOs`).
 * Reading the workflow keeps Slack and GitHub showing the exact same list with
 * zero duplication. Cached briefly: it changes only when a spec area is added.
 */
let areasCache: { at: number; areas: AreaEntry[] } | null = null;
export async function loadAreas(gh: GithubDispatcher): Promise<AreaEntry[]> {
  if (areasCache && Date.now() - areasCache.at < 5 * 60_000) return areasCache.areas;
  const yml = await gh.fileText('gantri-e2e', '.github/workflows/qase-trigger.yml', 'main');
  const block = yml.split('AUTO-GENERATED-AREAS-START')[1]?.split('AUTO-GENERATED-AREAS-END')[0] ?? '';
  const areas = [...block.matchAll(/- '([^']+)'(?:[ \t]*#[ \t]*([\w,-]+))?/g)]
    .map((m) => ({ area: m[1], projects: m[2] ? m[2].split(',').map((p) => p.trim()) : [] }))
    .filter((e) => e.area !== ALL_AREAS);
  areasCache = { at: Date.now(), areas };
  return areas;
}

export interface E2eModalOpts {
  project?: (typeof PROJECTS)[number];
  scope?: (typeof SCOPES)[number];
  includeLongRunning?: boolean;
  grep?: string;
}

export function buildE2eModal(opts?: E2eModalOpts) {
  const opt = (text: string, value: string) => ({ text: { type: 'plain_text' as const, text }, value });
  const project = opts?.project ?? 'marketplace';
  return {
    type: 'modal' as const, callback_id: 'e2e_run_submit',
    title: { type: 'plain_text' as const, text: 'Run E2E suite' },
    submit: { type: 'plain_text' as const, text: 'Run' },
    blocks: [
      {
        // dispatch_action: changing the project re-renders the modal via
        // views.update — the chosen project lands in private_metadata (the
        // ONLY reliable source for it during block_suggestion requests) and
        // the Areas block_id rotates, which busts Slack's client-side options
        // cache and clears any selected areas from the previous project.
        type: 'input', block_id: 'project_block', dispatch_action: true,
        label: { type: 'plain_text', text: 'Project' },
        element: {
          type: 'static_select', action_id: 'project_input',
          initial_option: opt(project, project),
          options: PROJECTS.map((p) => opt(p, p)),
        },
      },
      {
        type: 'input', block_id: 'scope_block',
        label: { type: 'plain_text', text: 'Scope' },
        element: {
          type: 'static_select', action_id: 'scope_input',
          initial_option: opt(opts?.scope ?? 'smoke', opts?.scope ?? 'smoke'),
          options: SCOPES.map((s) => opt(s, s)),
        },
      },
      {
        type: 'input', block_id: `area_block_${project}`, optional: true,
        label: { type: 'plain_text', text: 'Areas' },
        element: {
          type: 'multi_external_select', action_id: 'area_input', min_query_length: 0,
          placeholder: { type: 'plain_text', text: `${project} areas — pick one or more, or leave empty for all…` },
        },
      },
      {
        type: 'input', block_id: 'long_block', optional: true,
        label: { type: 'plain_text', text: 'Extras' },
        element: {
          type: 'checkboxes', action_id: 'long_input',
          ...(opts?.includeLongRunning
            ? { initial_options: [{ text: { type: 'plain_text' as const, text: 'Include @long-running tests (>3 min each)' }, value: 'long' }] }
            : {}),
          options: [{
            text: { type: 'plain_text', text: 'Include @long-running tests (>3 min each)' },
            value: 'long',
          }],
        },
      },
      {
        type: 'input', block_id: 'grep_block', optional: true,
        label: { type: 'plain_text', text: 'Advanced: grep override' },
        hint: {
          type: 'plain_text',
          text: 'Regex matched against full test titles; replaces Scope + Areas entirely. e.g. "Checkout" (every checkout test), "(?=.*PDP)(?=.*@smoke)" (PDP smoke only), "gift card|promo code".',
        },
        element: {
          type: 'plain_text_input', action_id: 'grep_input',
          ...(opts?.grep ? { initial_value: opts.grep } : {}),
          placeholder: { type: 'plain_text', text: 'e.g. (?=.*Checkout)(?=.*@smoke)' },
        },
      },
    ],
  };
}

type ViewState = {
  state: {
    values: Record<string, Record<string, {
      value?: string;
      selected_option?: { value: string };
      selected_options?: { value: string }[];
    }>>;
  };
};

export function parseE2eSubmission(v: ViewState): NonNullable<JobSpec['e2eRun']> {
  const sel = (b: string, a: string) => v.state.values[b]?.[a]?.selected_option?.value ?? '';
  // The Areas block_id is rotated per project (cache busting) — find by prefix.
  const areaBlockId = Object.keys(v.state.values).find((k) => k.startsWith('area_block')) ?? 'area_block';
  const areas = (v.state.values[areaBlockId]?.area_input?.selected_options ?? [])
    .map((o) => o.value)
    .filter((a) => a && a !== ALL_AREAS);
  const grep = v.state.values.grep_block?.grep_input?.value?.trim() ?? '';
  return {
    project: (sel('project_block', 'project_input') || 'marketplace') as NonNullable<JobSpec['e2eRun']>['project'],
    scope: (sel('scope_block', 'scope_input') || 'smoke') as NonNullable<JobSpec['e2eRun']>['scope'],
    ...(areas.length ? { areas } : {}),
    ...(v.state.values.long_block?.long_input?.selected_options?.length ? { includeLongRunning: true } : {}),
    ...(grep ? { grepOverride: grep } : {}),
  };
}

export function registerE2eCommand(app: App, deps: E2eCommandDeps): void {
  app.command('/e2e', async ({ ack, body, respond, client }) => {
    await ack();
    const decision = decideCommandChannel('/e2e', deps.opsChannelId, deps.dmUserIds, body.channel_id, body.user_id);
    if (!decision.allowed) {
      await respond({ response_type: 'ephemeral', text: decision.message });
      return;
    }
    await client.views.open({
      trigger_id: body.trigger_id,
      view: { ...buildE2eModal(), private_metadata: JSON.stringify({ channel: body.channel_id, project: 'marketplace' }) },
    });
  });

  // Project changed → re-render the modal: persist the new project in
  // private_metadata (block_suggestion payloads don't reliably carry fresh
  // view state) and rotate the Areas block_id, which busts Slack's options
  // cache and drops areas selected under the previous project. Scope /
  // long-running / grep selections are carried over.
  app.action('project_input', async ({ ack, body, client }: any) => {
    await ack();
    const view = body.view;
    if (!view) return;
    let meta: { channel?: string } = {};
    try { meta = JSON.parse(view.private_metadata || '{}'); } catch { /* keep empty */ }
    const values = view.state?.values ?? {};
    const project = values.project_block?.project_input?.selected_option?.value ?? 'marketplace';
    await client.views.update({
      view_id: view.id, hash: view.hash,
      view: {
        ...buildE2eModal({
          project,
          scope: values.scope_block?.scope_input?.selected_option?.value,
          includeLongRunning: !!values.long_block?.long_input?.selected_options?.length,
          grep: values.grep_block?.grep_input?.value ?? undefined,
        }),
        private_metadata: JSON.stringify({ channel: meta.channel, project }),
      },
    }).catch((err: unknown) => logger.warn({ err: String((err as Error)?.message ?? err) }, 'e2e modal update failed'));
  });

  // Area typeahead: the synced list from qase-trigger.yml, narrowed to the
  // project stored in private_metadata (kept fresh by the project_input
  // action above).
  app.options('area_input', async ({ ack, payload, body }: any) => {
    const query = String(payload?.value ?? '').trim().toLowerCase();
    let project = 'marketplace';
    try {
      project = JSON.parse((payload?.view ?? body?.view)?.private_metadata || '{}').project ?? 'marketplace';
    } catch { /* default */ }
    let areas: AreaEntry[] = [];
    try {
      areas = await loadAreas(deps.gh);
    } catch (err) {
      logger.warn({ err: String((err as Error)?.message ?? err) }, 'e2e areas load failed');
    }
    const matched = areas
      .filter((e) => e.projects.length === 0 || e.projects.includes(project))
      .filter((e) => !query || e.area.toLowerCase().includes(query));
    const opts = matched.slice(0, 100).map((e) => ({
      text: { type: 'plain_text' as const, text: e.area.slice(0, 75) }, value: e.area.slice(0, 75),
    }));
    await ack({ options: opts });
  });

  app.view('e2e_run_submit', async ({ ack, body, view }) => {
    await ack();
    const channel = channelFromView(view as any, deps.opsChannelId);
    try {
      const e2eRun = parseE2eSubmission(view as any);
      const job = await deps.repo.create({
        kind: 'e2e', target: 'suite', spec: { e2eRun }, requestedBy: body.user.id, channelId: channel,
      });
      const posted = await deps.slack.chat.postMessage({
        channel, text: '🧪 E2E run starting…', blocks: renderJobBlocks(job) as any,
        unfurl_links: false, unfurl_media: false,
      });
      if (posted.ts) await deps.repo.update(job.id, { messageTs: posted.ts });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await deps.slack.chat
        .postMessage({ channel, text: `✗ E2E run — <@${body.user.id}>: ${msg}` })
        .catch(() => {});
    }
  });
}
