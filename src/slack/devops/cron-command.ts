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

type CronEnv = 'staging' | 'production' | 'preview';

const ENV_LABEL: Record<CronEnv, string> = {
  staging: '🟢 staging',
  production: '🔴 production',
  preview: '🔬 preview',
};

/**
 * The CronJob catalog comes straight from porter's k8s manifests — the same
 * files that define what actually runs: `k8s/base/cronjobs.yaml` exists in
 * both environments; `k8s/overlays/prod/cronjobs-prod.yaml` adds
 * production-only crons. Cached briefly; it changes only when a cron ships.
 */
export interface CronEntry {
  name: string;          // the k8s CronJob name (what run-cron.yml receives)
  display: string;       // human label for the picker
  description?: string;  // optional one-liner of what the job does
}

let cronsCache: { at: number; base: CronEntry[]; prodOnly: CronEntry[] } | null = null;

/** "calc-usage-discarded-inv" → "Calc usage discarded inv". */
const humanize = (name: string): string =>
  (name.charAt(0).toUpperCase() + name.slice(1)).replace(/-/g, ' ');

function parseCronEntries(yaml: string): CronEntry[] {
  // Each manifest doc is `kind: CronJob` + `metadata.name`. An optional
  // `gantri.com/display-name` annotation overrides the humanized label.
  const entries: CronEntry[] = [];
  for (const doc of yaml.split(/^---$/m)) {
    if (!/kind:\s*CronJob/.test(doc)) continue;
    const m = doc.match(/^\s{2}name:\s*([a-z0-9-]+)\s*$/m);
    if (!m) continue;
    const d = doc.match(/gantri\.com\/display-name:\s*"?([^"\n]+?)"?\s*$/m);
    const desc = doc.match(/gantri\.com\/description:\s*"?([^"\n]+?)"?\s*$/m);
    entries.push({
      name: m[1],
      display: d ? d[1] : humanize(m[1]),
      ...(desc ? { description: desc[1] } : {}),
    });
  }
  return entries;
}

export async function loadCronjobs(gh: GithubDispatcher, env: CronEnv): Promise<CronEntry[]> {
  if (!cronsCache || Date.now() - cronsCache.at >= 5 * 60_000) {
    const [base, prod] = await Promise.all([
      gh.fileText('porter', 'k8s/base/cronjobs.yaml', 'master'),
      gh.fileText('porter', 'k8s/overlays/prod/cronjobs-prod.yaml', 'master').catch(() => ''),
    ]);
    const byDisplay = (a: CronEntry, b: CronEntry) => a.display.localeCompare(b.display);
    cronsCache = {
      at: Date.now(),
      base: parseCronEntries(base).sort(byDisplay),
      prodOnly: parseCronEntries(prod).sort(byDisplay),
    };
  }
  return env === 'production'
    ? [...cronsCache.base, ...cronsCache.prodOnly].sort((a, b) => a.display.localeCompare(b.display))
    : cronsCache.base;
}

