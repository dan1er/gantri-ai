-- Delivery Tier diff-derived floor.
--
-- When the v2 PR re-check raises a ticket's tier from the authoritative PR diff,
-- it records that raised tier here as a floor. A later text-only re-classification
-- (triggered by a ticket description edit) must never lower the field below this
-- floor: the diff is the authoritative risk source and lowering is never automatic.
-- Null means "no diff-derived floor" (the common case).
alter table tier_classifications
  add column if not exists diff_floor_tier text check (diff_floor_tier in ('T0','T1','T2'));
