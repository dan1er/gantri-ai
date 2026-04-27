import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { mountLiveReportsRoutes } from '../../../src/server/live-reports-routes.js';

function makeApp(opts: { repo: any; registry: any; webDistDir?: string }) {
  const app = express();
  mountLiveReportsRoutes(app, { repo: opts.repo, registry: opts.registry, webDistDir: opts.webDistDir ?? '/nonexistent' });
  return app;
}

async function fetchUrl(app: express.Express, path: string) {
  const server = app.listen(0);
  const port = (server.address() as any).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const body = await res.text();
    return { status: res.status, body, headers: res.headers, json: (() => { try { return JSON.parse(body); } catch { return null; } })() };
  } finally { server.close(); }
}

const validReport = {
  id: 'r1', slug: 's1', title: 'T', accessToken: 'TOK',
  spec: { version: 1, title: 'T', data: [{ id: 'a', tool: 'gantri.order_stats', args: {} }], ui: [{ type: 'kpi', label: 'X', value: 'a.totalOrders' }], cacheTtlSec: 0 },
  ownerSlackId: 'UA', intent: 'i', intentKeywords: [], createdAt: '2026-04-26', updatedAt: '2026-04-26', archivedAt: null, visitCount: 0, lastVisitedAt: null, specVersion: 1, description: null,
};

describe('GET /r/:slug/data.json', () => {
  it('404 when report missing', async () => {
    const repo = { getBySlug: vi.fn(async () => null), recordVisit: vi.fn() };
    const registry = { execute: vi.fn() };
    const app = makeApp({ repo, registry });
    const r = await fetchUrl(app, '/r/missing/data.json?t=anything');
    expect(r.status).toBe(404);
  });

  it('401 when token mismatches', async () => {
    const repo = { getBySlug: vi.fn(async () => validReport), recordVisit: vi.fn() };
    const registry = { execute: vi.fn() };
    const app = makeApp({ repo, registry });
    const r = await fetchUrl(app, '/r/s1/data.json?t=WRONG');
    expect(r.status).toBe(401);
  });

  it('200 returns dataResults + ui + meta on valid token', async () => {
    const repo = { getBySlug: vi.fn(async () => validReport), recordVisit: vi.fn() };
    const registry = { execute: vi.fn(async () => ({ ok: true, data: { totalOrders: 87 } })) };
    const app = makeApp({ repo, registry });
    const r = await fetchUrl(app, '/r/s1/data.json?t=TOK');
    expect(r.status).toBe(200);
    expect(r.json.dataResults.a).toEqual({ totalOrders: 87 });
    expect(r.json.ui[0].type).toBe('kpi');
    expect(r.json.meta.sources).toContain('gantri.order_stats');
    expect(r.json.meta.spec).toBeTruthy();
  });
});

describe('GET /r/:slug serves the SPA shell', () => {
  it('returns index.html from webDistDir', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webdist-'));
    fs.writeFileSync(path.join(tmp, 'index.html'), '<!doctype html><html><body>Live Reports SPA</body></html>');
    try {
      const app = makeApp({ repo: { getBySlug: vi.fn() }, registry: { execute: vi.fn() }, webDistDir: tmp });
      const r = await fetchUrl(app, '/r/anything');
      expect(r.status).toBe(200);
      expect(r.body).toContain('Live Reports SPA');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('GET /r/:slug/data.json?refresh=1', () => {
  it('sets Cache-Control: no-store when refresh is requested', async () => {
    const repo = { getBySlug: vi.fn(async () => validReport), recordVisit: vi.fn() };
    const registry = { execute: vi.fn(async () => ({ ok: true, data: { totalOrders: 1 } })) };
    const app = makeApp({ repo, registry });
    const r = await fetchUrl(app, '/r/s1/data.json?t=TOK&refresh=1');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });
});
