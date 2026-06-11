-- Allow the 'cron' job kind (the /cron Slack command triggers a porter k8s
-- CronJob on staging or production) and its 'cron' target.
ALTER TABLE devops_jobs DROP CONSTRAINT IF EXISTS devops_jobs_kind_check;
ALTER TABLE devops_jobs ADD CONSTRAINT devops_jobs_kind_check
  CHECK (kind IN ('preview', 'deploy', 'e2e', 'cron'));
ALTER TABLE devops_jobs DROP CONSTRAINT IF EXISTS devops_jobs_target_check;
ALTER TABLE devops_jobs ADD CONSTRAINT devops_jobs_target_check
  CHECK (target IN ('backend', 'frontend', 'fullstack', 'suite', 'cron'));
