import { chromium, type Browser } from 'playwright';
import { logger } from '../../logger.js';

/**
 * Post-publish visual verification: load the freshly-published report in
 * a real headless Chromium and confirm it actually renders. The
 * data-shape verification (`verifyResolvedRefs`) catches "the spec is
 * structurally correct against the data". This catches what data-shape
 * verification cannot:
 *   - SPA failed to mount (React error, JS bundle blew up)
 *   - /data.json fetch returned an error or 4xx/5xx
 *   - root container empty after hydration (page renders blank)
 *   - "Couldn't load this report" error state visible
 *   - data-quality banner with `step_errors` showing
 *   - first row of any rendered table has empty / dash cells (defense
 *     in depth — should be caught by data-shape verifier first)
 *
 * Runs in the background AFTER the report is persisted, so the URL
 * actually exists. If verification fails, the connector marks the
 * report as broken and DMs the user. Single attempt — does not retry
 * compile (the data-shape retry already happens upstream).
 */

export interface VisualVerificationOptions {
  url: string;
  /** Absolute timeout for the whole check. Default 30s. */
  timeoutMs?: number;
  /** Inject the viewer cookie so the auth flow never falls back to ?t=
   *  if the server's cookie logic ever gets stricter. */
  viewerCookie?: { name: string; value: string; domain: string };
}

export interface VisualVerificationIssue {
  severity: 'error' | 'warning';
  code:
    | 'page_load_failed'
    | 'data_json_failed'
    | 'console_error'
    | 'root_empty'
    | 'error_state_visible'
    | 'data_quality_step_errors'
    | 'table_cell_empty'
    | 'verification_timeout';
  message: string;
  detail?: unknown;
}

export interface VisualVerificationResult {
  ok: boolean;
  issues: VisualVerificationIssue[];
  metrics: {
    durationMs: number;
    finalUrl: string;
    httpStatus: number | null;
    consoleErrorCount: number;
    networkFailureCount: number;
  };
}

/** A `—` cell can mean "data legitimately null" or "field-mapping bug".
 *  We treat the FIRST row of any table specially: if every cell of the
 *  first column reads as a dash, that's almost always a bug. Single-cell
 *  dashes (e.g. ROAS row where payout was zero so we returned null) are
 *  legitimate and don't fail the verification. */
const DASH_TOKENS = new Set(['—', '-', '–', '']);

