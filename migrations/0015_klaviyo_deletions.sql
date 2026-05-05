-- Audit table for klaviyo.delete_profiles. One row per executed deletion batch
-- (not including cancelled confirmations). No FK on caller_slack_id →
-- authorized_users: audit history must survive caller revocation, and the role
-- gate already enforces that callers were authorized at deletion time.
create table if not exists klaviyo_deletions (
  id                  uuid primary key default gen_random_uuid(),
  caller_slack_id     text not null,
  caller_email        text,
  requested_emails    jsonb not null,
  found_count         integer not null,
  deleted_count       integer not null,
  failed_count        integer not null,
  failed_details      jsonb not null default '[]',
  status              text not null check (status in ('submitted')),
  started_at          timestamptz not null default now(),
  completed_at        timestamptz not null default now()
);

create index if not exists klaviyo_deletions_caller_idx on klaviyo_deletions(caller_slack_id, started_at desc);
