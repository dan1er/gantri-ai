import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { DevopsJobsRepo } from '../../devops/jobs-repo.js';
import type { GithubDispatcher } from '../../devops/github.js';
import type { JobSpec } from '../../devops/types.js';
import { renderJobBlocks } from '../../devops/messages.js';
import { decideCommandChannel, channelFromView } from './channel-access.js';
import { logger } from '../../logger.js';

export interface CronCommandDeps {
  repo: DevopsJobsRepo;
  slack: WebClient;
  opsChannelId: string;
  dmUserIds: string[];
  gh: GithubDispatcher;
}

type CronEnv = 'staging' | 'production';

/**
 * The CronJob catalog comes straight from porter's k8s manifests — the same
 * files that define what actually runs: `k8s/base/cronjobs.yaml` exists in
 * both environments; `k8s/overlays/prod/cronjobs-prod.yaml` adds
 * production-only crons. Cached briefly; it changes only when a cron ships.
 */
let cronsCache: { at: number; base: string[]; prodOnly: string[] } | null = null;

function parseCronNames(yaml: string): string[] {
  // Each manifest doc is `kind: CronJob` + `metadata.name`; grab the first
  // name after each CronJob kind line.
  const names: string[] = [];
  for (const doc of yaml.split(/^---$/m)) {
    if (!/kind:\s*CronJob/.test(doc)) continue;
    const m = doc.match(/^\s{2}name:\s*([a-z0-9-]+)\s*$/m);
    if (m) names.push(m[1]);
  }
  return names;
}

export async function loadCronjobs(gh: GithubDispatcher, env: CronEnv): Promise<string[]> {
  if (!cronsCache || Date.now() - cronsCache.at >= 5 * 60_000) {
    const [base, prod] = await Promise.all([
      gh.fileText('porter', 'k8s/base/cronjobs.yaml', 'master'),
      gh.fileText('porter', 'k8s/overlays/prod/cronjobs-prod.yaml', 'master').catch(() => ''),
    ]);
    cronsCache = {
      at: Date.now(),
      base: parseCronNames(base).sort(),
      prodOnly: parseCronNames(prod).sort(),
    };
  }
  return env === 'production'
    ? [...cronsCache.base, ...cronsCache.prodOnly].sort()
    : cronsCache.base;
}

export function buildCronModal(env: CronEnv = 'staging') {
  const opt = (text: string, value: string) => ({ text: { type: 'plain_text' as const, text }, value });
  return {
    type: 'modal' as const, callback_id: 'cron_run_submit',
    title: { type: 'plain_text' as const, text: 'Run a porter cron' },
    submit: { type: 'plain_text' as const, text: 'Run' },
    blocks: [
      {
        // dispatch_action: switching environment re-renders the modal so the
        // cron list matches (prod has extra crons) and the picked env lands in
        // private_metadata — the only reliable source during typeahead requests.
        type: 'input', block_id: 'env_block', dispatch_action: true,
        label: { type: 'plain_text', text: 'Environment' },
        element: {
          type: 'static_select', action_id: 'cron_env_input',
          initial_option: opt(env === 'production' ? '🔴 production' : '🟢 staging', env),
          options: [opt('🟢 staging', 'staging'), opt('🔴 production', 'production')],
        },
      },
      {
        type: 'input', block_id: `cron_block_${env}`,
        label: { type: 'plain_text', text: 'Cron job' },
        element: {
          type: 'external_select', action_id: 'cron_name_input', min_query_length: 0,
          placeholder: { type: 'plain_text', text: `Pick a ${env} cron job…` },
        },
      },
    ],
  };
}

type ViewState = {
  state: {
    values: Record<string, Record<string, { selected_option?: { value: string } }>>;
  };
};

export function parseCronSubmission(v: ViewState): NonNullable<JobSpec['cronRun']> {
  const env =
    (v.state.values.env_block?.cron_env_input?.selected_option?.value as CronEnv) ?? 'staging';
  const cronBlockId = Object.keys(v.state.values).find((k) => k.startsWith('cron_block')) ?? 'cron_block';
  const cronjob = v.state.values[cronBlockId]?.cron_name_input?.selected_option?.value ?? '';
  return { environment: env, cronjob };
}

