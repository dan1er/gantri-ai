-- Last-known-good snapshot of the live Delivery Tier rubric (the Notion "Delivery
-- Tier Classifier" page). The classifier reads its rubric FROM the page at runtime
-- so editing the page recalibrates the bot within one poll cycle, with no deploy.
-- This single row is the persisted fallback: on a cold boot the bot adopts it
-- BEFORE the first live fetch, so a Notion outage can never block classification.
-- `page_text` is the rendered page BODY (pre machine-appendix); the repo-owned
-- appendix is re-appended at load time, so the signals JSON contract stays stable
-- under page edits.
create table if not exists tier_rubric_cache (
  id int primary key check (id = 1),
  page_text text not null,
  version int not null,
  hash text not null,
  fetched_at timestamptz not null default now()
);
