-- RCA reminder digest — idempotency ledger.
--
-- The bot posts a list of closed bugs whose root-cause-analysis subtasks are
-- still unchecked to the software channel twice a day (08:00 and 16:00
-- America/New_York). The runner ticks every few minutes, so it needs a record of
-- which slots it has already delivered: one row per slot, keyed
-- `YYYY-MM-DD:HH` in New York local time. No row for the current slot → send.
--
-- The payload is kept so a digest can be reconstructed after the fact (what was
-- outstanding on a given morning) without re-reading Asana history.
create table if not exists rca_digests (
  slot_key text primary key,
  sent_at timestamptz not null default now(),
  -- How many bugs were listed. 0 rows are recorded too: an all-clear slot still
  -- has to be marked delivered so the runner does not retry it every tick.
  ticket_count int not null default 0,
  payload jsonb not null
);

create index if not exists rca_digests_sent_at_idx on rca_digests (sent_at);
