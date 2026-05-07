-- Extend pipedrive_writes.action CHECK to include 'delete_lead' (tier 1
-- destructive op for marketing/admin to undo accidental lead creation —
-- mostly for trade-show / E2E test cleanup). Pipedrive's 90-day recycle bin
-- means actual data loss is recoverable, so LLM-driven confirm gate is
-- sufficient (no pending_confirmations infra needed).

ALTER TABLE pipedrive_writes
  DROP CONSTRAINT pipedrive_writes_action_check;

ALTER TABLE pipedrive_writes
  ADD CONSTRAINT pipedrive_writes_action_check
  CHECK (action IN ('create_lead', 'add_note', 'create_activity', 'delete_lead'));
