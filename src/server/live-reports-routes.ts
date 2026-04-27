import path from 'node:path';
import type { Express } from 'express';
import type { PublishedReportsRepo } from '../storage/repositories/published-reports.js';
import { runLiveSpec } from '../reports/live/runner.js';
import { logger } from '../logger.js';

interface MinimalRegistry {
  execute(toolName: string, args: unknown): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
}

export interface LiveReportsRoutesDeps {
  repo: PublishedReportsRepo;
  registry: MinimalRegistry;
  webDistDir: string;
}

export function mountLiveReportsRoutes(app: Express, deps: LiveReportsRoutesDeps): void {
  // Static assets first (so they don't collide with the :slug param).
  app.get(/^\/r\/(assets|logo-name\.png|favicon\.png|og-image\.png).*/, (req, res, next) => {
    const rest = req.path.replace(/^\/r\//, '');
    res.sendFile(path.join(deps.webDistDir, rest), (err) => err && next());
  });

  // GET /r/:slug/data.json — the deterministic data endpoint.
  app.get('/r/:slug/data.json', async (req, res) => {
    try {
      const slug = req.params.slug;
      const token = String(req.query.t ?? '');
      const refresh = String(req.query.refresh ?? '') === '1';
      const report = await deps.repo.getBySlug(slug);
      if (!report) return res.status(404).json({ error: 'not_found' });
      if (token !== report.accessToken) return res.status(401).json({ error: 'unauthorized' });
      const result = await runLiveSpec(report.spec, deps.registry);
      void Promise.resolve(deps.repo.recordVisit(slug)).catch((err: unknown) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'recordVisit failed'));
      res.set('Cache-Control', refresh ? 'no-store' : `public, max-age=${report.spec.cacheTtlSec ?? 300}`);
      return res.json({
        dataResults: result.dataResults,
        ui: result.ui,
        errors: result.errors,
        meta: {
          ...result.meta,
          slug: report.slug,
          title: report.title,
          description: report.description,
          owner_slack_id: report.ownerSlackId,
          intent: report.intent,
          createdAt: report.createdAt,
          updatedAt: report.updatedAt,
          lastRefreshedAt: result.meta.generatedAt,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, '/r/:slug/data.json failed');
      return res.status(500).json({ error: 'internal', detail: msg });
    }
  });

  // GET /r — index (SPA shell, same bundle, the SPA detects no :slug and shows index page)
  app.get('/r', (_req, res) => {
    res.sendFile(path.join(deps.webDistDir, 'index.html'));
  });

  // GET /r/all.json — list of all non-archived reports (token-gated)
  app.get('/r/all.json', async (req, res) => {
    try {
      const token = String(req.query.t ?? '');
      const expected = process.env.LIVE_REPORTS_VIEWER_TOKEN;
      if (!expected) return res.status(503).json({ error: 'viewer_token_not_configured', detail: 'Set LIVE_REPORTS_VIEWER_TOKEN env var' });
      if (token !== expected) return res.status(401).json({ error: 'unauthorized' });
      const all = await deps.repo.listAll();
      return res.json({
        reports: all.map((r) => ({
          slug: r.slug,
          title: r.title,
          description: r.description,
          ownerSlackId: r.ownerSlackId,
          createdAt: r.createdAt,
          lastVisitedAt: r.lastVisitedAt,
          visitCount: r.visitCount,
          url: `/r/${r.slug}?t=${r.accessToken}`,
        })),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: 'internal', detail: msg });
    }
  });

  // GET /r/:slug — SPA shell.
  app.get('/r/:slug', (_req, res) => {
    res.sendFile(path.join(deps.webDistDir, 'index.html'));
  });
}
