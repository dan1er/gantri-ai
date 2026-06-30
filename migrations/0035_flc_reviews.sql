-- Persist /review-flc review state so the result message's buttons (post / copy
-- prompt / discard) keep working across bot restarts and redeploys. Keyed by the
-- Slack result-message ts. Page blocks are NOT stored — they are re-fetched from
-- Notion at post time so anchoring stays fresh.
create table if not exists flc_reviews (
  message_ts text primary key,
  channel text not null,
  page_id text not null,
  url text not null,
  findings jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists flc_reviews_created_at_idx on flc_reviews (created_at);
