import { logger } from '../../../logger.js';
import type { RcaDigestReporter, RcaDigestResult } from './rca-digest.js';

/**
 * In-process scheduler for the RCA reminder digest, mirroring the delivery-tier
 * runner: a 5-minute tick asks the reporter whether a send slot is due. The
 * check is one indexed row read when nothing is due, so the cadence is cheap —
 * the board scan only happens on the tick that actually delivers.
 *
 * A tick never overlaps itself, and a failure is logged rather than thrown so
 * the loop survives an Asana or Slack outage and simply delivers on the next
 * tick within the same slot.
 */

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export interface RcaRunnerDeps {
  reporter: RcaDigestReporter;
  /** Tick cadence. Default 5 minutes. */
  tickIntervalMs?: number;
}

export class RcaDigestRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: RcaRunnerDeps) {}

  start(): void {
    if (this.timer) return;
    const interval = this.deps.tickIntervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => { void this.tick(); }, interval);
    logger.info({ intervalMs: interval }, 'rca digest runner started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<RcaDigestResult> {
    if (this.running) return { sent: false, reason: 'not_due', slotKey: null, tickets: 0 };
    this.running = true;
    try {
      return await this.deps.reporter.maybeSend();
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.stack : String(err) },
        'rca digest tick failed',
      );
      return { sent: false, slotKey: null, tickets: 0 };
    } finally {
      this.running = false;
    }
  }
}