export function buildCronModal(env: CronEnv = 'staging') {
  const opt = (text: string, value: string) => ({ text: { type: 'plain_text' as const, text }, value });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
  const blocks: any[] = [
    {
      // dispatch_action: switching environment re-renders the modal so the
      // cron list matches (prod has extra crons), preview gains a target picker,
      // and the picked env lands in private_metadata — the only reliable source
      // during typeahead requests.
      type: 'input', block_id: 'env_block', dispatch_action: true,
      label: { type: 'plain_text', text: 'Environment' },
      element: {
        type: 'static_select', action_id: 'cron_env_input',
        initial_option: opt(ENV_LABEL[env], env),
        options: [opt(ENV_LABEL.staging, 'staging'), opt(ENV_LABEL.production, 'production'), opt(ENV_LABEL.preview, 'preview')],
      },
    },
  ];
  // Preview runs need a target preview environment (which porter-preview-<slug>).
  if (env === 'preview') {
    blocks.push({
      type: 'input', block_id: 'preview_block',
      label: { type: 'plain_text', text: 'Preview environment' },
      element: {
        type: 'external_select', action_id: 'cron_preview_input', min_query_length: 0,
        placeholder: { type: 'plain_text', text: 'Pick a live preview…' },
      },
    });
  }
  blocks.push({
    type: 'input', block_id: `cron_block_${env}`,
    label: { type: 'plain_text', text: 'Cron job' },
    element: {
      type: 'external_select', action_id: 'cron_name_input', min_query_length: 0,
      placeholder: { type: 'plain_text', text: `Pick a ${env} cron job…` },
    },
  });
  return {
    type: 'modal' as const, callback_id: 'cron_run_submit',
    title: { type: 'plain_text' as const, text: 'Run a porter cron' },
    submit: { type: 'plain_text' as const, text: 'Run' },
    blocks,
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
  const previewSlug = v.state.values.preview_block?.cron_preview_input?.selected_option?.value;
  return { environment: env, cronjob, ...(previewSlug ? { previewSlug } : {}) };
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
    let crons: CronEntry[] = [];
    try {
      crons = await loadCronjobs(deps.gh, env);
    } catch (err) {
      logger.warn({ err: String((err as Error)?.message ?? err) }, 'cron list load failed');
    }
    const matched = crons.filter(
      (c) =>
        !query ||
        c.name.includes(query) ||
        c.display.toLowerCase().includes(query) ||
        (c.description ?? '').toLowerCase().includes(query),
    );
    await ack({
      options: matched.slice(0, 100).map((c) => {
        // Dimmed line under the title: what the job does when we know it,
        // otherwise the raw k8s name so label + id stay visible.
        const sub = c.description ?? (c.display !== c.name ? c.name : undefined);
        return {
          text: { type: 'plain_text' as const, text: c.display.slice(0, 75) },
          ...(sub ? { description: { type: 'plain_text' as const, text: sub.slice(0, 75) } } : {}),
          value: c.name.slice(0, 75),
        };
      }),
    });
  });

  // Live previews for the preview-target picker — source of truth is the
  // bot's own ready preview jobs; the namespace is porter-preview-<slug>.
  app.options('cron_preview_input', async ({ ack }: any) => {
    const slugs: { slug: string; ref?: string }[] = [];
    try {
      const seen = new Set<string>();
      for (const p of await deps.repo.listReadyPreviews(25)) {
        const slug = p.spec.backend?.slug;
        if (!slug || seen.has(slug)) continue; // a slug can have several ready jobs
        seen.add(slug);
        slugs.push({ slug, ref: p.spec.backend?.ref });
      }
    } catch (err) {
      logger.warn({ err: String((err as Error)?.message ?? err) }, 'preview list load failed');
    }
    await ack({
      options: slugs.slice(0, 100).map((s) => ({
        text: { type: 'plain_text' as const, text: s.slug.slice(0, 75) },
        ...(s.ref ? { description: { type: 'plain_text' as const, text: s.ref.slice(0, 75) } } : {}),
        value: s.slug.slice(0, 75),
      })),
    });
  });

  app.view('cron_run_submit', async ({ ack, body, view }) => {
    await ack();
    const channel = channelFromView(view as any, deps.opsChannelId);
    const cronRun = parseCronSubmission(view as any);
    try {
      if (!cronRun.cronjob) throw new Error('pick a cron job');
      if (cronRun.environment === 'preview' && !cronRun.previewSlug) throw new Error('pick a preview environment');
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
  // Carry the human label + description into the job so the Slack message can
  // show them (best-effort — the catalog cache is warm right after the picker).
  try {
    const entry = (await loadCronjobs(deps.gh, cronRun.environment)).find((c) => c.name === cronRun.cronjob);
    if (entry) {
      cronRun = {
        ...cronRun,
        ...(entry.display !== entry.name ? { display: entry.display } : {}),
        ...(entry.description ? { description: entry.description } : {}),
      };
    }
  } catch { /* render falls back to the raw name */ }
  const job = await deps.repo.create({
    kind: 'cron', target: 'cron', spec: { cronRun }, requestedBy, channelId: channel,
  });
  const posted = await deps.slack.chat.postMessage({
    channel, text: `⏱️ cron run starting…`, blocks: renderJobBlocks(job) as any,
    unfurl_links: false, unfurl_media: false,
  });
  if (posted.ts) await deps.repo.update(job.id, { messageTs: posted.ts });
}
