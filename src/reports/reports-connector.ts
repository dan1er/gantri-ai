import { z } from 'zod';
import type { Connector, ToolDef } from '../connectors/base/connector.js';
import type { ReportSubscriptionsRepo, ReportSubscriptionRow } from './reports-repo.js';
import type { ReportPlan } from './plan-types.js';
import type { ExecutePlanResult } from './plan-executor.js';
import { isValidCron } from './cron-utils.js';

/**
 * Per-call actor context. Threaded through the orchestrator from the Slack
 * handler so that reports.* tools can attribute new subscriptions to the
 * caller and reject cross-user mutations.
 */
export interface ActorContext {
  slackUserId: string;
  slackChannelId?: string;
}

export interface ScheduledReportsConnectorDeps {
  repo: ReportSubscriptionsRepo;
  /** Resolves the calling actor for the in-flight orchestrator run. */
  getActor: () => ActorContext;
  /** Compiles an intent → validated ReportPlan. */
  compile: (intent: string) => Promise<{ plan: ReportPlan; validation: ExecutePlanResult }>;
  /** Executes a plan once (used by run_now). */
  execute: (plan: ReportPlan, runAt: Date, timezone: string) => Promise<ExecutePlanResult>;
  /** Computes the next cron fire after `after` in the given tz. */
  nextFireAt: (cron: string, timezone: string, after: Date) => Date;
  /** Per-user soft cap on active subscriptions. */
  maxActivePerUser?: number;
}

/**
 * Tool returns from this connector follow the convention shared with the
 * other Gantri connectors: successful executions return a raw payload
 * object, and the connector registry wraps it as `{ ok: true, data: ... }`
 * before handing it to the orchestrator. Errors return the wrapped form
 * `{ ok: false, error: { code, message } }` directly so the registry passes
 * them through unchanged. See `ConnectorRegistry.execute` for the wrap rule.
 */
type ToolReturn = Record<string, unknown> | { ok: false; error: { code: string; message: string } };

const SubscribeArgs = z.object({
  intent: z.string().min(3).max(2000),
  cron: z.string().min(3).max(120),
  timezone: z.string().min(3).max(64).optional(),
  displayName: z.string().min(1).max(120).optional(),
  deliveryChannel: z.string().regex(/^(dm|channel:C[A-Z0-9]+)$/).optional(),
});
type SubscribeArgs = z.infer<typeof SubscribeArgs>;

const PreviewArgs = z.object({
  intent: z.string().min(3).max(2000),
});
type PreviewArgs = z.infer<typeof PreviewArgs>;

const ListArgs = z.object({});
type ListArgs = z.infer<typeof ListArgs>;

const UpdateArgs = z.object({
  id: z.string().uuid(),
  intent: z.string().min(3).max(2000).optional(),
  cron: z.string().min(3).max(120).optional(),
  timezone: z.string().min(3).max(64).optional(),
  displayName: z.string().min(1).max(120).optional(),
  deliveryChannel: z.string().regex(/^(dm|channel:C[A-Z0-9]+)$/).optional(),
  enabled: z.boolean().optional(),
});
type UpdateArgs = z.infer<typeof UpdateArgs>;

const IdArgs = z.object({ id: z.string().uuid() });
type IdArgs = z.infer<typeof IdArgs>;

export class ScheduledReportsConnector implements Connector {
  readonly name = 'reports';
  readonly tools: readonly ToolDef[];

  constructor(private readonly deps: ScheduledReportsConnectorDeps) {
    this.tools = this.buildTools();
  }

  async healthCheck() {
    return { ok: true };
  }

