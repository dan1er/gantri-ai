-- One row per dev-ops job (preview/deploy) triggered from Slack.
CREATE TABLE IF NOT EXISTS devops_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('preview', 'deploy')),
  target text NOT NULL CHECK (target IN ('backend', 'frontend', 'fullstack')),
  status text NOT NULL CHECK (status IN (
    'pending', 'backend_running', 'frontend_running', 'ready', 'failed', 'torn_down'
  )),
  spec jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by text NOT NULL,
  channel_id text NOT NULL,
  message_ts text,
  run_id bigint,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The poller scans non-terminal jobs.
CREATE INDEX IF NOT EXISTS devops_jobs_active_idx
  ON devops_jobs (status, updated_at)
  WHERE status NOT IN ('ready', 'failed', 'torn_down');
