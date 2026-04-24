import Anthropic from '@anthropic-ai/sdk';
import { loadEnv } from './config/env.js';
import { logger } from './logger.js';
import { getSupabase, readVaultSecret } from './storage/supabase.js';
import { AuthorizedUsersRepo } from './storage/repositories/authorized-users.js';
import { ConversationsRepo } from './storage/repositories/conversations.js';
import { ConnectorRegistry } from './connectors/base/registry.js';
import { NorthbeamConnector } from './connectors/northbeam/northbeam-connector.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { buildSlackApp } from './slack/app.js';

async function main() {
  const env = loadEnv();
  const supabase = getSupabase();

  const [email, password, dashboardId] = await Promise.all([
    readVaultSecret(supabase, 'NORTHBEAM_EMAIL'),
    readVaultSecret(supabase, 'NORTHBEAM_PASSWORD'),
    readVaultSecret(supabase, 'NORTHBEAM_DASHBOARD_ID'),
  ]);

  const registry = new ConnectorRegistry();
  const northbeam = new NorthbeamConnector({
    supabase,
    credentials: { email, password, dashboardId },
  });
  registry.register(northbeam);

  const claude = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const orchestrator = new Orchestrator({
    registry,
    claude,
    model: 'claude-sonnet-4-6',
    maxIterations: 5,
    maxOutputTokens: 4096,
  });

  const usersRepo = new AuthorizedUsersRepo(supabase);
  const conversationsRepo = new ConversationsRepo(supabase);

  const { app, receiver } = buildSlackApp({ orchestrator, usersRepo, conversationsRepo });

  // Liveness check — only verifies the HTTP server is up.
  // Must stay fast (<1s) so Fly health checks don't trigger auth flows on boot.
  receiver.router.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  // Readiness / deep check — exercises downstream auth. Call manually or via a scheduled probe.
  receiver.router.get('/readyz', async (_req, res) => {
    const nb = await northbeam.healthCheck();
    res.status(nb.ok ? 200 : 503).json({ ok: nb.ok, northbeam: nb });
  });

  await app.start(env.PORT);
  logger.info({ port: env.PORT }, 'gantri-ai-bot listening');
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.stack : String(err) }, 'fatal');
  process.exit(1);
});
