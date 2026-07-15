import Anthropic from '@anthropic-ai/sdk';
import { loadEnv } from './config/env.js';
import { logger } from './logger.js';
import { getSupabase, readVaultSecret } from './storage/supabase.js';
import { AuthorizedUsersRepo } from './storage/repositories/authorized-users.js';
import { ConversationsRepo } from './storage/repositories/conversations.js';
import { ConnectorRegistry } from './connectors/base/registry.js';
import { CachingRegistry } from './connectors/base/caching-registry.js';
import { DEFAULT_CACHE_POLICIES } from './connectors/base/default-policies.js';
import { TtlCache } from './storage/cache.js';
import { RollupRepo } from './storage/rollup-repo.js';
import { RollupRefreshJob } from './connectors/rollup/rollup-refresh.js';
import { SalesReportConnector } from './connectors/sales-report/sales-report-connector.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { RollupConnector as _DeprecatedRollupConnector } from './connectors/rollup/rollup-connector.js';
import { LateOrdersConnector } from './connectors/late-orders/late-orders-connector.js';
import { ProductDurationsConnector } from './connectors/product-durations/product-durations-connector.js';
import { ProductExportConnector } from './connectors/product-export/product-export-connector.js';
import { NorthbeamConnector } from './connectors/northbeam/northbeam-connector.js';
import { NorthbeamApiConnector } from './connectors/northbeam-api/connector.js';
import { NorthbeamApiClient } from './connectors/northbeam-api/client.js';
import { MarketingAnalysisConnector } from './connectors/marketing-analysis/connector.js';
import { ReportsConnector } from './connectors/reports/reports-connector.js';
import { FeedbackConnector } from './connectors/feedback/feedback-connector.js';
import { FeedbackRepo } from './storage/repositories/feedback.js';
import { BroadcastConnector } from './connectors/broadcast/broadcast-connector.js';
import { LiveReportsConnector } from './connectors/live-reports/connector.js';
import { LiveCatalogs } from './connectors/live-reports/live-catalogs.js';
import { PublishedReportsRepo } from './storage/repositories/published-reports.js';
import { mountLiveReportsRoutes } from './server/live-reports-routes.js';
import { loadBuildStamp, createModuleStatus, renderBuildInfo } from './server/build-info.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GantriPorterConnector } from './connectors/gantri-porter/gantri-porter-connector.js';
import { GrafanaConnector } from './connectors/grafana/grafana-connector.js';
import { Ga4Client } from './connectors/ga4/client.js';
import { Ga4Connector } from './connectors/ga4/connector.js';
import { buildImpactConnector } from './connectors/impact/connector.js';
import { KlaviyoConnector } from './connectors/klaviyo/connector.js';
import { KlaviyoApiClient } from './connectors/klaviyo/client.js';
import { GantriWritesRepo } from './storage/repositories/gantri-writes.js';
import { KlaviyoImportsRepo } from './storage/repositories/klaviyo-imports.js';
import { KlaviyoDeletionsRepo } from './storage/repositories/klaviyo-deletions.js';
import { PendingConfirmationsRepo } from './storage/repositories/pending-confirmations.js';
import { KlaviyoImportPollerJob } from './connectors/klaviyo/import-poller.js';
import { ConfirmationHandler } from './orchestrator/confirmation-handler.js';
import type { FileSharedDeps } from './slack/handlers.js';
import type { App as SlackApp } from '@slack/bolt';
import { PipedriveConnector } from './connectors/pipedrive/connector.js';
import { PipedriveApiClient } from './connectors/pipedrive/client.js';
import { PipedriveWritesRepo } from './storage/repositories/pipedrive-writes.js';
import { AsanaConnector } from './connectors/asana/connector.js';
import { AsanaApiClient } from './connectors/asana/client.js';
import { loadTierStandard } from './connectors/asana/tier/extract.js';
import {
  RubricSource,
  splitStandard,
  buildFallbackRubric,
  DELIVERY_TIER_RUBRIC_PAGE_ID,
} from './connectors/asana/tier/rubric-source.js';
import { TierRubricCacheRepo } from './storage/repositories/tier-rubric-cache.js';
import { TierPoller } from './connectors/asana/tier/poller.js';
import { WeeklyTierReporter } from './connectors/asana/tier/weekly-report.js';
import { TierRunner } from './connectors/asana/tier/tier-runner.js';
import { AuthoritativePass } from './connectors/asana/tier/authoritative-pass.js';
import { ReviewRequestNotifier } from './connectors/asana/tier/review-request.js';
import { TierClassificationsRepo } from './storage/repositories/tier-classifications.js';
import { TierWeeklyReportsRepo } from './storage/repositories/tier-weekly-reports.js';
import { TierPrChecksRepo } from './storage/repositories/tier-pr-checks.js';
import { SendgridConnector } from './connectors/sendgrid/connector.js';
import { SendgridApiClient } from './connectors/sendgrid/client.js';
import { buildSearchConsoleConnector } from './connectors/gsc/connector.js';
import { Orchestrator, getActiveActor, getActiveThread, runWithContext } from './orchestrator/orchestrator.js';
import { buildSlackApp } from './slack/app.js';
import { DevopsJobsRepo } from './devops/jobs-repo.js';
import { GithubDispatcher } from './devops/github.js';
import { advancePreviewJob } from './devops/provisioner.js';
import { JobsRunner } from './devops/jobs-runner.js';
import { VercelClient } from './devops/vercel.js';
import { QaseClient } from './devops/qase.js';
import { registerPreviewCommand } from './slack/devops/preview-command.js';
import { advanceDeployJob } from './devops/deploy-provisioner.js';
import { registerDeployCommand } from './slack/devops/deploy-command.js';
import { advanceE2eJob } from './devops/e2e-provisioner.js';
import { registerE2eCommand } from './slack/devops/e2e-command.js';
import { advanceCronJob } from './devops/cron-provisioner.js';
import { registerCronCommand } from './slack/devops/cron-command.js';
import { NotionApiClient } from './connectors/notion/client.js';
import { reviewFlc, loadReviewStandard } from './flc/flc-review-service.js';
import { registerReviewFlcCommand } from './slack/review-flc/review-flc-command.js';
import type { ReviewStateStore } from './slack/review-flc/review-flc-command.js';
import { FlcReviewsRepo } from './storage/repositories/flc-reviews.js';
import { ReportSubscriptionsRepo } from './reports/reports-repo.js';
import { ScheduledReportsConnector } from './reports/reports-connector.js';
import { compilePlan } from './reports/plan-compiler.js';
import { executePlan } from './reports/plan-executor.js';
import { computeNextFireAt } from './reports/cron-utils.js';
import { ReportsRunner } from './reports/runner.js';

