-- Delivery Tier two-pass timing + calibration cross-check.
--
-- `stage` records which pass wrote the row:
--   'provisional'   — the poller's early classification from the ticket description
--                     (set at creation, gives QA planning lead time).
--   'authoritative' — the Code-Review pass re-classified from the real PR diff (or,
--                     when no PR is found, the now-mature description) and confirmed
--                     or superseded the provisional tier.
-- The Monday report measures how often provisional → authoritative changed the tier
-- (a signal that early ticket descriptions mislead).
alter table tier_classifications
  add column if not exists stage text not null default 'provisional'
    check (stage in ('provisional', 'authoritative'));

-- `calibration_mismatch` is set when the LLM's own tier disagreed with the tier the
-- deterministic rubric computed from the same signals: the result was floored to at
-- least T1 and the miss is counted in the Monday report.
alter table tier_classifications
  add column if not exists calibration_mismatch boolean not null default false;
