-- Allow a third pending_confirmations.kind value: klaviyo_csv_pending.
-- Used by the file_shared handler to stash a parsed CSV's rows while it asks
-- the user which list to import them to (Klaviyo's bulk-subscribe silently
-- drops the request when no list is attached, so we can't auto-submit).
alter table pending_confirmations drop constraint pending_confirmations_kind_check;
alter table pending_confirmations add constraint pending_confirmations_kind_check
  check (kind in ('klaviyo_import', 'klaviyo_delete', 'klaviyo_csv_pending'));
