import { logger } from '../../../logger.js';
import type { TierPoller, TierPollResult } from './poller.js';
import type { WeeklyTierReporter } from './weekly-report.js';

/**
 * In-process scheduler for the delivery-tier classifier, mirroring the reports
 * runner: a 5-minute tick scans the board (`TierPoller.runOnce`) and, on the same
 * tick, checks whether the idempotent Monday report is due
 * (`WeeklyTierReporter.maybeSend`). A tick never overlaps itself, and a failure in
 * either half is logged, not thrown, so the loop keeps running.
 */

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export interface TierRunnerDeps {
  poller: TierPoller;
  reporter: WeeklyTierReporter;
  /** Tick cadence. Default 5 minutes. */
  tickIntervalMs?: number;
}

export interface TierTickResult {
  poll: TierPollResult;
  weekly: { sent: boolean; reason?: string; weekStart: string };
}

export class TierRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: TierRunnerDeps) {}

  start(): void {
    if (this.timer) return;
    const interval = this.deps.tickIntervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => { void this.tick(); }, interval);
    logger.info({ intervalMs: interval }, 'delivery tier runner started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One combined tick: poll, then maybe-send the weekly report. */
  async tick(): Promise<TierTickResult> {
    if (this.running) {
      return { poll: EMPTY_POLL, weekly: { sent: false, reason: 'busy', weekStart: '' } };
    }
    this.running = true;
    try {
      const poll = await this.safePoll();
      const weekly = await this.safeWeekly();
      return { poll, weekly };
    } finally {
      this.running = false;
    }
  }

  private async safePoll(): Promise<TierPollResult> {
    try {
      return await this.deps.poller.runOnce();
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.stack : String(err) }, 'delivery tier poll tick failed');
      return EMPTY_POLL;
    }
  }

  private async safeWeekly(): Promise<{ sent: boolean; reason?: string; weekStart: string }> {
    try {
      return await this.deps.reporter.maybeSend();
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.stack : String(err) }, 'delivery tier weekly report failed');
      return { sent: false, reason: 'error', weekStart: '' };
    }
  }
}

const EMPTY_POLL: TierPollResult = {
  scanned: 0,
  candidates: 0,
  classified: 0,
  reclassified: 0,
  overrides: 0,
  skipped: 0,
  failed: 0,
};
