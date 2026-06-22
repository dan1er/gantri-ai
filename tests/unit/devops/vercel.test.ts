import { describe, it, expect, vi } from 'vitest';
import { VercelClient } from '../../../src/devops/vercel.js';

const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) }) as Response;

describe('VercelClient error messaging', () => {
  it('translates a lapsed-SSO 403 into an actionable, scope-wide message', async () => {
    // The real Vercel body when a personal token's SAML session has expired.
    const fetch = vi.fn().mockResolvedValue(
      json(403, { error: { code: 'forbidden', message: 'Not authorized: Trying to access resource under scope "gantri". You must re-authenticate to this scope or use a token with access to this scope.', saml: true, scope: 'gantri' } }),
    );
    const client = new VercelClient({ token: 't', teamId: 'team_x', fetch: fetch as any });
    await expect(client.wireAndRedeploy('core', 'feat/as-1', 'https://as-1.preview.api.gantri.com')).rejects.toThrow(
      /lost SSO access to the "gantri" team.*affects ALL projects.*VERCEL_TOKEN/s,
    );
  });

  it('keeps a plain HTTP message for non-SAML failures', async () => {
    const fetch = vi.fn().mockResolvedValue(json(404, { error: { message: 'Project not found' } }));
    const client = new VercelClient({ token: 't', teamId: 'team_x', fetch: fetch as any });
    await expect(client.deployToProd('mantle', 'deploy-1')).rejects.toThrow(/HTTP 404 — Project not found/);
  });
});
