import path from 'node:path';
import express, { type Express } from 'express';
import type { PublishedReportsRepo } from '../storage/repositories/published-reports.js';
import type { FeedbackRepo } from '../storage/repositories/feedback.js';
import { runLiveSpec } from '../reports/live/runner.js';
import { substituteDateMacros } from '../reports/live/date-macros.js';
import { computeDataQuality } from '../reports/live/data-quality.js';
import { logger } from '../logger.js';

interface MinimalRegistry {
  execute(toolName: string, args: unknown): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
}

interface MinimalSlackClient {
  users?: {
    info?: (args: { user: string }) => Promise<{ ok?: boolean; user?: { id?: string; real_name?: string; profile?: { display_name?: string; real_name?: string; email?: string } } }>;
  };
  conversations?: {
    open?: (args: { users: string }) => Promise<{ ok?: boolean; channel?: { id?: string } }>;
  };
  chat?: {
    postMessage?: (args: { channel: string; text: string; unfurl_links?: boolean }) => Promise<{ ok?: boolean }>;
  };
}

export interface LiveReportsRoutesDeps {
  repo: PublishedReportsRepo;
  registry: MinimalRegistry;
  webDistDir: string;
  /** Optional Slack client for resolving owner display names. If omitted, owner shows as raw ID. */
  slackClient?: MinimalSlackClient;
  /** Feedback storage — when set, the /r/:slug/feedback endpoint is wired up. */
  feedbackRepo?: FeedbackRepo;
  /** Maintainer Slack user ID — DM'd whenever a viewer flags a report. */
  maintainerSlackUserId?: string;
}

const VIEWER_COOKIE = 'lr_viewer';

const VALID_PRESETS = new Set([
  'yesterday', 'last_7_days', 'last_14_days', 'last_30_days', 'last_90_days',
  'last_180_days', 'last_365_days', 'this_month', 'last_month',
  'month_to_date', 'quarter_to_date', 'year_to_date',
]);

function parseRangeFromQuery(q: { range?: unknown; from?: unknown; to?: unknown }): unknown | null {
  const from = typeof q.from === 'string' ? q.from : '';
  const to = typeof q.to === 'string' ? q.to : '';
  if (from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return { start: from, end: to };
  }
  const range = typeof q.range === 'string' ? q.range : '';
  if (range && VALID_PRESETS.has(range)) return range;
  return null;
}

/** In-memory cache: Slack user ID → display name. Persists for the lifetime of the process. */
const slackNameCache = new Map<string, string>();
const slackNameInflight = new Map<string, Promise<string>>();

