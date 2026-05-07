-- One row per Pipedrive write triggered from the bot. Used to forensically
-- map a Slack user → the Pipedrive resource they created (Pipedrive's own
-- creator/timestamp logs only the API token's user, not the actual operator).

CREATE TABLE IF NOT EXISTS pipedrive_writes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_slack_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('create_lead', 'add_note', 'create_activity')),
  pipedrive_resource_type text CHECK (
    pipedrive_resource_type IS NULL OR
    pipedrive_resource_type IN ('lead', 'note', 'activity', 'person', 'organization')
  ),
  pipedrive_resource_id text,
  request_payload jsonb NOT NULL,
  response_payload jsonb,
  status text NOT NULL CHECK (status IN ('success', 'failure')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pipedrive_writes_caller_idx
  ON pipedrive_writes (caller_slack_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pipedrive_writes_resource_idx
  ON pipedrive_writes (pipedrive_resource_type, pipedrive_resource_id);
