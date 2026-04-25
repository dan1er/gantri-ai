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
import { RollupConnector } from './connectors/rollup/rollup-connector.js';
import { RollupRefreshJob } from './connectors/rollup/rollup-refresh.js';
import { LateOrdersConnector } from './connectors/late-orders/late-orders-connector.js';
import { NorthbeamConnector } from './connectors/northbeam/northbeam-connector.js';
import { ReportsConnector } from './connectors/reports/reports-connector.js';
import { FeedbackConnector } from './connectors/feedback/feedback-connector.js';
import { FeedbackRepo } from './storage/repositories/feedback.js';
import { GantriPorterConnector } from './connectors/gantri-porter/gantri-porter-connector.js';
import { GrafanaConnector } from './connectors/grafana/grafana-connector.js';
import { Orchestrator, getActiveActor, getActiveThread } from './orchestrator/orchestrator.js';
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
    porterApiBaseUrl, porterBotEmail, porterBotPassword,
    grafanaUrl, grafanaToken, grafanaPostgresDsUid,
  ] = await Promise.all([
    readVaultSecret(supabase, 'NORTHBEAM_EMAIL'),
    readVaultSecret(supabase, 'NORTHBEAM_PASSWORD'),
    readVaultSecret(supabase, 'NORTHBEAM_DASHBOARD_ID'),
    readVaultSecret(supabase, 'PORTER_API_BASE_URL'),
    readVaultSecret(supabase, 'PORTER_BOT_EMAIL'),
    readVaultSecret(supabase, 'PORTER_BOT_PASSWORD'),
    readVaultSecret(supabase, 'GRAFANA_URL'),
    readVaultSecret(supabase, 'GRAFANA_TOKEN'),
    readVaultSecret(supabase, 'GRAFANA_POSTGRES_DS_UID'),
  ]);

  const registry = new ConnectorRegistry();
  const northbeam = new NorthbeamConnector({
    supabase,
    credentials: { email, password, dashboardId },
  });
  registry.register(northbeam);
  // ReportsConnector needs the Slack WebClient (for canvases.* APIs), so we
  // construct + register it AFTER buildSlackApp() below, where `app.client`
  // is available. The orchestrator reads tools lazily on each run, so
  // late-registration is safe.

  const gantriPorter = new GantriPorterConnector({
    baseUrl: porterApiBaseUrl,
    email: porterBotEmail,
    password: porterBotPassword,
  });
  registry.register(gantriPorter);

  const grafana = new GrafanaConnector({
    baseUrl: grafanaUrl,
    token: grafanaToken,
    postgresDsUid: grafanaPostgresDsUid,
  });
  registry.register(grafana);

  const rollupRepo = new RollupRepo(supabase);
  registry.register(new RollupConnector({ repo: rollupRepo }));

  registry.register(new LateOrdersConnector({ grafana }));

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
      northbeam.healthCheck(),
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

  await app.start(env.PORT);
  logger.info({ port: env.PORT }, 'gantri-ai-bot listening');

  reportsRunner.start();

  const rollupJob = new RollupRefreshJob({ grafana, repo: rollupRepo });
  rollupJob.start();
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.stack : String(err) }, 'fatal');
  process.exit(1);
});
