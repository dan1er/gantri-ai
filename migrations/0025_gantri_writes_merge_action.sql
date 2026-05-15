-- Allow gantri_writes.action to also be 'merge_customer_accounts' for the new
-- gantri.merge_customer_accounts tool. Mirrors how update_customer_email is
-- audited — one row per merge attempt with full request/response payloads.

ALTER TABLE gantri_writes
  DROP CONSTRAINT IF EXISTS gantri_writes_action_check;

ALTER TABLE gantri_writes
  ADD CONSTRAINT gantri_writes_action_check
  CHECK (action IN ('update_customer_email', 'merge_customer_accounts'));
