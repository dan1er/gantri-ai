CREATE TABLE klaviyo_deletions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_slack_id     TEXT NOT NULL,
  caller_email        TEXT,
  requested_emails    JSONB NOT NULL,
  found_count         INTEGER NOT NULL,
  deleted_count       INTEGER NOT NULL,
  failed_count        INTEGER NOT NULL,
  failed_details      JSONB NOT NULL DEFAULT '[]',
  status              TEXT NOT NULL CHECK (status IN ('submitted')),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_klaviyo_deletions_caller ON klaviyo_deletions(caller_slack_id, started_at DESC);
