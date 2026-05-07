-- Add 'delete_person' to the pipedrive_writes.action enum so the new
-- pipedrive.delete_person tool can audit successful + failed deletes.
-- Same pattern as 0019 / 0020.

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
    'delete_organization',
    'delete_person'
  ));
