import { chromium } from 'playwright';
import type { Credentials, PlaywrightLogin } from './auth-manager.js';
import { logger } from '../../logger.js';

const LOGIN_URL_TEMPLATE =
  'https://dashboard.northbeam.io/{{dashboardId}}/overview';

/**
 * Drives the Auth0 Universal Login page with Playwright, then captures the
 * Auth0-issued JWT from the in-page XHR to `auth.northbeam.io/oauth/token`.
 *
 * Use only when ROPC is unavailable. Slow (~10-20s) and requires Chromium.
 */
export const playwrightLogin: PlaywrightLogin = async (creds: Credentials) => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const tokenPromise = page.waitForResponse(
      (r) => r.url().startsWith('https://auth.northbeam.io/oauth/token') && r.status() === 200,
      { timeout: 30_000 },
    );

    await page.goto(LOGIN_URL_TEMPLATE.replace('{{dashboardId}}', creds.dashboardId), {
      waitUntil: 'networkidle',
    });
    await page.locator('input[type="email"]').fill(creds.email);
    await page.locator('input[type="password"]').fill(creds.password);
    await page.locator('button[type="submit"]').click();

    const response = await tokenPromise;
    const body = (await response.json()) as { access_token: string; expires_in: number };
    logger.info('Northbeam login via Playwright succeeded');
    return { accessToken: body.access_token, expiresIn: body.expires_in };
  } finally {
    await browser.close();
  }
};