async function resolveSlackName(slackClient: MinimalSlackClient | undefined, userId: string): Promise<string> {
  if (!slackClient?.users?.info) return userId;
  const cached = slackNameCache.get(userId);
  if (cached) return cached;
  const inflight = slackNameInflight.get(userId);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const res = await slackClient.users!.info!({ user: userId });
      if (!res.ok || !res.user) return userId;
      const display = res.user.profile?.display_name || res.user.profile?.real_name || res.user.real_name || userId;
      slackNameCache.set(userId, display);
      return display;
    } catch {
      return userId;
    } finally {
      slackNameInflight.delete(userId);
    }
  })();
  slackNameInflight.set(userId, p);
  return p;
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
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
      // Auth: accept EITHER the per-report ?t= token OR the durable
      // `lr_viewer` cookie (set on any prior tokenized visit). This means
      // someone who clicked one tokenized report link gets to view ALL
      // reports for the cookie's lifetime — bookmark a slug, share a
      // bare URL, etc. Tokens still work for first-time / external users.
      const viewerToken = process.env.LIVE_REPORTS_VIEWER_TOKEN;
      const cookieValue = parseCookie(req.headers.cookie, VIEWER_COOKIE);
      const tokenValid = token !== '' && token === report.accessToken;
      const cookieValid = !!viewerToken && cookieValue === viewerToken;
      if (!tokenValid && !cookieValid) return res.status(401).json({ error: 'unauthorized' });
      // Refresh the cookie on every authorized visit so it slides forward and
      // sliding-window-style stays valid as long as the user keeps visiting.
      if (viewerToken) {
        res.cookie?.(VIEWER_COOKIE, viewerToken, {
          httpOnly: true, secure: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000,
        });
        if (!res.cookie) res.set('Set-Cookie', `${VIEWER_COOKIE}=${viewerToken}; Path=/; Max-Age=${30 * 24 * 60 * 60}; HttpOnly; Secure; SameSite=Lax`);
      }
      const effectiveRange = parseRangeFromQuery(req.query as { range?: unknown; from?: unknown; to?: unknown }) ?? report.spec.dateRange ?? 'last_7_days';
      const [result, ownerName] = await Promise.all([
        runLiveSpec(report.spec, deps.registry, effectiveRange),
        resolveSlackName(deps.slackClient, report.ownerSlackId),
      ]);
      void Promise.resolve(deps.repo.recordVisit(slug)).catch((err: unknown) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'recordVisit failed'));
      // Cap HTTP-cache window at 5 minutes regardless of `spec.cacheTtlSec`.
      // The spec value still governs the server-side `tool_result_cache` TTL
      // (data freshness from upstream). Letting browsers hold a response for
      // hours hides bug fixes and produces "stale empty report" UX when the
      // viewer overrides ?range=. 5 min keeps things lively without hammering.
      const httpMaxAge = Math.min(report.spec.cacheTtlSec ?? 300, 300);
      res.set('Cache-Control', refresh ? 'no-store' : `public, max-age=${httpMaxAge}, must-revalidate`);
      // Resolve $DATE:… macros in the user-visible payload (title, description,
      // ui block markdown, etc.) — the runner already resolves them in step
      // args, but the LLM sometimes embeds them in prose too. Single `now`
      // anchor keeps everything internally consistent.
      const macroNow = new Date();
      const resolvedUi = substituteDateMacros(result.ui, macroNow);
      const resolvedTitle = typeof substituteDateMacros(report.title, macroNow) === 'string' ? substituteDateMacros(report.title, macroNow) as string : report.title;
      const resolvedDescription = report.description ? (substituteDateMacros(report.description, macroNow) as string) : report.description;
      const dataQuality = computeDataQuality(result.dataResults, result.errors);
      return res.json({
        dataResults: result.dataResults,
        ui: resolvedUi,
        errors: result.errors,
        meta: {
          ...result.meta,
          slug: report.slug,
          title: resolvedTitle,
          description: resolvedDescription,
          owner_slack_id: report.ownerSlackId,
          owner_display_name: ownerName,
          intent: report.intent,
          createdAt: report.createdAt,
          updatedAt: report.updatedAt,
          lastRefreshedAt: result.meta.generatedAt,
          effectiveRange,
          parametric: JSON.stringify(report.spec.data ?? []).includes('$REPORT_RANGE'),
          dataQuality,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, '/r/:slug/data.json failed');
      return res.status(500).json({ error: 'internal', detail: msg });
    }
  });

  // POST /r/:slug/feedback — viewer flags a wrong number on a report.
  // Auth: same as data.json (token OR cookie). Body: { reason, reporterHandle? }.
  // Per-route express.json() — Bolt's receiver mounts its own raw body parser
  // for /slack/events, so we keep JSON parsing scoped to this endpoint.
  app.post('/r/:slug/feedback', express.json({ limit: '32kb' }), async (req, res) => {
    try {
      if (!deps.feedbackRepo) return res.status(503).json({ error: 'feedback_not_configured' });
      const slug = req.params.slug;
      const token = String(req.query.t ?? '');
      const report = await deps.repo.getBySlug(slug);
      if (!report) return res.status(404).json({ error: 'not_found' });
      const viewerToken = process.env.LIVE_REPORTS_VIEWER_TOKEN;
      const cookieValue = parseCookie(req.headers.cookie, VIEWER_COOKIE);
      const tokenValid = token !== '' && token === report.accessToken;
      const cookieValid = !!viewerToken && cookieValue === viewerToken;
      if (!tokenValid && !cookieValid) return res.status(401).json({ error: 'unauthorized' });

      // Best-effort body parsing — Express might or might not have body-parser
      // mounted; both shapes are accepted.
      const body = (req.body as { reason?: unknown; reporterHandle?: unknown } | undefined) ?? {};
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      const reporterHandle = typeof body.reporterHandle === 'string' ? body.reporterHandle.trim() : '';
      if (!reason || reason.length < 3) return res.status(400).json({ error: 'reason_too_short', detail: 'Reason must be at least 3 characters.' });
      if (reason.length > 4000) return res.status(400).json({ error: 'reason_too_long' });

      const reportUrl = `${process.env.PUBLIC_BASE_URL || 'https://reports.gantri.com'}/r/${report.slug}`;
      const reporterId = reporterHandle ? `web:${reporterHandle.slice(0, 80)}` : 'web:anonymous';
      const inserted = await deps.feedbackRepo.insert({
        reporter_slack_user_id: reporterId,
        reason,
        // Re-use the slack-thread columns as a sentinel for "live-report" source —
        // the maintainer DM has the URL so they can navigate directly. Avoids a
        // schema migration for what is otherwise a tiny additional surface.
        channel_id: `live-report:${report.slug}`,
        thread_ts: 'live-report',
        thread_permalink: reportUrl,
        captured_question: `Live Report: ${report.title}`,
        captured_response: null,
        captured_tool_calls: null,
        captured_model: null,
        captured_iterations: null,
      });

      // DM the maintainer with the report URL + reason — best-effort, never
      // fails the request. The viewer's response shouldn't depend on Slack.
      void (async () => {
        try {
          if (!deps.maintainerSlackUserId || !deps.slackClient?.conversations?.open || !deps.slackClient?.chat?.postMessage) return;
          const open = await deps.slackClient.conversations.open({ users: deps.maintainerSlackUserId });
          if (!open?.ok || !open.channel?.id) return;
          const text = `🚨 *Live Report flagged*\n*${report.title}*\n${reportUrl}\n\nReporter: ${reporterHandle ? reporterHandle : '(anonymous)'}\nReason: ${reason}\n\n_feedback id: ${inserted.id}_`;
          await deps.slackClient.chat.postMessage({ channel: open.channel.id, text, unfurl_links: false });
        } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'live-report feedback maintainer DM failed');
        }
      })();

      return res.json({ ok: true, id: inserted.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, '/r/:slug/feedback failed');
      return res.status(500).json({ error: 'internal', detail: msg });
    }
  });

  // GET / — redirect bare-domain hits to the reports index. The Live Reports
  // app is the only public surface served from this domain (reports.gantri.com),
  // so a 404 at the root is unhelpful.
  app.get('/', (_req, res) => res.redirect(301, '/r'));

  // GET /r — index (SPA shell, same bundle, the SPA detects no :slug and shows index page)
  app.get('/r', (_req, res) => {
    res.sendFile(path.join(deps.webDistDir, 'index.html'));
  });

  // GET /r/all.json — list of all non-archived reports.
  // Auth: query token OR cookie (set when a valid report URL was visited).
  app.get('/r/all.json', async (req, res) => {
    try {
      const expected = process.env.LIVE_REPORTS_VIEWER_TOKEN;
      if (!expected) return res.status(503).json({ error: 'viewer_token_not_configured', detail: 'Set LIVE_REPORTS_VIEWER_TOKEN env var' });
      const queryToken = String(req.query.t ?? '');
      const cookieToken = parseCookie(req.headers?.cookie as string | undefined, VIEWER_COOKIE);
      if (queryToken !== expected && cookieToken !== expected) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      const all = await deps.repo.listAll();
      // Resolve display names in parallel.
      const ownerIds = [...new Set(all.map((r) => r.ownerSlackId))];
      const namesByID = new Map<string, string>();
      await Promise.all(ownerIds.map(async (id) => { namesByID.set(id, await resolveSlackName(deps.slackClient, id)); }));
      return res.json({
        reports: all.map((r) => ({
          slug: r.slug,
          title: r.title,
          description: r.description,
          ownerSlackId: r.ownerSlackId,
          ownerDisplayName: namesByID.get(r.ownerSlackId) ?? r.ownerSlackId,
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