  private buildTools(): ToolDef[] {
    const subscribe: ToolDef<SubscribeArgs> = {
      name: 'reports.subscribe',
      description:
        'Subscribe the calling user to a recurring report. Compiles `intent` into a deterministic execution plan, runs it once to validate, and saves the subscription. Returns the saved subscription on success. The bot should rewrite the user\'s casual ask into a precise English `intent` (specifying tables, columns, filters, formatting) before calling.',
      schema: SubscribeArgs as z.ZodType<SubscribeArgs>,
      jsonSchema: subscribeJsonSchema(),
      execute: (args) => this.executeSubscribe(args),
    };
    const preview: ToolDef<PreviewArgs> = {
      name: 'reports.preview',
      description:
        'Compile + execute a report intent ONCE without saving. Use when the user wants to "see what this would look like" before subscribing. Returns the rendered text + attachments.',
      schema: PreviewArgs as z.ZodType<PreviewArgs>,
      jsonSchema: { type: 'object', additionalProperties: false, required: ['intent'], properties: { intent: { type: 'string' } } },
      execute: (args) => this.executePreview(args),
    };
    const list: ToolDef<ListArgs> = {
      name: 'reports.list_subscriptions',
      description:
        'List the calling user\'s scheduled report subscriptions: id, displayName, schedule (cron+tz), nextRunAt, lastRunAt, status.',
      schema: ListArgs as z.ZodType<ListArgs>,
      jsonSchema: { type: 'object', additionalProperties: false, properties: {} },
      execute: () => this.executeList(),
    };
    const update: ToolDef<UpdateArgs> = {
      name: 'reports.update_subscription',
      description:
        'Update a subscription owned by the caller. If `intent` is provided, the plan is re-compiled and re-validated; other fields update without re-compile.',
      schema: UpdateArgs as z.ZodType<UpdateArgs>,
      jsonSchema: updateJsonSchema(),
      execute: (args) => this.executeUpdate(args),
    };
    const unsubscribe: ToolDef<IdArgs> = {
      name: 'reports.unsubscribe',
      description: 'Disable (soft-delete) a subscription owned by the caller.',
      schema: IdArgs as z.ZodType<IdArgs>,
      jsonSchema: idJsonSchema(),
      execute: (args) => this.executeUnsubscribe(args),
    };
    const runNow: ToolDef<IdArgs> = {
      name: 'reports.run_now',
      description: 'Force an immediate execution of a subscription owned by the caller. Does not change next_run_at.',
      schema: IdArgs as z.ZodType<IdArgs>,
      jsonSchema: idJsonSchema(),
      execute: (args) => this.executeRunNow(args),
    };
    const rebuild: ToolDef<IdArgs> = {
      name: 'reports.rebuild_plan',
      description: 'Re-compile a subscription\'s plan from its original_intent. Used to recover a `broken` subscription.',
      schema: IdArgs as z.ZodType<IdArgs>,
      jsonSchema: idJsonSchema(),
      execute: (args) => this.executeRebuild(args),
    };
    return [subscribe, preview, list, update, unsubscribe, runNow, rebuild];
  }

  private async executeSubscribe(args: SubscribeArgs): Promise<ToolReturn> {
    if (!isValidCron(args.cron)) {
      return { ok: false, error: { code: 'INVALID_CRON', message: `Invalid cron: ${args.cron}` } };
    }
    const tz = args.timezone ?? 'America/Los_Angeles';
    const actor = this.deps.getActor();
    const cap = this.deps.maxActivePerUser ?? 10;
    const existing = await this.deps.repo.listByUser(actor.slackUserId);
    const active = existing.filter((r) => r.enabled);
    if (active.length >= cap) {
      return { ok: false, error: { code: 'LIMIT_REACHED', message: `You already have ${cap} active subscriptions. Unsubscribe from one before adding more.` } };
    }
    const compiled = await this.deps.compile(args.intent);
    const nextRun = this.deps.nextFireAt(args.cron, tz, new Date());
    const row = await this.deps.repo.insert({
      slack_user_id: actor.slackUserId,
      display_name: args.displayName ?? deriveDisplayName(args.intent),
      original_intent: args.intent,
      plan: compiled.plan,
      cron: args.cron,
      timezone: tz,
      delivery_channel: args.deliveryChannel ?? 'dm',
      next_run_at: nextRun.toISOString(),
    });
    return {
      subscription: shapeSub(row),
      validation: { status: compiled.validation.status, errors: compiled.validation.errors },
    };
  }

  private async executePreview(args: PreviewArgs): Promise<ToolReturn> {
    const compiled = await this.deps.compile(args.intent);
    return {
      plan: compiled.plan,
      text: compiled.validation.text,
      attachments: compiled.validation.attachments,
      status: compiled.validation.status,
      errors: compiled.validation.errors,
    };
  }

  private async executeList(): Promise<ToolReturn> {
    const actor = this.deps.getActor();
    const rows = await this.deps.repo.listByUser(actor.slackUserId);
    return { subscriptions: rows.map(shapeSub) };
  }