export function registerCronCommand(app: App, deps: CronCommandDeps): void {
  app.command('/cron', async ({ ack, body, respond, client }) => {
    await ack();
    const decision = decideCommandChannel('/cron', deps.opsChannelId, deps.dmUserIds, body.channel_id, body.user_id);
    if (!decision.allowed) {
      await respond({ response_type: 'ephemeral', text: decision.message });
      return;
    }
    await client.views.open({
      trigger_id: body.trigger_id,
      view: { ...buildCronModal(), private_metadata: JSON.stringify({ channel: body.channel_id, env: 'staging' }) },
    });
  });

  // Environment changed → re-render with the env-scoped cron list.
  app.action('cron_env_input', async ({ ack, body, client }: any) => {
    await ack();
    const view = body.view;
    if (!view) return;
    let meta: { channel?: string } = {};
    try { meta = JSON.parse(view.private_metadata || '{}'); } catch { /* keep empty */ }
    const env: CronEnv =
      view.state?.values?.env_block?.cron_env_input?.selected_option?.value ?? 'staging';
    await client.views.update({
      view_id: view.id, hash: view.hash,
      view: {
        ...buildCronModal(env),
        private_metadata: JSON.stringify({ channel: meta.channel, env }),
      },
    }).catch((err: unknown) => logger.warn({ err: String((err as Error)?.message ?? err) }, 'cron modal update failed'));
  });

  // Cron typeahead, scoped to the environment in private_metadata.
  app.options('cron_name_input', async ({ ack, payload, body }: any) => {
    const query = String(payload?.value ?? '').trim().toLowerCase();
    let env: CronEnv = 'staging';
    try {
      env = JSON.parse((payload?.view ?? body?.view)?.private_metadata || '{}').env ?? 'staging';
    } catch { /* default */ }
    let crons: string[] = [];
    try {
      crons = await loadCronjobs(deps.gh, env);
    } catch (err) {
      logger.warn({ err: String((err as Error)?.message ?? err) }, 'cron list load failed');
    }
    const matched = crons.filter((c) => !query || c.includes(query));
    await ack({
      options: matched.slice(0, 100).map((c) => ({
        text: { type: 'plain_text' as const, text: c.slice(0, 75) }, value: c.slice(0, 75),
      })),
    });
  });

  app.view('cron_run_submit', async ({ ack, body, view }) => {
    await ack();
    const channel = channelFromView(view as any, deps.opsChannelId);
    const cronRun = parseCronSubmission(view as any);
    try {
      if (!cronRun.cronjob) throw new Error('pick a cron job');
      if (cronRun.environment === 'production') {
        // Production touches real data — explicit confirm step, deploy-style.
        await deps.slack.chat.postEphemeral({
          channel, user: body.user.id, text: 'Confirm production cron run',
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `:warning: *Run \`${cronRun.cronjob}\` on PRODUCTION?*\nThis executes the real cron against production data, outside its schedule.` },
            },
            {
              type: 'actions',
              elements: [
                { type: 'button', text: { type: 'plain_text', text: 'Run on production' }, style: 'danger', action_id: 'cron_confirm', value: JSON.stringify({ cronRun, channel }) },
                { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, action_id: 'cron_cancel', value: 'x' },
              ],
            },
          ] as any,
        });
        return;
      }
      await createCronJobAndPost(deps, cronRun, body.user.id, channel);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await deps.slack.chat
        .postMessage({ channel, text: `✗ Cron run — <@${body.user.id}>: ${msg}` })
        .catch(() => {});
    }
  });

  app.action('cron_confirm', async ({ ack, body, action, respond }: any) => {
    await ack();
    await respond({ delete_original: true });
    try {
      const { cronRun, channel } = JSON.parse(action.value as string);
      await createCronJobAndPost(deps, cronRun, body.user.id, channel ?? deps.opsChannelId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await deps.slack.chat
        .postMessage({ channel: body.channel?.id ?? deps.opsChannelId, text: `✗ Cron run — <@${body.user?.id}>: ${msg}` })
        .catch(() => {});
    }
  });

  app.action('cron_cancel', async ({ ack, respond }: any) => {
    await ack();
    await respond({ replace_original: true, text: '🚫 Cron run cancelled.' });
  });
}

async function createCronJobAndPost(
  deps: CronCommandDeps, cronRun: NonNullable<JobSpec['cronRun']>, requestedBy: string, channel: string,
): Promise<void> {
  const job = await deps.repo.create({
    kind: 'cron', target: 'cron', spec: { cronRun }, requestedBy, channelId: channel,
  });
  const posted = await deps.slack.chat.postMessage({
    channel, text: `⏱️ cron run starting…`, blocks: renderJobBlocks(job) as any,
    unfurl_links: false, unfurl_media: false,
  });
  if (posted.ts) await deps.repo.update(job.id, { messageTs: posted.ts });
}
