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

/**
 * Areas come from gantri-e2e's qase-trigger.yml — the AUTO-GENERATED block kept
 * in sync by `yarn sync:qase-trigger-areas`. Reading the workflow keeps Slack
 * and GitHub showing the exact same list with zero duplication. Cached briefly:
 * the list changes only when a spec area is added.
 */
let areasCache: { at: number; areas: string[] } | null = null;
export async function loadAreas(gh: GithubDispatcher): Promise<string[]> {
  if (areasCache && Date.now() - areasCache.at < 5 * 60_000) return areasCache.areas;
  const yml = await gh.fileText('gantri-e2e', '.github/workflows/qase-trigger.yml', 'main');
  const block = yml.split('AUTO-GENERATED-AREAS-START')[1]?.split('AUTO-GENERATED-AREAS-END')[0] ?? '';
  const areas = [...block.matchAll(/- '([^']+)'/g)].map((m) => m[1]).filter((a) => a !== ALL_AREAS);
  areasCache = { at: Date.now(), areas };
  return areas;
}

export function buildE2eModal() {
  const opt = (text: string, value: string) => ({ text: { type: 'plain_text' as const, text }, value });
  return {
    type: 'modal' as const, callback_id: 'e2e_run_submit',
    title: { type: 'plain_text' as const, text: 'Run E2E suite' },
    submit: { type: 'plain_text' as const, text: 'Run' },
    blocks: [
      {
        type: 'input', block_id: 'project_block',
        label: { type: 'plain_text', text: 'Project' },
        element: {
          type: 'static_select', action_id: 'project_input',
          initial_option: opt('marketplace', 'marketplace'),
          options: PROJECTS.map((p) => opt(p, p)),
        },
      },
      {
        type: 'input', block_id: 'scope_block',
        label: { type: 'plain_text', text: 'Scope' },
        element: {
          type: 'static_select', action_id: 'scope_input',
          initial_option: opt('smoke', 'smoke'),
          options: SCOPES.map((s) => opt(s, s)),
        },
      },
      {
        type: 'input', block_id: 'area_block', optional: true,
        label: { type: 'plain_text', text: 'Area' },
        element: {
          type: 'external_select', action_id: 'area_input', min_query_length: 0,
          placeholder: { type: 'plain_text', text: 'All areas — or pick one to narrow…' },
        },
      },
      {
        type: 'input', block_id: 'long_block', optional: true,
        label: { type: 'plain_text', text: 'Extras' },
        element: {
          type: 'checkboxes', action_id: 'long_input',
          options: [{
            text: { type: 'plain_text', text: 'Include @long-running tests (>3 min each)' },
            value: 'long',
          }],
        },
      },
      {
        type: 'input', block_id: 'grep_block', optional: true,
        label: { type: 'plain_text', text: 'Advanced: grep override' },
        element: {
          type: 'plain_text_input', action_id: 'grep_input',
          placeholder: { type: 'plain_text', text: 'Custom --grep regex (replaces scope + area)' },
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
  const area = sel('area_block', 'area_input');
  const grep = v.state.values.grep_block?.grep_input?.value?.trim() ?? '';
  return {
    project: (sel('project_block', 'project_input') || 'marketplace') as NonNullable<JobSpec['e2eRun']>['project'],
    scope: (sel('scope_block', 'scope_input') || 'smoke') as NonNullable<JobSpec['e2eRun']>['scope'],
    ...(area && area !== ALL_AREAS ? { area } : {}),
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
      view: { ...buildE2eModal(), private_metadata: JSON.stringify({ channel: body.channel_id }) },
    });
  });

  // Area typeahead: "(all areas)" + the synced list from qase-trigger.yml.
  app.options('area_input', async ({ ack, payload }: any) => {
    const query = String(payload?.value ?? '').trim().toLowerCase();
    let areas: string[] = [];
    try {
      areas = await loadAreas(deps.gh);
    } catch (err) {
      logger.warn({ err: String((err as Error)?.message ?? err) }, 'e2e areas load failed');
    }
    const matched = query ? areas.filter((a) => a.toLowerCase().includes(query)) : areas;
    const opts = [ALL_AREAS, ...matched].slice(0, 100).map((a) => ({
      text: { type: 'plain_text' as const, text: a.slice(0, 75) }, value: a.slice(0, 75),
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
