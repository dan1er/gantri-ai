-- One row per Gantri-customer write triggered from the bot. Mirrors the
-- pipedrive_writes pattern. The "who" (Slack caller) lives only here —
-- Porter's own audit will see "user changed own email" because we use
-- impersonation. write_target is recorded per row so a forensic look at
-- this table tells you which environment (staging or prod) the write hit.

CREATE TABLE IF NOT EXISTS gantri_writes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_slack_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('update_customer_email')),
  porter_user_id integer,
  porter_order_id integer,
  klaviyo_profile_id text,
  request_payload jsonb NOT NULL,
  response_payload jsonb,
  status text NOT NULL CHECK (status IN ('success', 'partial', 'failure')),
  write_target text NOT NULL CHECK (write_target IN ('staging', 'prod')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gantri_writes_caller_idx
  ON gantri_writes (caller_slack_id, created_at DESC);
CREATE INDEX IF NOT EXISTS gantri_writes_target_idx
  ON gantri_writes (porter_user_id, porter_order_id);
