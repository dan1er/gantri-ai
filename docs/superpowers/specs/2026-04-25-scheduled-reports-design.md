# Scheduled Reports — Design Spec

**Date:** 2026-04-25
**Owner:** Danny
**Status:** Draft — pending review

## Goal

Let any authorized user subscribe — in natural language, via DM with the bot — to a recurring report of arbitrary scope. The bot resolves the user's intent into a **deterministic execution plan** at subscribe time, validates the plan by running it once, and stores the plan. A cron-driven runner re-executes the plan on schedule and delivers the result via Slack.

The feature must scale to many users with many subscriptions each, support filters/parameters that we haven't predicted (e.g. *"late orders of type Wholesale"*), and integrate any current or future tool (Porter, Northbeam, Grafana, etc.) — not just SQL.

## Non-Goals

- A web UI for managing subscriptions. All interaction stays in Slack DMs.
- Real-time / push reports. The runner is cron-driven only.
- Multi-tenant isolation beyond the existing `authorized_users` allowlist.
- Per-org or per-team scoping. Subscriptions are per Slack user.

## Architecture Overview

Three layers:

1. **Plan compiler** — runs the orchestrator with a meta-prompt to translate user intent into a typed execution plan, then validates the plan by running it once end-to-end.
2. **Plan executor** — deterministic, no-LLM (by default) walker over the saved plan steps. Resolves time references and cross-step references at fire time.
3. **Runner** — cron-triggered HTTP endpoint that picks due subscriptions, fans them out to the executor, and posts results via Slack.

Subscribe and lifecycle operations are exposed to the user as new tools the orchestrator can call (`reports.subscribe`, `reports.preview`, `reports.list_subscriptions`, `reports.update_subscription`, `reports.unsubscribe`, `reports.run_now`, `reports.rebuild_plan`).

## Data Model

### Table: `report_subscriptions`

```sql
create table report_subscriptions (
  id uuid primary key default gen_random_uuid(),
  slack_user_id text not null references authorized_users(slack_user_id) on delete cascade,
  display_name text not null,                   -- short label, e.g. "Weekly late wholesale orders"
  original_intent text not null,                -- the user's request as a clean English prompt;
                                                -- used by re-compile when a plan goes stale
  plan jsonb not null,                          -- validated ReportPlan (see below)
  plan_compiled_at timestamptz not null,
  plan_validation_status text not null
    check (plan_validation_status in ('ok','stale','broken')) default 'ok',

  cron text not null,                           -- 5-field cron expression, evaluated in `timezone`
  timezone text not null default 'America/Los_Angeles',
  delivery_channel text not null default 'dm'
    check (delivery_channel = 'dm' or delivery_channel like 'channel:C%'),

  enabled boolean not null default true,
  next_run_at timestamptz not null,
  last_run_at timestamptz,
  last_run_status text check (last_run_status in ('ok','partial','error')),
  last_run_error text,
  fail_count int not null default 0,            -- consecutive failures since last successful fire

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index report_subscriptions_due_idx
  on report_subscriptions (next_run_at) where enabled;
create index report_subscriptions_user_idx
  on report_subscriptions (slack_user_id);
```

`plan_validation_status` semantics:
- `ok` — last validation passed, plan executes cleanly.
- `stale` — recent fire failed once; runner will attempt re-compile on the next tick before next fire.
- `broken` — re-compile failed too. Subscription effectively paused; user is notified to re-create or rebuild.

### Plan format

```ts
type ReportPlan = {
  schemaVersion: 1;
  steps: PlanStep[];                       // executed in topological order; independent steps run in parallel
  output: OutputSpec;                      // how to render the steps' results into Slack content
  narrativeWrapup?: NarrativeSpec;         // optional 1-LLM-call summary at the end
};

type PlanStep = {
  alias: string;                           // unique within plan; referenced by other steps and output
  tool: ToolName;                          // any tool from the ConnectorRegistry, e.g. 'grafana.sql'
  args: Record<string, unknown>;           // structurally validated against the tool's schema
                                           // values may include TimeRef and StepRef placeholders
  dependsOn?: string[];                    // optional explicit dep aliases when args reference prior steps
};

type TimeRef =
  | { $time: 'now_pt' }
  | { $time: 'today_pt' }
  | { $time: 'yesterday_pt' }
  | { $time: 'this_week_pt' }              // Mon–Sun PT, current
  | { $time: 'last_week_pt' }
  | { $time: 'this_month_pt' }
  | { $time: 'last_month_pt' }
  | { $time: 'last_n_days_pt'; n: number }
  | { $time: 'wow_compare_pt' };           // expands to two ranges: current week + previous week

type StepRef = { $ref: string };           // dot-path, e.g. '$ref:late.rows[0].id'

type OutputSpec = {
  blocks: BlockSpec[];                     // ordered Slack mrkdwn blocks
};

type BlockSpec =
  | { type: 'header'; text: string }
  | { type: 'text'; text: string }                                    // ${alias.path} placeholders interpolated against the alias map
  | { type: 'table'; from: string; columns: ColumnSpec[]; maxRows?: number }
  | { type: 'csv_attachment'; from: string; filename: string };

type ColumnSpec = {
  header: string;
  field: string;                           // dot-path into a row
  format?: 'currency_dollars'|'integer'|'datetime_pt'|'admin_order_link'|'percent'|'date_pt';
};

type NarrativeSpec = {
  promptTemplate: string;                  // string with ${alias.path} interpolations
  maxTokens?: number;                      // default 400
};

type ToolName = string;                    // anything in registry.getAllTools(); validated at compile
```

