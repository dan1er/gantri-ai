-- Scheduled reports: per-user subscriptions to recurring report plans.
create table if not exists report_subscriptions (
  id uuid primary key default gen_random_uuid(),
  slack_user_id text not null references authorized_users(slack_user_id) on delete cascade,
  display_name text not null,
  original_intent text not null,
  plan jsonb not null,
  plan_compiled_at timestamptz not null default now(),
  plan_validation_status text not null
    check (plan_validation_status in ('ok','stale','broken'))
    default 'ok',
  cron text not null,
  timezone text not null default 'America/Los_Angeles',
  delivery_channel text not null default 'dm'
    check (delivery_channel = 'dm' or delivery_channel like 'channel:C%'),
  enabled boolean not null default true,
  next_run_at timestamptz not null,
  last_run_at timestamptz,
  last_run_status text check (last_run_status in ('ok','partial','error')),
  last_run_error text,
  fail_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists report_subscriptions_due_idx
  on report_subscriptions (next_run_at) where enabled;
create index if not exists report_subscriptions_user_idx
  on report_subscriptions (slack_user_id);
