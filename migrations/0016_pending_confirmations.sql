-- Generic short-lived staging for confirmation flows (currently kinds
-- 'klaviyo_import' and 'klaviyo_delete'). Holds the caller's intent + payload
-- for ~30 minutes until they confirm or the row expires. No FK on
-- caller_slack_id → authorized_users: rows are ephemeral and the role gate
-- already enforces authorization at staging time.
create table if not exists pending_confirmations (
  id                  uuid primary key default gen_random_uuid(),
  confirmation_token  uuid not null unique,
  caller_slack_id     text not null,
  channel_id          text not null,
  thread_ts           text not null,
  kind                text not null check (kind in ('klaviyo_import','klaviyo_delete')),
  payload             jsonb not null,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null default (now() + interval '30 minutes')
);

create index if not exists pending_confirmations_lookup_idx
  on pending_confirmations(caller_slack_id, channel_id, thread_ts);
create index if not exists pending_confirmations_expiry_idx
  on pending_confirmations(expires_at);
