/**
 * @deprecated 2026-04-25 — replaced by `src/connectors/northbeam-api/connector.ts`,
 * which talks to the official Northbeam REST API. This Playwright-based
 * connector got blocked by NB's anti-bot detection (the scraping account was
 * suspended; even after manual unblock the heuristic flag kept timing out
 * queries). It is kept in the codebase as an emergency fallback only — DO NOT
 * register it in `src/index.ts`. To resurrect for a one-off, swap the
 * `registry.register(northbeamApi)` call for `registry.register(northbeamLegacy)`
 * in main(). The official API does not currently expose per-order attribution
 * (touchpoints, channel-attributed-flag, per-order first-time/returning), so
 * if a need for those resurfaces this is the bridge until/unless NB ships an
 * official endpoint.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Connector, ToolDef } from '../base/connector.js';
import { NorthbeamAuthManager, type Credentials } from './auth-manager.js';
import { NorthbeamGraphqlClient } from './graphql-client.js';
import { playwrightLogin } from './playwright-login.js';
import { buildNorthbeamTools } from './tools.js';
import { TtlCache } from '../../storage/cache.js';
import { NorthbeamTokensRepo } from '../../storage/repositories/northbeam-tokens.js';

export interface NorthbeamConnectorOptions {
  supabase: SupabaseClient;
  credentials: Credentials;
}

export class NorthbeamConnector implements Connector {
  readonly name = 'northbeam';
  readonly tools: readonly ToolDef[];

  private readonly gql: NorthbeamGraphqlClient;
  private readonly auth: NorthbeamAuthManager;

  constructor(opts: NorthbeamConnectorOptions) {
    const tokensRepo = new NorthbeamTokensRepo(opts.supabase);
    this.auth = new NorthbeamAuthManager({
      credentials: opts.credentials,
      tokensRepo,
      playwrightLogin,
    });
    this.gql = new NorthbeamGraphqlClient({
      dashboardId: opts.credentials.dashboardId,
      getToken: () => this.auth.getAccessToken(),
    });
    const cache = new TtlCache(opts.supabase);
    this.tools = buildNorthbeamTools({ gql: this.gql, cache });
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.auth.getAccessToken();
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
