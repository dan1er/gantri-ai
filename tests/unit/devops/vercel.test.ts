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

describe('VercelClient preview URLs', () => {
  const project = json(200, { id: 'prj_1', link: { repoId: 123 } });
  const envOk = json(200, {});

  it('wireAndRedeploy returns the pretty branch alias when it fits in a DNS label', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(envOk)
      .mockResolvedValueOnce(json(200, { url: 'factoryos-cgxz8d471-gantri.vercel.app', inspectorUrl: 'https://vercel.com/gantri/factoryos/dep' }));
    const client = new VercelClient({ token: 't', teamId: 'team_x', fetch: fetch as any });

    const { url } = await client.wireAndRedeploy('core', 'feat/short', 'https://short.preview.api.gantri.com');

    expect(url).toBe('https://factoryos-git-feat-short-gantri.vercel.app');
  });

  it('wireAndRedeploy falls back to the deployment URL when the branch alias overflows 63 chars', async () => {
    // `factoryos-git-preview-product-reviews-null-sku-sort-crash-gantri` is 64
    // chars, so Vercel never serves that hostname — the deployment's own URL must
    // be reported instead.
    const fetch = vi.fn()
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(envOk)
      .mockResolvedValueOnce(json(200, { url: 'factoryos-cgxz8d471-gantri.vercel.app', inspectorUrl: 'https://vercel.com/gantri/factoryos/dep' }));
    const client = new VercelClient({ token: 't', teamId: 'team_x', fetch: fetch as any });

    const { url } = await client.wireAndRedeploy('core', 'preview-product-reviews-null-sku-sort-crash', 'https://x.preview.api.gantri.com');

    expect(url).toBe('https://factoryos-cgxz8d471-gantri.vercel.app');
    expect(url).not.toContain('-git-');
  });

  it('previewUrlForBranch returns the pretty alias for a short branch without calling Vercel', async () => {
    const fetch = vi.fn();
    const client = new VercelClient({ token: 't', teamId: 'team_x', fetch: fetch as any });

    const url = await client.previewUrlForBranch('core', 'feat/short');

    expect(url).toBe('https://factoryos-git-feat-short-gantri.vercel.app');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('previewUrlForBranch looks up the real deployment URL when the alias overflows', async () => {
    const ref = 'preview-product-reviews-null-sku-sort-crash';
    const fetch = vi.fn()
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(json(200, {
        deployments: [
          { url: 'factoryos-older-gantri.vercel.app', meta: { githubCommitRef: 'other-branch' } },
          { url: 'factoryos-cgxz8d471-gantri.vercel.app', meta: { githubCommitRef: ref } },
        ],
      }));
    const client = new VercelClient({ token: 't', teamId: 'team_x', fetch: fetch as any });

    const url = await client.previewUrlForBranch('core', ref);

    expect(url).toBe('https://factoryos-cgxz8d471-gantri.vercel.app');
  });
});
