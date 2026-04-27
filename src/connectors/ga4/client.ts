import { GoogleAuth, type AuthClient } from 'google-auth-library';
import { logger } from '../../logger.js';

export interface Ga4ClientConfig {
  propertyId: string;
  /** The full service-account JSON, as a string. */
  serviceAccountKey: string;
  /** Defaults to the v1beta endpoint. */
  baseUrl?: string;
  /** Optional fetch override, for tests. */
  fetchImpl?: typeof fetch;
  /** Optional auth-client factory override, for tests. Production code lets it default. */
  authFactory?: (key: unknown) => Pick<AuthClient, 'getRequestHeaders'>;
}

const TOKEN_CACHE_TTL_MS = 50 * 60 * 1000; // 50 min — token expires in 60.

export class Ga4Client {
  private cachedHeaders: Record<string, string> | null = null;
  private cachedAt = 0;
  private readonly fetch: typeof fetch;

  constructor(private readonly cfg: Ga4ClientConfig) {
    this.fetch = cfg.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    if (this.cachedHeaders && Date.now() - this.cachedAt < TOKEN_CACHE_TTL_MS) {
      return this.cachedHeaders;
    }
    const credentials = JSON.parse(this.cfg.serviceAccountKey) as Record<string, unknown>;
    const factory = this.cfg.authFactory ?? ((c: unknown) =>
      new GoogleAuth({
        credentials: c as { client_email: string; private_key: string },
        scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
      }).getClient());
    const client = await Promise.resolve(factory(credentials));
    const headers = await client.getRequestHeaders();
    this.cachedHeaders = headers as Record<string, string>;
    this.cachedAt = Date.now();
    logger.debug({ propertyId: this.cfg.propertyId }, 'ga4 access token refreshed');
    return this.cachedHeaders;
  }
}
