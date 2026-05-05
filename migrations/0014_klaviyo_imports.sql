-- Audit table for klaviyo.import_profiles. One row per executed import (not
-- including cancelled confirmations). No FK on caller_slack_id → authorized_users:
-- audit history must survive caller revocation, and the role gate already
-- enforces that callers were authorized at import time.
create table if not exists klaviyo_imports (
  id                       uuid primary key default gen_random_uuid(),
  caller_slack_id          text not null,
  caller_email             text,
  source                   text not null check (source in ('inline','csv')),
  filename                 text,
  storage_path             text,
  list_id                  text,
  list_name                text,
  channels                 text[] not null,
  total_submitted          integer not null,
  total_imported           integer not null default 0,
  total_invalid_rejected   integer not null default 0,
  klaviyo_job_id           text not null,
  status                   text not null check (status in ('queued','processing','complete','failed')),
  started_at               timestamptz not null default now(),
  completed_at             timestamptz,
  succeeded_count          integer,
  already_subscribed_count integer,
  failed_count             integer,
  error_summary            text,
  constraint klaviyo_imports_status_terminal_has_completed_at
    check ((status in ('complete','failed') and completed_at is not null)
        or (status in ('queued','processing') and completed_at is null))
);

create index if not exists klaviyo_imports_caller_idx  on klaviyo_imports(caller_slack_id, started_at desc);
create index if not exists klaviyo_imports_pending_idx on klaviyo_imports(status) where status in ('queued','processing');
create index if not exists klaviyo_imports_job_idx     on klaviyo_imports(klaviyo_job_id);
