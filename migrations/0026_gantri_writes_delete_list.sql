-- Allow gantri_writes.action to also be 'delete_list' for the new
-- klaviyo.delete_list tool. Same audit shape we use for the other gantri
-- writes — one row per delete attempt with full request/response payloads.
-- Also extends pending_confirmations.kind to allow the matching
-- 'klaviyo_delete_list' pending row that gates the yes/cancel confirmation.

BEGIN;

ALTER TABLE gantri_writes
  DROP CONSTRAINT IF EXISTS gantri_writes_action_check;

ALTER TABLE gantri_writes
  ADD CONSTRAINT gantri_writes_action_check
  CHECK (action IN ('update_customer_email', 'merge_customer_accounts', 'delete_list'));

ALTER TABLE pending_confirmations
  DROP CONSTRAINT IF EXISTS pending_confirmations_kind_check;

ALTER TABLE pending_confirmations
  ADD CONSTRAINT pending_confirmations_kind_check
  CHECK (kind IN ('klaviyo_import', 'klaviyo_delete', 'klaviyo_csv_pending', 'klaviyo_delete_list'));

COMMIT;
