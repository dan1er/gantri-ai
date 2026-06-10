-- Allow the 'e2e' job kind (the /e2e Slack command runs the gantri-e2e suite
-- on demand) and its 'suite' target. Existing checks only covered
-- preview/deploy jobs.
ALTER TABLE devops_jobs DROP CONSTRAINT IF EXISTS devops_jobs_kind_check;
ALTER TABLE devops_jobs ADD CONSTRAINT devops_jobs_kind_check
  CHECK (kind IN ('preview', 'deploy', 'e2e'));
ALTER TABLE devops_jobs DROP CONSTRAINT IF EXISTS devops_jobs_target_check;
ALTER TABLE devops_jobs ADD CONSTRAINT devops_jobs_target_check
  CHECK (target IN ('backend', 'frontend', 'fullstack', 'suite'));
