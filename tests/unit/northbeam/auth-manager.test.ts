import { describe, it, expect, vi, afterEach } from 'vitest';
import { NorthbeamAuthManager } from '../../../src/connectors/northbeam/auth-manager.js';

function makeValidJwt(expSecondsFromNow: number) {
  const payload = { exp: Math.floor(Date.now() / 1000) + expSecondsFromNow };
  const b64 = (s: string) => Buffer.from(s).toString('base64url');
  return `${b64('{}')}.${b64(JSON.stringify(payload))}.sig`;
}

describe('NorthbeamAuthManager (ROPC)', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  function makeRepo() {
    let row: any = null;
    return {
      get: vi.fn(async () => row),
      upsert: vi.fn(async (r: any) => { row = r; }),
      _peek: () => row,
    };
  }

  it('fetches a token via ROPC and stores it', async () => {
    const jwt = makeValidJwt(3600);
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('auth.northbeam.io/oauth/token');
      const body = JSON.parse(init!.body as string);
      expect(body.grant_type).toBe('password');
      expect(body.username).toBe('danny@gantri.com');
      return new Response(JSON.stringify({ access_token: jwt, expires_in: 3600 }), { status: 200 });
    }) as any;

    const repo = makeRepo();
    const mgr = new NorthbeamAuthManager({
      credentials: { email: 'danny@gantri.com', password: 'pw', dashboardId: 'ws' },
      tokensRepo: repo as any,
      playwrightLogin: vi.fn(),
    });
    const token = await mgr.getAccessToken();
    expect(token).toBe(jwt);
    expect(repo.upsert).toHaveBeenCalledOnce();
    expect(repo._peek().last_refresh_method).toBe('ropc');
  });

  it('reuses cached token when not near expiry', async () => {
    const jwt = makeValidJwt(7200);
    const repo = makeRepo();
    await repo.upsert({
      access_token: jwt,
      expires_at: new Date(Date.now() + 7200 * 1000).toISOString(),
      last_refresh_method: 'ropc',
    });
    globalThis.fetch = vi.fn();

    const mgr = new NorthbeamAuthManager({
      credentials: { email: 'x', password: 'y', dashboardId: 'ws' },
      tokensRepo: repo as any,
      playwrightLogin: vi.fn(),
    });
    const token = await mgr.getAccessToken();
    expect(token).toBe(jwt);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('refreshes when cached token is near expiry (<15 min)', async () => {
    const oldJwt = makeValidJwt(600);
    const newJwt = makeValidJwt(3600);
    const repo = makeRepo();
    await repo.upsert({
      access_token: oldJwt,
      expires_at: new Date(Date.now() + 600 * 1000).toISOString(),
      last_refresh_method: 'ropc',
    });
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: newJwt, expires_in: 3600 }), { status: 200 }),
    ) as any;

    const mgr = new NorthbeamAuthManager({
      credentials: { email: 'x', password: 'y', dashboardId: 'ws' },
      tokensRepo: repo as any,
      playwrightLogin: vi.fn(),
    });
    const token = await mgr.getAccessToken();
    expect(token).toBe(newJwt);
  });

  it('falls back to playwrightLogin when ROPC returns 403', async () => {
    const jwt = makeValidJwt(3600);
    globalThis.fetch = vi.fn(async () => new Response('forbidden', { status: 403 })) as any;
    const playwrightLogin = vi.fn(async () => ({ accessToken: jwt, expiresIn: 3600 }));
    const repo = makeRepo();

    const mgr = new NorthbeamAuthManager({
      credentials: { email: 'x', password: 'y', dashboardId: 'ws' },
      tokensRepo: repo as any,
      playwrightLogin,
    });
    const token = await mgr.getAccessToken();
    expect(token).toBe(jwt);
    expect(playwrightLogin).toHaveBeenCalledOnce();
    expect(repo._peek().last_refresh_method).toBe('playwright');
  });
});