  private async executeUpdate(args: UpdateArgs): Promise<ToolReturn> {
    const actor = this.deps.getActor();
    const row = await this.deps.repo.getById(args.id);
    if (!row || row.slack_user_id !== actor.slackUserId) {
      return { ok: false, error: { code: 'NOT_FOUND', message: 'subscription not found' } };
    }
    if (args.cron !== undefined && !isValidCron(args.cron)) {
      return { ok: false, error: { code: 'INVALID_CRON', message: `Invalid cron: ${args.cron}` } };
    }
    const fields: Record<string, unknown> = {};
    if (args.cron !== undefined) {
      fields.cron = args.cron;
      const tz = args.timezone ?? row.timezone;
      fields.next_run_at = this.deps.nextFireAt(args.cron, tz, new Date()).toISOString();
    }
    if (args.timezone !== undefined) fields.timezone = args.timezone;
    if (args.displayName !== undefined) fields.display_name = args.displayName;
    if (args.deliveryChannel !== undefined) fields.delivery_channel = args.deliveryChannel;
    if (args.enabled !== undefined) fields.enabled = args.enabled;
    if (args.intent !== undefined) {
      const compiled = await this.deps.compile(args.intent);
      fields.original_intent = args.intent;
      fields.plan = compiled.plan;
      fields.plan_compiled_at = new Date().toISOString();
      fields.plan_validation_status = 'ok';
    }
    const updated = await this.deps.repo.update(args.id, fields);
    return { subscription: shapeSub(updated) };
  }

  private async executeUnsubscribe(args: IdArgs): Promise<ToolReturn> {
    const actor = this.deps.getActor();
    const row = await this.deps.repo.getById(args.id);
    if (!row || row.slack_user_id !== actor.slackUserId) {
      return { ok: false, error: { code: 'NOT_FOUND', message: 'subscription not found' } };
    }
    await this.deps.repo.update(args.id, { enabled: false });
    return { id: args.id, enabled: false };
  }

  private async executeRunNow(args: IdArgs): Promise<ToolReturn> {
    const actor = this.deps.getActor();
    const row = await this.deps.repo.getById(args.id);
    if (!row || row.slack_user_id !== actor.slackUserId) {
      return { ok: false, error: { code: 'NOT_FOUND', message: 'subscription not found' } };
    }
    const result = await this.deps.execute(row.plan, new Date(), row.timezone);
    return {
      status: result.status,
      text: result.text,
      attachments: result.attachments,
      errors: result.errors,
    };
  }

  private async executeRebuild(args: IdArgs): Promise<ToolReturn> {
    const actor = this.deps.getActor();
    const row = await this.deps.repo.getById(args.id);
    if (!row || row.slack_user_id !== actor.slackUserId) {
      return { ok: false, error: { code: 'NOT_FOUND', message: 'subscription not found' } };
    }
    const compiled = await this.deps.compile(row.original_intent);
    const updated = await this.deps.repo.update(args.id, {
      plan: compiled.plan,
      plan_compiled_at: new Date().toISOString(),
      plan_validation_status: 'ok',
      fail_count: 0,
    });
    return {
      subscription: shapeSub(updated),
      validation: { status: compiled.validation.status, errors: compiled.validation.errors },
    };
  }
}

function shapeSub(row: ReportSubscriptionRow) {
  return {
    id: row.id,
    displayName: row.display_name,
    cron: row.cron,
    timezone: row.timezone,
    deliveryChannel: row.delivery_channel,
    enabled: row.enabled,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status,
    lastRunError: row.last_run_error,
    failCount: row.fail_count,
    planValidationStatus: row.plan_validation_status,
    originalIntent: row.original_intent,
  };
}

function deriveDisplayName(intent: string): string {
  const cleaned = intent.replace(/\s+/g, ' ').trim();
  return cleaned.length > 80 ? cleaned.slice(0, 77) + '…' : cleaned;
}

function subscribeJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['intent', 'cron'],
    properties: {
      intent: { type: 'string', description: 'Precise English description of the report; the bot should rewrite the user\'s casual ask into specific tables/columns/filters/formatting before calling.' },
      cron: { type: 'string', description: 'Standard 5-field cron expression. Examples: "*/5 * * * *", "0 9 * * 1-5", "0 7 * * 1".' },
      timezone: { type: 'string', description: 'IANA timezone (default: America/Los_Angeles).' },
      displayName: { type: 'string', description: 'Short human label, e.g. "Daily late wholesale orders".' },
      deliveryChannel: { type: 'string', description: '"dm" (default) or "channel:CXXXXXXXX".' },
    },
  };
}

function updateJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: { type: 'string' },
      intent: { type: 'string' },
      cron: { type: 'string' },
      timezone: { type: 'string' },
      displayName: { type: 'string' },
      deliveryChannel: { type: 'string' },
      enabled: { type: 'boolean' },
    },
  };
}

function idJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string' } },
  };
}
