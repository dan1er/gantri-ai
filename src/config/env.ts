import { z } from 'zod';

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_SIGNING_SECRET: z.string().min(1),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'silent']).default('info'),
  DEBUG_FULL_LOGS: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true')
    .default(false),
  PORT: z.coerce.number().int().positive().default(3000),
  INTERNAL_SHARED_SECRET: z.string().optional(),
  MAINTAINER_SLACK_USER_ID: z.string().optional(),
  OPS_CHANNEL_ID: z.string().optional(),
  // Slack channel id for the software team's code-review requests. When the
  // delivery-tier Code-Review authoritative pass first classifies a ticket it
  // posts a review request here so reviewers get pinged with context. Optional —
  // unset disables the feature (one boot-time warn).
  SOFTWARE_CHANNEL_ID: z.string().optional(),
  // Comma-separated Slack user IDs allowed to drive /preview and /deploy from
  // their DM with the bot (in addition to the ops channel). Empty = ops only.
  DEVOPS_DM_USER_IDS: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_OWNER: z.string().default('gantri'),
  VERCEL_TOKEN: z.string().optional(),
  VERCEL_TEAM_ID: z.string().optional(),
  QASE_API_TOKEN: z.string().optional(),
  // Notion internal-integration token for /review-flc (read pages + post
  // comments). Read from the Supabase vault in index.ts; optional so the bot
  // still boots without it (the command is simply not registered).
  NOTION_API_TOKEN: z.string().optional(),
  // Delivery-tier auto-classifier: only tasks created at or after this date are
  // classified (no backfill spam). ISO date; defaults to the rollout day.
  ROLLOUT_DATE: z.string().default('2026-07-14'),
  // Fallback Slack user id for the Monday delivery-tier report DM when Danny's
  // row cannot be resolved from `authorized_users`.
  DANNY_SLACK_USER_ID: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, unknown> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const msg = result.error.errors
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${msg}`);
  }
  return result.data;
}