A `wow_compare_pt` `TimeRef` is special: when used in a step's args, the executor runs the step **twice** with two different date ranges (current week + previous week) and exposes both results under `${alias}.current` and `${alias}.previous`.

## Plan Compiler

Triggered by `reports.subscribe(intent, cron, timezone, displayName?, deliveryChannel?)` or `reports.preview(intent)`. The bot compiles by spinning up a *child orchestrator run* with a dedicated meta-prompt:

```
You are compiling an execution plan for a recurring report.

User's intent: <original_intent>

Available tools: <list>

Output a single JSON object matching this TypeScript type: <ReportPlan>

Constraints:
- Maximum 8 steps.
- Every SQL query must compile and return well-formed rows when run.
- Use TimeRef placeholders for any "this week", "yesterday", etc. — never hard-code dates.
- Prefer grafana.sql for any aggregation across the Porter schema (cheaper, deterministic).
- Use Porter API tools only when you need data the read-replica doesn't expose (e.g. live shipping status).
- The output blocks should be tight and Slack-mrkdwn-friendly.
- Skip narrativeWrapup unless the user explicitly asked for analysis/commentary.

When you have a candidate plan, validate it: invoke each step's tool once with realistic time bindings (use today's date as the reference). If anything errors, fix and retry. Output only the final, validated plan as your final assistant message.
```

The compiler:
1. Hands the meta-prompt to the orchestrator with a special tool-set: all read tools available, plus a sandbox `plan.test_sql` that wraps `grafana.sql` with stricter limits (no DDL, max 5 rows, max 30s timeout).
2. Iterates up to 12 times (vs 8 for normal queries — compile is expected to be heavier).
3. Captures the JSON plan from the final assistant message, parses, validates against the schema.
4. Runs the **full plan once** end-to-end through the executor as a final smoke test. If anything fails, the compiler returns a failure and the user is told why.

`reports.preview(intent)` runs steps 1–4 and returns the rendered output to the user without saving anything. `reports.subscribe(intent, ...)` does the same and additionally inserts the row.

## Plan Executor

A pure TypeScript walker, no LLM (unless `narrativeWrapup` is set):

1. Resolve all `TimeRef`s against `runAt` (the cron fire time), in `subscription.timezone`.
2. Build a step DAG. Run independent steps in parallel; serialize where one step `dependsOn` another.
3. For each step: look up the tool in the `ConnectorRegistry`, substitute `StepRef` placeholders with values from completed steps, call `execute(args)`. Capture result by `alias`.
4. If a step fails, mark the run partial. Continue executing steps that don't depend on it. The other steps still get rendered; the failed step is replaced with `*Error: <message>*` in its output blocks.
5. Render `OutputSpec` against the alias map. Format helpers handle currency, datetime, admin links, etc.
6. If `narrativeWrapup` is set, fire a single LLM call with the assembled blocks + the prompt template, append the result.
7. Return the rendered Slack blocks + any attachments.

## Runner

Endpoint `POST /internal/run-due-reports` (shared-secret header). Triggered by GitHub Actions cron every 5 minutes:

```yaml
# .github/workflows/run-reports.yml
on:
  schedule: [{ cron: '*/5 * * * *' }]
  workflow_dispatch: {}
```

The endpoint:

1. `SELECT … FROM report_subscriptions WHERE enabled AND next_run_at <= now() FOR UPDATE SKIP LOCKED LIMIT 50` — picks up to 50 due subscriptions, locks them so multiple workers don't double-fire.
2. For each subscription:
   - If `plan_validation_status = 'broken'` and `fail_count >= 3`, skip (already notified).
   - If `plan_validation_status = 'stale'`, attempt re-compile from `original_intent` first. On success, save and continue. On failure, set `'broken'`, DM the user, skip.
   - Otherwise execute the plan. On success, post to `delivery_channel`, reset `fail_count = 0`, set `last_run_status = 'ok'`.
   - On `partial` (some steps failed): post the partial output, increment `fail_count`, set `last_run_status = 'partial'`. Don't mark broken yet.
   - On total failure: set `last_run_status = 'error'`, `last_run_error`, increment `fail_count`. If `fail_count >= 3`, set `plan_validation_status = 'stale'` to trigger re-compile next tick.
