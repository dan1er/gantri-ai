-- Drop the orphaned Delivery Tier diff-derived floor column.
--
-- `diff_floor_tier` (0037) protected a tier that the original standalone all-PRs
-- sweep raised from the authoritative diff. That sweep was replaced by the
-- Code-Review authoritative pass, which finalizes the tier from the diff and marks
-- the row `stage = 'authoritative'`. The provisional poller now refuses to
-- re-classify an authoritative row on a later notes edit (the stage gate), so the
-- floor never had anything to protect and nothing ever wrote it. Remove the dead
-- column so the schema matches the code.
alter table tier_classifications
  drop column if exists diff_floor_tier;
