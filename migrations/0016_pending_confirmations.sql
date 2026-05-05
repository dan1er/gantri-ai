CREATE TABLE pending_confirmations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  confirmation_token  UUID NOT NULL UNIQUE,
  caller_slack_id     TEXT NOT NULL,
  channel_id          TEXT NOT NULL,
  thread_ts           TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('klaviyo_import','klaviyo_delete')),
  payload             JSONB NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 minutes')
);

CREATE INDEX idx_pending_confirmations_lookup
  ON pending_confirmations(caller_slack_id, channel_id, thread_ts);
CREATE INDEX idx_pending_confirmations_expiry
  ON pending_confirmations(expires_at);