3. Compute the next `next_run_at` from the cron expression in the subscription's timezone; set `last_run_at = now()`.
4. Commit. Lock releases.

The 5-minute granularity is fine for daily/weekly reports; nobody is asking for sub-minute schedules and adding finer granularity would require a separate runner architecture.

## User-Facing Tools

All exposed via the orchestrator so they're callable from a normal DM. The Slack handler threads the calling user's `slack_user_id` into the `OrchestratorInput` as a new `actorContext` field; the `reports.*` tools read this from runtime context and use it as the implicit owner of any new subscription. Tool args **never** accept `slack_user_id` directly — a user cannot subscribe somebody else.

For `update_subscription`, `unsubscribe`, `run_now`, and `rebuild_plan`: the tool first verifies that the target subscription's `slack_user_id` matches `actorContext.slack_user_id`. Mismatches return a not-found error (don't leak existence).

If `intent` is changed via `update_subscription`, the tool re-runs the full compile pipeline (validate + smoke-test) before persisting. Other field updates skip compilation.

| Tool | Purpose |
|------|---------|
| `reports.preview(intent)` | Compile + execute once, return rendered output. Does not save. |
| `reports.subscribe(intent, cron, timezone?, displayName?, deliveryChannel?)` | Compile + execute once + save. Returns the subscription. |
| `reports.list_subscriptions()` | List the calling user's subscriptions: id, display_name, schedule, last_run_at, status. |
| `reports.update_subscription(id, {intent?, cron?, timezone?, displayName?, deliveryChannel?, enabled?})` | If `intent` changes, re-compile from scratch. Other fields just update. |
| `reports.unsubscribe(id)` | Sets `enabled = false`. Row stays for audit; the runner skips disabled rows. |
| `reports.run_now(id)` | Force a single fire immediately. Doesn't change `next_run_at`. |
| `reports.rebuild_plan(id)` | Re-compile from `original_intent`. Used to recover a `broken` subscription. |

The bot is responsible for translating natural-language schedules ("every Monday at 7am") into cron + timezone. No external library needed; the system prompt gains a small "schedule parsing" section with examples.

## System Prompt Additions

A new section is appended to the system prompt explaining:
- The `reports.*` tools and when to use each.
- Cron parsing examples ("daily at 9am PT" → `0 9 * * *` + `America/Los_Angeles`).
- The expectation that the bot **rewrites** the user's casual intent into a precise English `displayName` and a more rigorous `original_intent` before calling `reports.subscribe`.
- The `reports.preview` flow: when the user says *"show me what this would look like"*, call `preview` first; only call `subscribe` once they confirm.

## Cost & Limits

- Compile cost: ~30–50K tokens per call, ~$0.50 each. Happens once at subscribe and on rare re-compiles.
- Fire cost: zero LLM by default; a few SQL/tool calls. <2s wall time. With `narrativeWrapup`: +~5K tokens (~$0.02).
- Per-user soft cap: 10 active subscriptions. Past that, `reports.subscribe` returns an error suggesting `unsubscribe` first.
- Plan size cap: 8 steps. Enforced at compile.
- Cron resolution: 5 minutes (runner ticks every 5 min).

## Failure & Recovery

- **Single-step error during a fire:** continue, render partial, increment `fail_count`, post the partial result with an inline error note.
- **Total fire error 3+ times in a row:** mark plan `stale` → next tick triggers re-compile from `original_intent`.
- **Re-compile fails:** mark `broken`, send the user a DM with the error and a button (or instructions) to `reports.rebuild_plan(id)`.
- **Schema drift / tool removed:** caught at re-compile; same flow as above.

## Open Questions / Out of Scope for v1

- **Multi-channel delivery in one subscription** ("DM me AND post to #ops"): out of scope; create two subscriptions.
- **Cross-subscription deduplication** (two users subscribed to the same query): not done in v1; runner just executes both. Cheap because plans are deterministic and fast.
- **Editing plan JSON directly:** not exposed. All edits go through `update_subscription` with a new `intent`.
- **Reports that require user-specific data** (e.g. *"my orders"*): out of scope until we associate Slack users with Porter user IDs. Today, all subscriptions operate on global Gantri data.
- **Backfill / "what would this report have looked like last Monday?":** not in v1.

## Migration

```sql
-- 0002_scheduled_reports.sql
create table report_subscriptions (...);  -- as above
```

No data backfill needed; existing infrastructure (`authorized_users`, Slack client, Connector Registry, Orchestrator) is reused as-is.