export async function verifyReportVisually(opts: VisualVerificationOptions): Promise<VisualVerificationResult> {
  const startedAt = Date.now();
  const issues: VisualVerificationIssue[] = [];
  let consoleErrorCount = 0;
  let networkFailureCount = 0;
  let httpStatus: number | null = null;
  let finalUrl = opts.url;
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    if (opts.viewerCookie) {
      await context.addCookies([{
        name: opts.viewerCookie.name,
        value: opts.viewerCookie.value,
        domain: opts.viewerCookie.domain,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      }]);
    }
    const page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrorCount += 1;
        issues.push({ severity: 'error', code: 'console_error', message: `console.error: ${msg.text().slice(0, 300)}` });
      }
    });
    page.on('requestfailed', (req) => {
      networkFailureCount += 1;
      const url = req.url();
      // /data.json failures are critical; everything else is a warning.
      if (url.includes('/data.json')) {
        issues.push({ severity: 'error', code: 'data_json_failed', message: `data.json request failed: ${req.failure()?.errorText ?? 'unknown'}`, detail: { url } });
      }
    });

    // Capture the data.json response specifically — even if it returned a
    // body, we want to know its HTTP status to detect 4xx/5xx that the
    // browser still happily passed back to the SPA.
    page.on('response', (resp) => {
      const url = resp.url();
      if (url.includes('/data.json') && resp.status() >= 400) {
        issues.push({ severity: 'error', code: 'data_json_failed', message: `data.json HTTP ${resp.status()}`, detail: { url } });
      }
    });

    const timeoutMs = opts.timeoutMs ?? 30_000;
    let resp;
    try {
      resp = await page.goto(opts.url, { waitUntil: 'networkidle', timeout: timeoutMs });
    } catch (err) {
      issues.push({ severity: 'error', code: 'page_load_failed', message: err instanceof Error ? err.message : String(err) });
      return { ok: false, issues, metrics: { durationMs: Date.now() - startedAt, finalUrl, httpStatus, consoleErrorCount, networkFailureCount } };
    }
    httpStatus = resp?.status() ?? null;
    finalUrl = page.url();

    if (httpStatus !== null && httpStatus >= 400) {
      issues.push({ severity: 'error', code: 'page_load_failed', message: `Page returned HTTP ${httpStatus}` });
    }

    // Give React a beat to mount + render after networkidle (charts can be lazy).
    await page.waitForTimeout(1500);

    // CHECK 1 — root container has any rendered content.
    const rootHasContent = await page.evaluate(() => {
      const root = document.querySelector('#root');
      return !!root && root.children.length > 0;
    });
    if (!rootHasContent) {
      issues.push({ severity: 'error', code: 'root_empty', message: 'SPA root (#root) rendered no children — likely a JS bundle / hydration crash.' });
    }

    // CHECK 2 — explicit "Couldn't load this report" error state.
    const errorStateVisible = await page.evaluate(() => {
      const text = (document.body.textContent ?? '').toLowerCase();
      return text.includes("couldn't load") || text.includes('could not load this report') || text.includes('failed to load report');
    });
    if (errorStateVisible) {
      issues.push({ severity: 'error', code: 'error_state_visible', message: '"Couldn\'t load this report" error state is visible on the page.' });
    }

    // CHECK 3 — data-quality banner with `step_errors` (means a data step
    // failed at fetch time). Soft warnings (all_steps_empty, partial_empty)
    // are flagged but not failure-worthy.
    const dataQualitySnapshot = await page.evaluate(() => {
      // Banner text is "Some data could not be loaded" for step_errors and
      // "Heads up about this report" for warnings.
      const text = document.body.textContent ?? '';
      return {
        hasStepError: text.includes('Some data could not be loaded'),
        hasSoftWarning: text.includes('Heads up about this report'),
      };
    });
    if (dataQualitySnapshot.hasStepError) {
      issues.push({ severity: 'error', code: 'data_quality_step_errors', message: 'Data-quality banner shows step_errors — at least one data step failed at fetch time.' });
    } else if (dataQualitySnapshot.hasSoftWarning) {
      issues.push({ severity: 'warning', code: 'data_quality_step_errors', message: 'Soft data-quality warning visible (likely partial_empty or all_steps_empty).' });
    }

    // CHECK 4 — first column of every rendered table: if every cell is a
    // dash, the field mapping is almost certainly wrong (this is exactly
    // the GSC `keys` regression). Single dashes are legit (null cells).
    const tableCellIssues = await page.evaluate((dashList) => {
      const found: Array<{ tableIndex: number; firstColAllDashes: boolean; sampleSize: number }> = [];
      const tables = Array.from(document.querySelectorAll('table'));
      tables.forEach((tbl, i) => {
        const bodyRows = Array.from(tbl.querySelectorAll('tbody tr'));
        if (bodyRows.length === 0) return;
        const sample = bodyRows.slice(0, Math.min(5, bodyRows.length));
        const firstCellTexts = sample.map((r) => (r.querySelector('td')?.textContent ?? '').trim());
        const allDashes = firstCellTexts.length > 0 && firstCellTexts.every((t) => dashList.includes(t));
        if (allDashes) {
          found.push({ tableIndex: i, firstColAllDashes: true, sampleSize: firstCellTexts.length });
        }
      });
      return found;
    }, Array.from(DASH_TOKENS));
    for (const t of tableCellIssues) {
      issues.push({ severity: 'error', code: 'table_cell_empty', message: `Table #${t.tableIndex}: every first-column cell in the first ${t.sampleSize} rows is "—" — field mapping is likely wrong.` });
    }

    const ok = issues.filter((i) => i.severity === 'error').length === 0;
    const metrics = { durationMs: Date.now() - startedAt, finalUrl, httpStatus, consoleErrorCount, networkFailureCount };
    logger.info({ url: opts.url, ok, issues: issues.length, ...metrics }, 'live-report visual verification finished');
    return { ok, issues, metrics };
  } catch (err) {
    issues.push({ severity: 'error', code: 'verification_timeout', message: err instanceof Error ? err.message : String(err) });
    return {
      ok: false,
      issues,
      metrics: { durationMs: Date.now() - startedAt, finalUrl, httpStatus, consoleErrorCount, networkFailureCount },
    };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}
