import type { NorthbeamTokensRepo, TokenRow } from '../../storage/repositories/northbeam-tokens.js';

const AUTH0_ENDPOINT = 'https://auth.northbeam.io/oauth/token';
const AUTH0_CLIENT_ID = 'SAwznFb2ZPmCiduOv0lKqZ55o5155cD8';
const AUTH0_AUDIENCE = 'https://api.northbeam.io';
const REFRESH_BUFFER_SECONDS = 15 * 60;

export interface Credentials {
  email: string;
  password: string;
  dashboardId: string;
}

export interface PlaywrightLogin {
  (creds: Credentials): Promise<{ accessToken: string; expiresIn: number }>;
}

export interface AuthManagerOptions {
  credentials: Credentials;
  tokensRepo: NorthbeamTokensRepo;
  playwrightLogin: PlaywrightLogin;
}

export class NorthbeamAuthManager {
  private inflight: Promise<string> | null = null;

  constructor(private readonly opts: AuthManagerOptions) {}

  async getAccessToken(): Promise<string> {
    const cached = await this.opts.tokensRepo.get();
    if (cached && !this.isNearExpiry(cached.expires_at)) {
      return cached.access_token;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private isNearExpiry(expiresAtIso: string): boolean {
    const msLeft = new Date(expiresAtIso).getTime() - Date.now();
    return msLeft < REFRESH_BUFFER_SECONDS * 1000;
  }

  private async refresh(): Promise<string> {
    const fromRopc = await this.tryRopc();
    if (fromRopc) {
      await this.store(fromRopc.accessToken, fromRopc.expiresIn, 'ropc');
      return fromRopc.accessToken;
    }
    const fromPw = await this.opts.playwrightLogin(this.opts.credentials);
    await this.store(fromPw.accessToken, fromPw.expiresIn, 'playwright');
    return fromPw.accessToken;
  }

  private async tryRopc(): Promise<{ accessToken: string; expiresIn: number } | null> {
    const res = await fetch(AUTH0_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        username: this.opts.credentials.email,
        password: this.opts.credentials.password,
        audience: AUTH0_AUDIENCE,
        client_id: AUTH0_CLIENT_ID,
        scope: 'openid profile email',
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token || !body.expires_in) return null;
    return { accessToken: body.access_token, expiresIn: body.expires_in };
  }

  private async store(
    accessToken: string,
    expiresIn: number,
    method: TokenRow['last_refresh_method'],
  ): Promise<void> {
    await this.opts.tokensRepo.upsert({
      access_token: accessToken,
      expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      last_refresh_method: method,
    });
  }
}
