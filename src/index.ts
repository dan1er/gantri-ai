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
import { NorthbeamConnector } from './connectors/northbeam/northbeam-connector.js';
import { NorthbeamApiConnector } from './connectors/northbeam-api/connector.js';
import { NorthbeamApiClient } from './connectors/northbeam-api/client.js';
import { MarketingAnalysisConnector } from './connectors/marketing-analysis/connector.js';
import { ReportsConnector } from './connectors/reports/reports-connector.js';
import { FeedbackConnector } from './connectors/feedback/feedback-connector.js';
import { FeedbackRepo } from './storage/repositories/feedback.js';
import { BroadcastConnector } from './connectors/broadcast/broadcast-connector.js';
import { LiveReportsConnector } from './connectors/live-reports/connector.js';
import { PublishedReportsRepo } from './storage/repositories/published-reports.js';
import { mountLiveReportsRoutes } from './server/live-reports-routes.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GantriPorterConnector } from './connectors/gantri-porter/gantri-porter-connector.js';
import { GrafanaConnector } from './connectors/grafana/grafana-connector.js';
import { Ga4Client } from './connectors/ga4/client.js';
import { Ga4Connector } from './connectors/ga4/connector.js';
import { Orchestrator, getActiveActor, getActiveThread, runWithContext } from './orchestrator/orchestrator.js';
import { buildSlackApp } from './slack/app.js';
import { ReportSubscriptionsRepo } from './reports/reports-repo.js';
import { ScheduledReportsConnector } from './reports/reports-connector.js';
import { compilePlan } from './reports/plan-compiler.js';
import { executePlan } from './reports/plan-executor.js';
import { computeNextFireAt } from './reports/cron-utils.js';
import { ReportsRunner } from './reports/runner.js';

async function main() {
  const env = loadEnv();
  const supabase = getSupabase();

  const [
    email, password, dashboardId,
    nbApiKey, nbDataClientId,
    porterApiBaseUrl, porterBotEmail, porterBotPassword,
    grafanaUrl, grafanaToken, grafanaPostgresDsUid,
    ga4PropertyId, ga4ServiceAccountKey,
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

  const gantriPorter = new GantriPorterConnector({
    baseUrl: porterApiBaseUrl,
    email: porterBotEmail,
    password: porterBotPassword,
    rollupRepo,
  });
  registry.register(gantriPorter);

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

  if (ga4PropertyId && ga4ServiceAccountKey) {
    const ga4 = new Ga4Connector({
      client: new Ga4Client({ propertyId: ga4PropertyId, serviceAccountKey: ga4ServiceAccountKey }),
    });
    registry.register(ga4);
    logger.info({ propertyId: ga4PropertyId }, 'ga4 connector registered');
  } else {
    logger.warn('ga4 not configured (GA4_PROPERTY_ID and/or GA4_SERVICE_ACCOUNT_KEY missing) — skipping registration');
  }

  const claude = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const orchestrator = new Orchestrator({
    registry,
    claude,
    model: 'claude-sonnet-4-6',
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
      }),
    execute: (plan, runAt, timezone) => executePlan({ plan, registry, runAt, timezone }),
    nextFireAt: (cron, tz, after) => computeNextFireAt(cron, tz, after),
  });
  registry.register(reportsConnector);

  const usersRepo = new AuthorizedUsersRepo(supabase);
  const conversationsRepo = new ConversationsRepo(supabase);

  const { app, receiver } = buildSlackApp({ orchestrator, usersRepo, conversationsRepo });

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

  const reportsRunner = new ReportsRunner({
    repo: reportsRepo,
    registry,
    slackClient: app.client,
    slackBotToken: env.SLACK_BOT_TOKEN,
    claude,
    compilerModel: 'claude-sonnet-4-6',
  });

  receiver.router.post('/internal/run-due-reports', async (req, res) => {
    const auth = req.header('x-internal-secret');
    if (!process.env.INTERNAL_SHARED_SECRET || auth !== process.env.INTERNAL_SHARED_SECRET) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    const result = await reportsRunner.tick();
    res.json({ ok: true, result });
  });

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
  });

  await app.start(env.PORT);
  logger.info({ port: env.PORT }, 'gantri-ai-bot listening');

  reportsRunner.start();

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
