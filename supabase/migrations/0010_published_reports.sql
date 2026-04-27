-- 0010_published_reports.sql
-- Live Reports persisted spec + history.

CREATE TABLE IF NOT EXISTS published_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  title           text NOT NULL,
  description     text,
  spec            jsonb NOT NULL,
  spec_version    int NOT NULL DEFAULT 1,
  owner_slack_id  text NOT NULL,
  intent          text NOT NULL,
  intent_keywords text[] NOT NULL DEFAULT '{}',
  access_token    text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  last_visited_at timestamptz,
  visit_count     int NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS published_reports_owner_idx ON published_reports(owner_slack_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS published_reports_keywords_idx ON published_reports USING gin(intent_keywords);

CREATE TABLE IF NOT EXISTS published_reports_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id       uuid NOT NULL REFERENCES published_reports(id) ON DELETE CASCADE,
  spec            jsonb NOT NULL,
  spec_version    int NOT NULL,
  intent          text NOT NULL,
  replaced_by_slack_id text NOT NULL,
  replaced_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS published_reports_history_report_idx ON published_reports_history(report_id, replaced_at DESC);