async function main() {
  const env = loadEnv();
  const supabase = getSupabase();

  // Surface the staging-vs-prod choice for gantri customer-data writes in
  // boot logs. The actual switch is read per-request inside the write tool,
  // so a `fly secrets set` flips behavior without redeploy — but on a fresh
  // boot this line tells you at-a-glance which environment the bot is
  // currently writing to.
  const writeTarget = process.env.PORTER_WRITE_TARGET === 'prod' ? 'prod' : 'staging';
  logger.info({ porter_write_target: writeTarget }, 'gantri_porter_write_target');

  // Build fingerprint (baked into the image at docker build) + a live ledger of
  // which optional modules actually get wired below. Both are exposed unauthed at
  // GET /internal/build so the deploy-canary workflow can detect a Fly image
  // clobber that silently drops a module (e.g. the delivery-tier classifier).
  const buildStamp = loadBuildStamp();
  const moduleStatus = createModuleStatus();
  logger.info({ sha: buildStamp.sha, builtAt: buildStamp.builtAt }, 'build_stamp');

  const [
    email, password, dashboardId,
    nbApiKey, nbDataClientId,
    porterApiBaseUrl, porterBotEmail, porterBotPassword,
    grafanaUrl, grafanaToken, grafanaPostgresDsUid,
    ga4PropertyId, ga4ServiceAccountKey,
    impactAccountSid, impactAuthToken,
    klaviyoApiKey,
    gscOauthClientId, gscOauthClientSecret, gscOauthRefreshToken,
    pipedriveApiToken,
    asanaAccessToken,
    sendgridApiKey,
    notionApiTokenVault,
  ] = await Promise.all([
    readVaultSecret(supabase, 'NORTHBEAM_EMAIL'),
    readVaultSecret(supabase, 'NORTHBEAM_PASSWORD'),
    readVaultSecret(supabase, 'NORTHBEAM_DASHBOARD_ID'),
    readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
    readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
    readVaultSecret(supabase, 'PORTER_API_BASE_URL'),
    readVaultSecret(supabase, 'PORTER_BOT_EMAIL'),
    readVaultSecret(supabase, 'PORTER_BOT_PASSWORD'),
    readVaultSecret(supabase, 'GRAFANA_URL'),
    readVaultSecret(supabase, 'GRAFANA_TOKEN'),
    readVaultSecret(supabase, 'GRAFANA_POSTGRES_DS_UID'),
    readVaultSecret(supabase, 'GA4_PROPERTY_ID').catch(() => null),
    readVaultSecret(supabase, 'GA4_SERVICE_ACCOUNT_KEY').catch(() => null),
    readVaultSecret(supabase, 'IMPACT_ACCOUNT_SID').catch(() => null),
    readVaultSecret(supabase, 'IMPACT_AUTH_TOKEN').catch(() => null),
    readVaultSecret(supabase, 'KLAVIYO_API_KEY').catch(() => null),
    readVaultSecret(supabase, 'GSC_OAUTH_CLIENT_ID').catch(() => null),
    readVaultSecret(supabase, 'GSC_OAUTH_CLIENT_SECRET').catch(() => null),
    readVaultSecret(supabase, 'GSC_OAUTH_REFRESH_TOKEN').catch(() => null),
    readVaultSecret(supabase, 'PIPEDRIVE_API_TOKEN').catch(() => null),
    readVaultSecret(supabase, 'ASANA_ACCESS_TOKEN').catch(() => null),
    readVaultSecret(supabase, 'SENDGRID_API_KEY').catch(() => null),
    readVaultSecret(supabase, 'NOTION_API_TOKEN').catch(() => null),
  ]);

  const registry = new ConnectorRegistry();

  // Active Northbeam path: official REST API.
  const northbeamApi = new NorthbeamApiConnector({
    apiKey: nbApiKey,
    dataClientId: nbDataClientId,
  });
  registry.register(northbeamApi);

  // DEPRECATED 2026-04-25: legacy Playwright-based connector kept for emergency
  // rollback only. NB's anti-bot blocked the scraping account; the official API
  // (NorthbeamApiConnector above) is the supported path now. To re-enable for
  // a one-off, swap the registry.register call to `northbeamLegacy`.
  const northbeamLegacy = new NorthbeamConnector({
    supabase,
    credentials: { email, password, dashboardId },
  });
  void northbeamLegacy;
  // ReportsConnector needs the Slack WebClient (for canvases.* APIs), so we
  // construct + register it AFTER buildSlackApp() below, where `app.client`
  // is available. The orchestrator reads tools lazily on each run, so
  // late-registration is safe.

  // RollupRepo first so GantriPorterConnector can pick it up — order_stats
  // falls back to the rollup for date ranges that exceed Porter's pagination
  // cap (so multi-year totals match Grafana exactly).
  const rollupRepo = new RollupRepo(supabase);

  // Top-level repos used by both buildSlackApp and the GantriPorterConnector
  // write-tool deps (gantri.update_customer_email needs usersRepo to enforce
  // role gating + writesRepo to log every attempt to the audit table).
  const usersRepo = new AuthorizedUsersRepo(supabase);
  const gantriWritesRepo = new GantriWritesRepo(supabase);

  // GantriPorterConnector is constructed AFTER the klaviyo block below so
  // we can pass through the (optional) KlaviyoApiClient — the write tool
  // calls klaviyo.updateProfileEmail when syncKlaviyo is true and the
  // customer has a stamped klaviyoId. See the `let gantriPorter` + assignment
  // at the end of the klaviyo block.
  let gantriPorter: GantriPorterConnector;

  const grafana = new GrafanaConnector({
    baseUrl: grafanaUrl,
    token: grafanaToken,
    postgresDsUid: grafanaPostgresDsUid,
  });
  registry.register(grafana);

  // Sales report tool — runs Grafana's exact Sales-dashboard panel SQL live.
  // Replaces the old `gantri.daily_rollup` tool; the team trusts Grafana's
  // numbers and the rollup table diverged subtly (Transaction-level vs
  // StockAssociation-level discount allocation).
  // Standalone NB API client for tools that need both NB + Grafana (e.g. the
  // gantri.compare_orders_nb_vs_porter tool exposed by SalesReportConnector).
  const nbClient = new NorthbeamApiClient({ apiKey: nbApiKey, dataClientId: nbDataClientId });
  registry.register(new SalesReportConnector({ grafana, nb: nbClient }));

  // Marketing-analysis tools — multi-call NB patterns the LLM has historically
  // gotten wrong inline (attribution-model comparison, LTV/CAC by channel,
  // new vs returning split, marginal-ROAS budget optimization).
  registry.register(new MarketingAnalysisConnector({ nb: nbClient }));

  registry.register(new LateOrdersConnector({ grafana }));
  registry.register(new ProductDurationsConnector({ grafana }));
  // Wholesale product catalog CSV export — reads the prod read-replica via
  // Grafana and returns a downloadable CSV attachment.
  registry.register(new ProductExportConnector({ grafana }));

  if (ga4PropertyId && ga4ServiceAccountKey) {
    const ga4 = new Ga4Connector({
      client: new Ga4Client({ propertyId: ga4PropertyId, serviceAccountKey: ga4ServiceAccountKey }),
    });
    registry.register(ga4);
    logger.info({ propertyId: ga4PropertyId }, 'ga4 connector registered');
  } else {
    logger.warn('ga4 not configured (GA4_PROPERTY_ID and/or GA4_SERVICE_ACCOUNT_KEY missing) — skipping registration');
  }

  if (impactAccountSid && impactAuthToken) {
    registry.register(buildImpactConnector({ accountSid: impactAccountSid, authToken: impactAuthToken }));
    logger.info('impact connector registered');
  } else {
    logger.warn('impact not configured (IMPACT_ACCOUNT_SID and/or IMPACT_AUTH_TOKEN missing) — skipping registration');
  }

  // The confirmation handler, file-shared deps, and import poller all need
  // `app.client` for outbound Slack calls — but `app` is created by
  // `buildSlackApp` further down (chicken-and-egg). We resolve this with a
  // closure-captured `appRef` thunk: the adapters below dereference
  // `appRef!.client` lazily, and we assign `appRef = app` immediately after
  // `buildSlackApp`. The poller's `start()` is deferred until after that
  // assignment, so the first DM goes through a fully-initialized client.
  let appRef: SlackApp | undefined;
  let klaviyoConfirmationHandler: ConfirmationHandler | undefined;
  let klaviyoFileSharedDeps: FileSharedDeps | undefined;
  let klaviyoImportPoller: KlaviyoImportPollerJob | undefined;
  // Hoisted so `buildSlackApp` below can wire them into `createDmHandler` for
  // pending-CSV context lookups. When Klaviyo isn't configured we fall back to
  // no-op stubs (see the buildSlackApp call site).
  let klaviyoClientRef: KlaviyoApiClient | undefined;
  let klaviyoPendingRepoRef: PendingConfirmationsRepo | undefined;

  if (klaviyoApiKey) {
    const klaviyoClient = new KlaviyoApiClient({ apiKey: klaviyoApiKey });
    const klaviyoImportsRepo = new KlaviyoImportsRepo(supabase);
    const klaviyoDeletionsRepo = new KlaviyoDeletionsRepo(supabase);
    const klaviyoPendingRepo = new PendingConfirmationsRepo(supabase);
    const klaviyoUsersRepo = new AuthorizedUsersRepo(supabase);
    klaviyoClientRef = klaviyoClient;
    klaviyoPendingRepoRef = klaviyoPendingRepo;
    registry.register(new KlaviyoConnector({
      client: klaviyoClient,
      importsRepo: klaviyoImportsRepo,
      deletionsRepo: klaviyoDeletionsRepo,
      pendingRepo: klaviyoPendingRepo,
      usersRepo: klaviyoUsersRepo,
      writesRepo: gantriWritesRepo,
      getActor: () => getActiveActor(),
      getActiveThread: () => getActiveThread(),
    }));
    logger.info('klaviyo connector registered');

    // Slack adapter shared by the confirmation handler, the poller, and the
    // file_shared deps. Reads `appRef` lazily so it's safe to construct here
    // before `buildSlackApp` runs.
    const klaviyoSlackAdapter = {
      async postMessage(channel: string, text: string, threadTs?: string) {
        await appRef!.client.chat.postMessage({ channel, text, thread_ts: threadTs });
      },
    };

    klaviyoConfirmationHandler = new ConfirmationHandler({
      pendingRepo: klaviyoPendingRepo,
      importsRepo: klaviyoImportsRepo,
      deletionsRepo: klaviyoDeletionsRepo,
      client: klaviyoClient,
      slack: klaviyoSlackAdapter,
      writesRepo: gantriWritesRepo,
    });

    klaviyoImportPoller = new KlaviyoImportPollerJob({
      importsRepo: klaviyoImportsRepo,
      pendingRepo: klaviyoPendingRepo,
      client: klaviyoClient,
      slack: klaviyoSlackAdapter,
      callerLookup: {
        async resolve(slackUserId: string) {
          // Resolve a caller's DM channel id by opening (idempotent) the IM
          // conversation. Used by the poller to DM the caller when their
          // import job completes / fails.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const im: any = await appRef!.client.conversations.open({ users: slackUserId });
          const ch = im?.channel?.id as string | undefined;
          return ch ? { slackUserId, dmChannelId: ch } : null;
        },
      },
    });

    // Storage adapter for file_shared CSV uploads. Persists the raw CSV in
    // the `klaviyo-imports` Supabase Storage bucket so we have a forensic
    // copy even after the import completes.
    const klaviyoStorageAdapter = {
      async upload(p: string, body: Buffer | string, contentType: string) {
        const objectPath = p.replace(/^klaviyo-imports\//, '');
        const { data, error } = await supabase.storage
          .from('klaviyo-imports')
          .upload(objectPath, body, { contentType, upsert: false });
        if (error) throw error;
        return { path: `klaviyo-imports/${data.path}` };
      },
    };

    klaviyoFileSharedDeps = {
      usersRepo: klaviyoUsersRepo,
      slack: {
        async filesInfo(fileId: string) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (await appRef!.client.files.info({ file: fileId })) as any;
        },
        async downloadFile(url: string) {
          const res = await fetch(url, { headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } });
          if (!res.ok) throw new Error(`download HTTP ${res.status}`);
          return Buffer.from(await res.arrayBuffer());
        },
        async postMessage(channel: string, text: string, threadTs?: string) {
          await appRef!.client.chat.postMessage({ channel, text, thread_ts: threadTs });
        },
      },
      orchestrator: {
        async runTool(name, args, actor) {
          // Route the CSV upload directly to klaviyo.import_profiles — no LLM
          // dispatch. The actor's role is stamped on the call so the tool's
          // role check passes (file_shared already verified admin/marketing).
          return await orchestrator.runToolDirect({
            toolName: name,
            args,
            actor: { slackUserId: actor.slackUserId, slackChannelId: actor.channelId },
            thread: { channelId: actor.channelId, threadTs: actor.threadTs ?? '' },
          });
        },
      },
      storage: klaviyoStorageAdapter,
      pendingRepo: klaviyoPendingRepo,
      // The header mapper (Haiku) needs an Anthropic client; the global
      // `claude` instance is constructed below (line ~310). We re-assign
      // this field after that construction so the deferred `buildSlackApp`
      // call sees a complete struct. (Cannot reference `claude` here yet
      // because it's created later in initialization.)
      // Filled in after `claude` is constructed.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      claude: undefined as any,
    };
  } else {
    logger.warn('klaviyo not configured (KLAVIYO_API_KEY missing) — skipping registration');
  }

  // Wire the GantriPorterConnector now that klaviyoClientRef is set (or
  // confirmed undefined). The write-tool deps (writesRepo + usersRepo +
  // getActor + klaviyoClient) enable gantri.update_customer_email; without
  // them the tool short-circuits with WRITE_DEPS_NOT_CONFIGURED. klaviyoClient
  // is genuinely optional — when Klaviyo is disabled the tool's syncKlaviyo
  // path becomes a no-op rather than erroring.
  gantriPorter = new GantriPorterConnector({
    baseUrl: porterApiBaseUrl,
    email: porterBotEmail,
    password: porterBotPassword,
    rollupRepo,
    writesRepo: gantriWritesRepo,
    usersRepo,
    getActor: () => getActiveActor(),
    klaviyoClient: klaviyoClientRef ?? undefined,
  });
  registry.register(gantriPorter);

  if (gscOauthClientId && gscOauthClientSecret && gscOauthRefreshToken) {
    registry.register(buildSearchConsoleConnector({
      clientId: gscOauthClientId,
      clientSecret: gscOauthClientSecret,
      refreshToken: gscOauthRefreshToken,
    }));
    logger.info('gsc connector registered');
  } else {
    logger.warn('gsc not configured (GSC_OAUTH_CLIENT_ID / GSC_OAUTH_CLIENT_SECRET / GSC_OAUTH_REFRESH_TOKEN missing) — skipping registration');
  }

  if (pipedriveApiToken) {
    const pipedriveClient = new PipedriveApiClient({ apiToken: pipedriveApiToken });
    const pipedriveWritesRepo = new PipedriveWritesRepo(supabase);
    // Local users repo (mirrors the Klaviyo block). The top-level `usersRepo`
    // const is constructed further down (line ~352) for buildSlackApp; we
    // can't reference it here without hoisting.
    const pipedriveUsersRepo = new AuthorizedUsersRepo(supabase);
    registry.register(new PipedriveConnector({
      client: pipedriveClient,
      writesRepo: pipedriveWritesRepo,
      usersRepo: pipedriveUsersRepo,
      getActor: () => getActiveActor(),
    }));
    logger.info('pipedrive connector registered');
  } else {
    logger.warn('pipedrive not configured (PIPEDRIVE_API_TOKEN missing) — skipping registration');
  }

  if (sendgridApiKey) {
    registry.register(new SendgridConnector({ client: new SendgridApiClient({ apiKey: sendgridApiKey }) }));
    logger.info('sendgrid connector registered');
  } else {
    logger.warn('sendgrid not configured (SENDGRID_API_KEY missing) — skipping registration');
  }

  const claude = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  // Backfill the Klaviyo file-shared deps with the freshly-constructed Anthropic
  // client (used by the LLM-driven CSV header mapper). When Klaviyo is disabled
  // klaviyoFileSharedDeps is undefined and the noop fallback (constructed below)
  // gets `claude` directly.
  if (klaviyoFileSharedDeps) klaviyoFileSharedDeps.claude = claude;

  // Asana connector — QA quality stats for Feature tickets on the Software
  // Board. Registered here (after `claude`) because its batched classifier
  // needs the shared Anthropic client. When configured it also loads the public
  // delivery-tier rubric prompt (used by the read-only preview tool AND, further
  // down, by the auto-classifier poller).
  let asanaClient: AsanaApiClient | undefined;
  let tierPrompt: string | undefined;
  let tierPromptVersion: number | undefined;
  let rubricSource: RubricSource | undefined;
  if (asanaAccessToken) {
    asanaClient = new AsanaApiClient({ accessToken: asanaAccessToken });

    // The rubric is READ FROM the live Notion "Delivery Tier Classifier" page at
    // runtime (Danny's decision): editing the page recalibrates the bot within one
    // poll cycle. The committed standard file is the fallback SNAPSHOT (page body) +
    // the repo-owned MACHINE APPENDIX (the signals JSON contract, stable under page
    // edits). Structural validation, an in-memory + Supabase last-known-good cache,
    // and an ops notice on adoption all live inside `RubricSource`.
    const standardFile = loadTierStandard();
    const { appendix } = splitStandard(standardFile);
    const fallbackRubric = buildFallbackRubric(standardFile);
    tierPrompt = fallbackRubric.promptText;
    tierPromptVersion = fallbackRubric.version;

    // Reuse the /review-flc Notion token (env override or vault). Absent → the
    // classifier runs on the committed fallback snapshot only (no live reload).
    const rubricNotionToken = env.NOTION_API_TOKEN ?? notionApiTokenVault;
    const rubricNotion = rubricNotionToken ? new NotionApiClient({ token: rubricNotionToken }) : undefined;
    const rubricOps = env.OPS_CHANNEL_ID
      ? {
          post: async (text: string) => {
            await appRef!.client.chat.postMessage({ channel: env.OPS_CHANNEL_ID!, text });
          },
        }
      : undefined;
    rubricSource = new RubricSource({
      pageId: DELIVERY_TIER_RUBRIC_PAGE_ID,
      appendix,
      fallback: fallbackRubric,
      notion: rubricNotion,
      cache: new TierRubricCacheRepo(supabase),
      ops: rubricOps,
    });
    try {
      await rubricSource.init();
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'delivery tier rubric init failed — using committed fallback snapshot',
      );
    }

    registry.register(new AsanaConnector({
      client: asanaClient,
      claude,
      tierPrompt,
      tierPromptVersion,
      rubricSource,
    }));
    logger.info(
      { tierPromptVersion: rubricSource.getRubric().version, liveRubric: !!rubricNotion },
      'asana connector registered',
    );
  } else {
    logger.warn('asana not configured (ASANA_ACCESS_TOKEN missing) — skipping registration');
  }

  const orchestrator = new Orchestrator({
    registry,
    claude,
    model: 'claude-sonnet-4-6',
    // Cross-pool failover: when the Sonnet pool is overloaded (529s),
    // fall through to Haiku rather than surfacing a raw JSON error.
    fallbackModels: ['claude-haiku-4-5-20251001'],
    maxIterations: 8,
    maxOutputTokens: 16384,
  });

  const reportsRepo = new ReportSubscriptionsRepo(supabase);
  const reportsConnector = new ScheduledReportsConnector({
    repo: reportsRepo,
    getActor: () => {
      const actor = getActiveActor();
      if (!actor) throw new Error('reports.* tool called without an actor context');
      return actor;
    },
    compile: (intent) =>
      compilePlan({
        intent,
        registry,
        claude,
        model: 'claude-sonnet-4-6',
        fallbackModels: ['claude-haiku-4-5-20251001'],
      }),
    execute: (plan, runAt, timezone) => executePlan({ plan, registry, runAt, timezone }),
    nextFireAt: (cron, tz, after) => computeNextFireAt(cron, tz, after),
  });
  registry.register(reportsConnector);

  // usersRepo is hoisted above (before GantriPorterConnector) so the write-tool
  // deps can pick it up; reuse the same instance here.
  const conversationsRepo = new ConversationsRepo(supabase);

  // No-op fallbacks for environments where Klaviyo isn't configured. The bot
  // still boots and responds to DMs; only the Klaviyo write paths are dead.
  const noopConfirmationHandler = {
    tryHandle: async () => false,
    // The handler.tryHandle() is the only method called from the message
    // handler, but we cast to ConfirmationHandler so the structural shape
    // satisfies HandlerDeps.confirmationHandler.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as ConfirmationHandler;
  const noopFileSharedDeps: FileSharedDeps = {
    usersRepo: { getRole: async () => null },
    slack: {
      filesInfo: async () => ({ ok: false }),
      downloadFile: async () => Buffer.alloc(0),
      postMessage: async () => {},
    },
    orchestrator: { runTool: async () => ({}) },
    storage: { upload: async () => ({ path: '' }) },
    pendingRepo: { insert: async () => ({ id: '', confirmationToken: '' }) },
    claude,
  };

  // GITHUB_TOKEN / VERCEL_TOKEN may come from Vault if not in env:
  const githubToken = env.GITHUB_TOKEN ?? (await readVaultSecret(supabase, 'GITHUB_TOKEN').catch(() => null));
  const vercelToken = env.VERCEL_TOKEN ?? (await readVaultSecret(supabase, 'VERCEL_TOKEN').catch(() => null));
  const devopsEnabled = !!(env.OPS_CHANNEL_ID && githubToken);
  const jobsRepo = new DevopsJobsRepo(supabase);
  const gh = devopsEnabled ? new GithubDispatcher({ token: githubToken!, owner: env.GITHUB_OWNER }) : null;
  const vercel = vercelToken && env.VERCEL_TEAM_ID
    ? new VercelClient({ token: vercelToken, teamId: env.VERCEL_TEAM_ID })
    : null;
  const qaseToken = env.QASE_API_TOKEN ?? (await readVaultSecret(supabase, 'QASE_API_TOKEN').catch(() => null));
  const qase = qaseToken ? new QaseClient(qaseToken) : null;

  // /review-flc — review an FLC's Notion page against the canonical Gantri
  // standard and post selected findings as comments. Constructed only when a
  // Notion token is configured (env override or vault), mirroring the optional
  // connector pattern above. The review standard markdown is loaded once here.
  const notionApiToken = env.NOTION_API_TOKEN ?? notionApiTokenVault;
  let notionClient: NotionApiClient | undefined;
  let reviewStandard: string | undefined;
  let flcReviewStore: ReviewStateStore | undefined;
  if (notionApiToken) {
    notionClient = new NotionApiClient({ token: notionApiToken });
    reviewStandard = loadReviewStandard();
    // Persist review state in Postgres so the result-message buttons keep working
    // across bot restarts / redeploys (the previous in-memory store lost it).
    const flcReviewsRepo = new FlcReviewsRepo(supabase);
    flcReviewStore = {
      save: (ts, s) => flcReviewsRepo.save({ messageTs: ts, ...s }),
      get: (ts) =>
        flcReviewsRepo
          .get(ts)
          .then((r) => (r ? { pageId: r.pageId, url: r.url, findings: r.findings, channel: r.channel } : null)),
      delete: (ts) => flcReviewsRepo.delete(ts),
    };
    logger.info('notion connector configured — /review-flc enabled');
  } else {
    logger.warn('notion not configured (NOTION_API_TOKEN missing) — skipping /review-flc registration');
  }

  const { app, receiver } = buildSlackApp({
    orchestrator,
    usersRepo,
    conversationsRepo,
    confirmationHandler: klaviyoConfirmationHandler ?? noopConfirmationHandler,
    fileSharedDeps: klaviyoFileSharedDeps ?? noopFileSharedDeps,
    // When Klaviyo is disabled we still need structurally-valid stubs so
    // createDmHandler doesn't crash on the pending-context lookup path.
    pendingRepo: klaviyoPendingRepoRef ?? { lookupByThread: async () => null },
    klaviyoClient: klaviyoClientRef ?? { listLists: async () => [] },
    registerExtra: (a) => {
      if (devopsEnabled) {
        const dmUserIds = (env.DEVOPS_DM_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        registerPreviewCommand(a, { repo: jobsRepo, slack: a.client, opsChannelId: env.OPS_CHANNEL_ID!, dmUserIds, gh: gh!, vercel: vercel ?? undefined });
        registerDeployCommand(a, { repo: jobsRepo, slack: a.client, opsChannelId: env.OPS_CHANNEL_ID!, dmUserIds, gh: gh! });
        registerE2eCommand(a, { repo: jobsRepo, slack: a.client, opsChannelId: env.OPS_CHANNEL_ID!, dmUserIds, gh: gh! });
        registerCronCommand(a, { repo: jobsRepo, slack: a.client, opsChannelId: env.OPS_CHANNEL_ID!, dmUserIds, gh: gh! });
      }
      // /review-flc is usable in any conversation (no ops-channel gating), so
      // it registers independently of the devops block — only the Notion token
      // gates it.
      if (notionClient && reviewStandard) {
        registerReviewFlcCommand(a, {
          notion: notionClient,
          slack: a.client,
          store: flcReviewStore!,
          review: (input) =>
            reviewFlc(
              {
                claude,
                model: 'claude-sonnet-4-6',
                fallbackModels: ['claude-haiku-4-5-20251001'],
                reviewStandard: reviewStandard!,
              },
              input,
            ),
        });
        moduleStatus.flcReview = true;
        logger.info('/review-flc command registered');
      }
    },
  });
  // Adapters above capture this `appRef` thunk lazily — they were constructed
  // before `app` existed. Assigning here makes them functional immediately
  // (the first DM the bot receives goes through a fully-initialized client).
  appRef = app;

  // Resolve the bot's own user_id once at startup and stamp it onto the
  // file_shared deps. The handler uses it to drop file_shared events
  // triggered by the bot's own uploads (e.g. canvas attachments produced
  // while answering analytics queries) — without this filter those events
  // fall through to the role check and surface a misleading "requires
  // admin or marketing role" reply to the human user.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const authTest: any = await app.client.auth.test();
    const botUserId = authTest?.user_id as string | undefined;
    if (botUserId && klaviyoFileSharedDeps) {
      klaviyoFileSharedDeps.botUserId = botUserId;
      logger.info({ botUserId }, 'bot user_id resolved');
    } else {
      logger.warn({ authTest }, 'auth.test returned no user_id — file_shared self-ignore disabled');
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'auth.test failed at startup');
  }

  // ReportsConnector hooks Slack's canvases API + the per-run actor context,
  // so it can only be built once `app.client` exists. The actor closure
  // reads from the AsyncLocalStorage-backed run context (see
  // orchestrator.ts: getActiveActor/getActiveThread/runWithContext).
  registry.register(
    new ReportsConnector({
      slackClient: app.client,
      getActor: () => getActiveActor(),
    }),
  );

  // BroadcastConnector — admin-only one-off DM-blast to every authorized user.
  // Same Slack-client + actor-context pattern as ReportsConnector.
  registry.register(
    new BroadcastConnector({
      slackClient: app.client,
      usersRepo,
      conversationsRepo,
      maintainerSlackUserId: env.MAINTAINER_SLACK_USER_ID,
      getActor: () => {
        const a = getActiveActor();
        if (!a) throw new Error('bot.broadcast_notification called without an actor context');
        return a;
      },
    }),
  );

  // Feedback connector — same pattern: needs Slack client + per-run actor +
  // per-run thread context. Registered after Reports, before CachingRegistry
  // wraps the registry.
  const feedbackRepo = new FeedbackRepo(supabase);
  registry.register(
    new FeedbackConnector({
      repo: feedbackRepo,
      conversationsRepo,
      slackClient: app.client,
      maintainerSlackUserId: env.MAINTAINER_SLACK_USER_ID,
      getActor: () => getActiveActor(),
      getThread: () => getActiveThread(),
    }),
  );

  const publishedReportsRepo = new PublishedReportsRepo(supabase);
  registry.register(
    new LiveReportsConnector({
      repo: publishedReportsRepo,
      claude,
      model: 'claude-sonnet-4-6',
      fallbackModels: ['claude-haiku-4-5-20251001'],
      registry: registry,                    // will be wrapped by cachingRegistry below; fine for tool execution
      getToolCatalog: () => registry.getAllTools()
        .map((t) => `${t.name}:\n${JSON.stringify(t.jsonSchema, null, 2)}`)
        .join('\n\n---\n\n'),
      publicBaseUrl: process.env.PUBLIC_BASE_URL || 'https://gantri-ai-bot.fly.dev',
      getActor: () => {
        const a = getActiveActor();
        if (!a) throw new Error('live reports tool called without actor');
        return a;
      },
      getRoleForActor: (slackUserId) => usersRepo.getRole(slackUserId),
      slackClient: app.client,
      liveCatalogs: new LiveCatalogs(nbClient),
    }),
  );

  // Wrap the populated registry with a caching layer. Every subsequent
  // `cachingRegistry.execute(...)` consults the per-tool CachePolicy and
  // short-circuits closed-period queries to the cache. The Orchestrator was
  // already wired with the raw `registry` — that's fine because it reads
  // tools lazily and we want the caching layer in front of execute calls.
  const cache = new TtlCache(supabase);
  const cachingRegistry = new CachingRegistry(registry, cache, DEFAULT_CACHE_POLICIES);
  // Switch the orchestrator over to the caching layer. From this point on all
  // orchestrator.run() calls go through cachingRegistry.execute(...).
  orchestrator.setRegistry(cachingRegistry as unknown as ConnectorRegistry);

  // Reflect whether the wholesale product-export connector got wired (its tools
  // are namespaced `products.*`). Deployed-but-not-merged today, so this reads
  // false on main — but it flips true automatically the moment the connector is
  // registered, giving the build endpoint an honest per-module boot signal.
  moduleStatus.productExport = registry.getAllTools().some((t) => t.name.startsWith('products.'));

  // Liveness check — only verifies the HTTP server is up.
  // Must stay fast (<1s) so Fly health checks don't trigger auth flows on boot.
  receiver.router.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  // Readiness / deep check — exercises downstream auth and DB. Call manually.
  receiver.router.get('/readyz', async (_req, res) => {
    const [nb, gp, gf] = await Promise.all([
      northbeamApi.healthCheck(),
      gantriPorter.healthCheck(),
      grafana.healthCheck(),
    ]);
    const ok = nb.ok && gp.ok && gf.ok;
    res.status(ok ? 200 : 503).json({ ok, northbeam: nb, gantriPorter: gp, grafana: gf });
  });

  // Build fingerprint + boot-time module ledger. NO auth — it leaks nothing
  // sensitive (a commit sha + booleans). `modules.tier` reports the live prompt
  // version only once the tier runner actually started (see below), so a Fly
  // clobber that drops the classifier shows up here as `tier: false`. Reads the
  // live `moduleStatus` object, so flags flipped later in boot are reflected.
  receiver.router.get('/internal/build', (_req, res) => {
    res.status(200).json(renderBuildInfo(buildStamp, moduleStatus));
  });

  const reportsRunner = new ReportsRunner({
    repo: reportsRepo,
    registry,
    slackClient: app.client,
    slackBotToken: env.SLACK_BOT_TOKEN,
    claude,
    compilerModel: 'claude-sonnet-4-6',
    compilerFallbackModels: ['claude-haiku-4-5-20251001'],
  });

  receiver.router.post('/internal/run-due-reports', async (req, res) => {
    const auth = req.header('x-internal-secret');
    if (!process.env.INTERNAL_SHARED_SECRET || auth !== process.env.INTERNAL_SHARED_SECRET) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    const result = await reportsRunner.tick();
    res.json({ ok: true, result });
  });

  // Delivery-tier auto-classifier. Runs only when Asana is configured (the same
  // gate as the connector). The runner polls the Software Board every 5 minutes,
  // classifies tasks that need a tier, and — on the same tick — sends the
  // idempotent Monday report. `POST /internal/run-tier-poll` forces a tick for
  // smoke tests and manual runs.
  let tierRunner: TierRunner | undefined;
  if (asanaClient && tierPrompt && tierPromptVersion !== undefined) {
    const rolloutDateMs = Date.parse(env.ROLLOUT_DATE);
    if (Number.isNaN(rolloutDateMs)) {
      throw new Error(`ROLLOUT_DATE is not a valid date: ${env.ROLLOUT_DATE}`);
    }
    const tierClassificationsRepo = new TierClassificationsRepo(supabase);
    const tierWeeklyRepo = new TierWeeklyReportsRepo(supabase);
    const tierPrChecksRepo = new TierPrChecksRepo(supabase);

    // Code-Review authoritative pass. Needs a GitHub client to read PR diffs; reuse
    // the devops dispatcher when it exists, otherwise build one from the token
    // alone. Disabled (provisional-only classification) when there is no token.
    const tierGh =
      gh ?? (githubToken ? new GithubDispatcher({ token: githubToken, owner: env.GITHUB_OWNER }) : null);
    // Code-review Slack requests: the authoritative pass pings reviewers in the
    // software channel the first time it classifies a ticket. Optional — one boot
    // warn when the channel is not configured.
    const reviewRequest = env.SOFTWARE_CHANNEL_ID
      ? new ReviewRequestNotifier({ slack: app.client, channelId: env.SOFTWARE_CHANNEL_ID })
      : undefined;
    if (!reviewRequest) {
      logger.warn('code-review Slack requests disabled — SOFTWARE_CHANNEL_ID not set');
    }
    const authoritative = tierGh
      ? new AuthoritativePass({
          gh: tierGh,
          client: asanaClient,
          classifications: tierClassificationsRepo,
          prChecks: tierPrChecksRepo,
          extract: { claude, prompt: tierPrompt },
          promptVersion: tierPromptVersion,
          reviewRequest,
          rubric: rubricSource,
        })
      : undefined;
    if (!authoritative) {
      logger.warn('delivery tier Code-Review authoritative pass disabled — no GITHUB_TOKEN configured');
    }

    const tierPoller = new TierPoller({
      client: asanaClient,
      repo: tierClassificationsRepo,
      extract: { claude, prompt: tierPrompt },
      promptVersion: tierPromptVersion,
      rubric: rubricSource,
      rolloutDateMs,
      authoritative,
    });
    // Resolve Danny's Slack id from the authorized_users table (by either known
    // email), falling back to the env override.
    const resolveDannySlackId = async (): Promise<string | null> => {
      try {
        const users = await usersRepo.listAll();
        const danny = users.find(
          (u) => u.email === 'danny@gantri.com' || u.email === 'danier.estevez@gmail.com',
        );
        if (danny) return danny.slackUserId;
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'resolve danny slack id failed');
      }
      return env.DANNY_SLACK_USER_ID ?? null;
    };
    const tierReporter = new WeeklyTierReporter({
      classifications: tierClassificationsRepo,
      weeklyRepo: tierWeeklyRepo,
      prChecks: tierPrChecksRepo,
      client: asanaClient,
      slack: app.client,
      resolveDannySlackId,
      opsChannelId: env.OPS_CHANNEL_ID,
    });
    tierRunner = new TierRunner({ poller: tierPoller, reporter: tierReporter });

    // Forces a poll tick (provisional classification + the Code-Review
    // authoritative pass, which is now folded into the poll) for smoke tests and
    // manual runs. The former standalone `/internal/run-pr-recheck` sweep is gone:
    // PR lookup is driven by tickets entering Code Review, inside this same tick.
    receiver.router.post('/internal/run-tier-poll', async (req, res) => {
      const auth = req.header('x-internal-secret');
      if (!process.env.INTERNAL_SHARED_SECRET || auth !== process.env.INTERNAL_SHARED_SECRET) {
        return res.status(403).json({ ok: false, error: 'forbidden' });
      }
      const result = await tierRunner!.tick();
      res.json({ ok: true, result });
    });
  }

  // POST /internal/recompile-report — admin-only endpoint to recompile a report spec.
  // Body: { slug: string; intent: string; actorSlackId?: string }
  // Header: x-internal-secret
  receiver.router.post('/internal/recompile-report', async (req, res) => {
    const auth = req.header('x-internal-secret');
    if (!process.env.INTERNAL_SHARED_SECRET || auth !== process.env.INTERNAL_SHARED_SECRET) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    const { slug, intent, actorSlackId } = req.body as { slug?: string; intent?: string; actorSlackId?: string };
    if (!slug || !intent) return res.status(400).json({ ok: false, error: 'slug and intent required' });
    try {
      const actor = { slackUserId: actorSlackId ?? 'UK0JM2PTM' };
      const result = await runWithContext({ actor }, () =>
        registry.execute('reports.recompile_report', { slug, newIntent: intent, regenerateToken: false }),
      );
      res.json({ ok: true, result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, slug }, 'internal recompile failed');
      res.status(500).json({ ok: false, error: msg });
    }
  });

  // Live Reports HTML SPA + data endpoint
  const __filename = fileURLToPath(import.meta.url);
  const webDistDir = path.resolve(path.dirname(__filename), '..', 'web', 'dist');
  // receiver.app is express.Application; Express interface extends it with
  // extra properties not needed at runtime. Cast is safe here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mountLiveReportsRoutes(receiver.app as any, {
    repo: publishedReportsRepo,
    registry: cachingRegistry,
    webDistDir,
    slackClient: app.client as unknown as never,
    feedbackRepo,
    maintainerSlackUserId: env.MAINTAINER_SLACK_USER_ID,
  });

  await app.start(env.PORT);
  logger.info({ port: env.PORT }, 'gantri-ai-bot listening');

  reportsRunner.start();

  if (tierRunner) {
    tierRunner.start();
    // Report the live prompt version at /internal/build ONLY now that the runner
    // is actually running — this is the exact signal the deploy canary watches.
    moduleStatus.tier = tierPromptVersion!;
    logger.info('delivery tier runner started');
  }

  if (devopsEnabled && gh) {
    const jobsRunner = new JobsRunner({
      repo: jobsRepo, slack: app.client, gh, vercel: vercel ?? undefined, qase: qase ?? undefined,
      advance: (job, d) =>
        job.kind === 'deploy' ? advanceDeployJob(job, d)
        : job.kind === 'e2e' ? advanceE2eJob(job, d)
        : job.kind === 'cron' ? advanceCronJob(job, d)
        : advancePreviewJob(job, d),
    });
    jobsRunner.start();
    moduleStatus.devops = true;
    logger.info({ vercelWiring: !!vercel }, 'devops jobs runner started');
  } else {
    logger.warn('devops disabled — set OPS_CHANNEL_ID + GITHUB_TOKEN to enable /preview');
  }

  // Start the Klaviyo import-status poller now that the Slack client is live
  // (its `slack` adapter dereferences `appRef!.client`). Skipped entirely
  // when KLAVIYO_API_KEY isn't configured.
  if (klaviyoImportPoller) {
    klaviyoImportPoller.start();
    logger.info('klaviyo import poller started');
  }

  // RollupRefreshJob is no longer started — sales numbers now come live from
  // Grafana via SalesReportConnector. The rollup table + refresh code stay in
  // the tree as deprecated for emergency rollback. Re-enable by uncommenting:
  //   const rollupJob = new RollupRefreshJob({ grafana, repo: rollupRepo });
  //   rollupJob.start();
  void RollupRefreshJob; // silence unused-import lint
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.stack : String(err) }, 'fatal');
  process.exit(1);
});
