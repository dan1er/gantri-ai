-- User-flagged feedback on bot responses. The bot's `feedback.flag_response`
-- tool inserts a row here AND DMs the maintainer; this table is the
-- durable record + status tracker.
create table if not exists feedback_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_slack_user_id text not null references authorized_users(slack_user_id) on delete cascade,
  reason text,                                          -- user's note, e.g. "totals don't match Grafana"
  channel_id text not null,                             -- Slack channel / DM where the flagged thread lives
  thread_ts text not null,                              -- timestamp anchor of the flagged Slack thread
  thread_permalink text,                                -- pre-built Slack permalink so the maintainer can jump back

  -- Snapshot of the conversation at flag-time so the report stays useful even
  -- if the underlying conversations row is later deleted.
  captured_question text,
  captured_response text,
  captured_tool_calls jsonb,
  captured_model text,
  captured_iterations int,

  status text not null
    check (status in ('open','investigating','resolved','wontfix'))
    default 'open',
  resolution text,                                      -- maintainer's notes on close
  resolved_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists feedback_reports_open_idx
  on feedback_reports (created_at desc) where status in ('open','investigating');
create index if not exists feedback_reports_reporter_idx
  on feedback_reports (reporter_slack_user_id, created_at desc);
