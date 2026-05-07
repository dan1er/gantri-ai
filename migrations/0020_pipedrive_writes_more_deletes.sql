-- Extend pipedrive_writes.action CHECK to include the rest of the destructive
-- ops marketing/admin can run from Slack: notes, activities, organizations.
-- Same pattern as 0019_pipedrive_writes_delete_action.sql (added delete_lead).
-- All destructive ops are LLM-confirmed two-step; Pipedrive's recycle bin
-- (~30-90 days depending on resource) means recoverability is high.

ALTER TABLE pipedrive_writes
  DROP CONSTRAINT pipedrive_writes_action_check;

ALTER TABLE pipedrive_writes
  ADD CONSTRAINT pipedrive_writes_action_check
  CHECK (action IN (
    'create_lead',
    'add_note',
    'create_activity',
    'delete_lead',
    'delete_note',
    'delete_activity',
    'delete_organization'
  ));
