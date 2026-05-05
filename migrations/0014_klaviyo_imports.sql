CREATE TABLE klaviyo_imports (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_slack_id          TEXT NOT NULL,
  caller_email             TEXT,
  source                   TEXT NOT NULL CHECK (source IN ('inline','csv')),
  filename                 TEXT,
  storage_path             TEXT,
  list_id                  TEXT,
  list_name                TEXT,
  channels                 TEXT[] NOT NULL,
  total_submitted          INTEGER NOT NULL,
  total_imported           INTEGER NOT NULL DEFAULT 0,
  total_invalid_rejected   INTEGER NOT NULL DEFAULT 0,
  klaviyo_job_id           TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('queued','processing','complete','failed')),
  started_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at             TIMESTAMPTZ,
  succeeded_count          INTEGER,
  already_subscribed_count INTEGER,
  failed_count             INTEGER,
  error_summary            TEXT,
  CONSTRAINT klaviyo_imports_status_terminal_has_completed_at
    CHECK ((status IN ('complete','failed') AND completed_at IS NOT NULL)
        OR (status IN ('queued','processing') AND completed_at IS NULL))
);

CREATE INDEX idx_klaviyo_imports_caller  ON klaviyo_imports(caller_slack_id, started_at DESC);
CREATE INDEX idx_klaviyo_imports_pending ON klaviyo_imports(status) WHERE status IN ('queued','processing');
CREATE INDEX idx_klaviyo_imports_job     ON klaviyo_imports(klaviyo_job_id);
