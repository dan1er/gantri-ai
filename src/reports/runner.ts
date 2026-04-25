import type { WebClient } from '@slack/web-api';
import type { ReportSubscriptionsRepo, ReportSubscriptionRow } from './reports-repo.js';
import type { ConnectorRegistry } from '../connectors/base/registry.js';
import { runWithContext } from '../orchestrator/orchestrator.js';
import { executePlan } from './plan-executor.js';
import { compilePlan } from './plan-compiler.js';
import type Anthropic from '@anthropic-ai/sdk';
import { computeNextFireAt } from './cron-utils.js';
import { deliverReport } from './delivery.js';
import { logger } from '../logger.js';

export interface RunnerDeps {
  repo: ReportSubscriptionsRepo;
  registry: ConnectorRegistry;
  slackClient: WebClient;
  slackBotToken: string;
  claude: Anthropic;
  compilerModel: string;
  /** How often the in-process loop ticks. Default 30000ms. */
  tickIntervalMs?: number;
  /** Max subscriptions claimed per tick. Default 50. */
  batchLimit?: number;
}

export class ReportsRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: RunnerDeps) {}

  start(): void {
    if (this.timer) return;
    const interval = this.deps.tickIntervalMs ?? 30000;
    this.timer = setInterval(() => { void this.tick(); }, interval);
    logger.info({ intervalMs: interval }, 'reports runner started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<{ processed: number }> {
    if (this.running) return { processed: 0 };
    this.running = true;
    try {
      return await this.runDueBatch();
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.stack : String(err) }, 'reports runner tick failed');
      return { processed: 0 };
    } finally {
      this.running = false;
    }
  }

  async runDueBatch(): Promise<{ processed: number }> {
    const limit = this.deps.batchLimit ?? 50;
    const batch = await this.deps.repo.claimDueBatch(new Date(), limit);
    if (batch.length === 0) return { processed: 0 };
    logger.info({ count: batch.length }, 'reports runner claimed batch');
    await Promise.all(batch.map((sub) => this.processOne(sub).catch((err) => {
      logger.error({ subId: sub.id, err: err instanceof Error ? err.message : String(err) }, 'report fire failed');
    })));
    return { processed: batch.length };
  }

  private async processOne(sub: ReportSubscriptionRow): Promise<void> {
    const runAt = new Date();
    let plan = sub.plan;
    let validationStatus = sub.plan_validation_status;

    // If plan is stale, attempt re-compile from original_intent first.
    if (validationStatus === 'stale') {
      try {
        const compiled = await runWithContext(
          { actor: { slackUserId: sub.slack_user_id }, thread: undefined },
          () => compilePlan({
            intent: sub.original_intent,
            registry: this.deps.registry,
            claude: this.deps.claude,
            model: this.deps.compilerModel,
            validationRunAt: runAt,
            timezone: sub.timezone,
          }),
        );
        plan = compiled.plan;
        validationStatus = 'ok';
        await this.deps.repo.update(sub.id, {
          plan,
          plan_compiled_at: runAt.toISOString(),
          plan_validation_status: 'ok',
        });
      } catch (err) {
        await this.markBroken(sub, err);
        return;
      }
    } else if (validationStatus === 'broken') {
      logger.info({ subId: sub.id }, 'skipping broken subscription');
      return;
    }

    // Execute the plan with actor context scoped to this single fire via
    // AsyncLocalStorage. Concurrent fires + concurrent user-driven runs each
    // get their own ALS frame, so the actor read by `reports.create_canvas`
    // can never get clobbered mid-flight by another caller.
    let executeError: unknown = null;
    let result: Awaited<ReturnType<typeof executePlan>> | null = null;
    try {
      result = await runWithContext(
        { actor: { slackUserId: sub.slack_user_id }, thread: undefined },
        () => executePlan({ plan, registry: this.deps.registry, runAt, timezone: sub.timezone }),
      );
    } catch (err) {
      executeError = err;
    }

    const nextRun = computeNextFireAt(sub.cron, sub.timezone, runAt);

    if (executeError || !result || result.status === 'error') {
      const msg = executeError instanceof Error ? executeError.message : (result?.errors.map((e) => `${e.alias}: ${e.message}`).join('; ') ?? 'unknown');
      const newFail = sub.fail_count + 1;
      const promote = newFail >= 3;
      await this.deps.repo.update(sub.id, {
        last_run_at: runAt.toISOString(),
        last_run_status: 'error',
        last_run_error: msg.slice(0, 500),
        fail_count: newFail,
        next_run_at: nextRun.toISOString(),
        plan_validation_status: promote ? 'stale' : sub.plan_validation_status,
      });
      // Notify the user so they aren't surprised silently.
      await this.notifyError(sub, msg);
      return;
    }

    // Success or partial.
    const footer = `Report: ${sub.display_name} • status: ${result.status}${result.errors.length ? ` (${result.errors.length} step error${result.errors.length === 1 ? '' : 's'})` : ''}`;
    await deliverReport({
      client: this.deps.slackClient,
      slackUserId: sub.slack_user_id,
      deliveryChannel: sub.delivery_channel,
      text: result.text,
      attachments: result.attachments,
      botToken: this.deps.slackBotToken,
      footer,
    });

    await this.deps.repo.update(sub.id, {
      last_run_at: runAt.toISOString(),
      last_run_status: result.status === 'partial' ? 'partial' : 'ok',
      last_run_error: result.status === 'partial' ? result.errors.map((e) => `${e.alias}: ${e.message}`).join('; ') : null,
      fail_count: result.status === 'partial' ? sub.fail_count + 1 : 0,
      next_run_at: nextRun.toISOString(),
    });
  }

  private async markBroken(sub: ReportSubscriptionRow, err: unknown): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    await this.deps.repo.update(sub.id, {
      plan_validation_status: 'broken',
      last_run_status: 'error',
      last_run_error: msg.slice(0, 500),
      fail_count: sub.fail_count + 1,
    });
    await this.notifyError(sub, `Plan re-compile failed: ${msg}\n\nThe subscription is paused. Send "rebuild my report '${sub.display_name}'" to retry.`);
  }

  private async notifyError(sub: ReportSubscriptionRow, message: string): Promise<void> {
    try {
      const dm = await this.deps.slackClient.conversations.open({ users: sub.slack_user_id });
      const channel = dm.ok ? dm.channel?.id : null;
      if (!channel) return;
      await this.deps.slackClient.chat.postMessage({
        channel,
        text: `⚠️ Your report *${sub.display_name}* failed to run.\n\n${message}`,
      });
    } catch (err) {
      logger.warn({ subId: sub.id, err: err instanceof Error ? err.message : String(err) }, 'failed to notify user of report error');
    }
  }
}
