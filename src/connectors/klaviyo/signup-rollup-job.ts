import type { KlaviyoApiClient } from './client.js';
import type { KlaviyoSignupRollupRepo, KlaviyoSignupRollupUpsert } from '../../storage/repositories/klaviyo-signup-rollup.js';
import { logger } from '../../logger.js';

const PT_TZ = 'America/Los_Angeles';
const HISTORY_START = '2020-01-01';

export interface KlaviyoSignupRollupJobDeps {
  client: KlaviyoApiClient;
  repo: KlaviyoSignupRollupRepo;
}

export class KlaviyoSignupRollupJob {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: KlaviyoSignupRollupJobDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tickIfDue(); }, 15 * 60 * 1000);
    logger.info({}, 'klaviyo signup rollup job started (15-min poll, fires at 03:00 PT)');
    void this.run().catch((err) => logger.error({ err: err instanceof Error ? err.stack : String(err) }, 'initial klaviyo signup rollup failed'));
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tickIfDue(): Promise<void> {
    if (this.running) return;
    const hourPt = parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: PT_TZ, hour: '2-digit', hour12: false })
        .format(new Date())
        .replace(/\D/g, ''),
      10,
    );
    if (hourPt !== 3) return;
    await this.run();
  }

  async run(): Promise<{ daysWritten: number; profilesSeen: number }> {
    if (this.running) return { daysWritten: 0, profilesSeen: 0 };
    this.running = true;
    const started = Date.now();
    try {
      const startDate = HISTORY_START;
      const endDate = ptDayOf(new Date(Date.now() - 24 * 3600 * 1000));
      logger.info({ startDate, endDate }, 'klaviyo_signup_rollup_started');

      const profiles = await this.deps.client.searchProfilesByCreatedRange({ startDate, endDate });

      const counts = new Map<string, { total: number; consented: number }>();
      for (const p of profiles) {
        const created = p.attributes?.created;
        if (typeof created !== 'string') continue;
        const t = Date.parse(created);
        if (!Number.isFinite(t)) continue;
        const day = ptDayOf(new Date(t));
        const consent = p.attributes?.subscriptions?.email?.marketing?.consent === 'SUBSCRIBED';
        const cur = counts.get(day) ?? { total: 0, consented: 0 };
        cur.total++;
        if (consent) cur.consented++;
        counts.set(day, cur);
      }

      const upserts: KlaviyoSignupRollupUpsert[] = [];
      for (const [day, c] of counts) {
        upserts.push({ day, signupsTotal: c.total, signupsConsentedEmail: c.consented });
      }
      await this.deps.repo.upsertManyDays(upserts);

      const durationMs = Date.now() - started;
      logger.info({ profilesSeen: profiles.length, daysUpserted: upserts.length, durationMs }, 'klaviyo_signup_rollup_completed');
      return { daysWritten: upserts.length, profilesSeen: profiles.length };
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.stack : String(err) }, 'klaviyo_signup_rollup_failed');
      return { daysWritten: 0, profilesSeen: 0 };
    } finally {
      this.running = false;
    }
  }
}

function ptDayOf(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: PT_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}
