-- Delivery Tier auto-classifier state.
--
-- `tier_classifications` is the bot's memory of what it set on each Software
-- Board task: the extracted facts, the computed tier, and the content hash that
-- makes re-classification cheap (identical hash → identical facts → skip). It is
-- also the source of truth for human overrides — if the current Asana field value
-- differs from what the bot recorded, a human changed it, so the bot marks the row
-- `human_override` and never touches that task again (it feeds the Monday report).
create table if not exists tier_classifications (
  task_gid text primary key,
  input_hash text not null,
  prompt_version int not null,
  facts jsonb not null,
  tier text not null check (tier in ('T0','T1','T2')),
  lifted_by_unclear boolean not null default false,
  flags jsonb not null default '[]',
  domain text,
  -- The tier the bot has verified is written to the Asana field. Distinct from
  -- `tier` (the bot's latest decision, which may be one step ahead if the field
  -- write is mid-flight). The two together let the poller tell its own
  -- incomplete write apart from a human override across a crash / partial failure.
  confirmed_tier text check (confirmed_tier in ('T0','T1','T2')),
  decided_by text not null default 'bot' check (decided_by in ('bot','human_override')),
  human_tier text,
  comment_gid text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tier_classifications_created_at_idx on tier_classifications (created_at);
create index if not exists tier_classifications_decided_by_idx on tier_classifications (decided_by);

-- `tier_pr_checks` (v2 — PR re-check). Recorded so a given (repo, PR, head_sha)
-- is only re-evaluated once. Not written by v1; the table is created now so the
-- schema is complete and v2 needs no migration.
create table if not exists tier_pr_checks (
  repo text not null,
  pr_number int not null,
  head_sha text not null,
  task_gid text,
  verdict text not null,               -- 'consistent' | 'raise' | 'no_ticket' | 'not_classified'
  suggested_tier text,
  commented boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (repo, pr_number, head_sha)
);

-- `tier_weekly_reports` makes the Monday report idempotent: one row per week keyed
-- by the Monday date; the poller only sends when no row exists for the current week.
create table if not exists tier_weekly_reports (
  week_start date primary key,
  sent_at timestamptz not null default now(),
  payload jsonb not null
);
