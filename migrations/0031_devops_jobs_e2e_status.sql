-- Allow the 'e2e_running' job status (the pre-deploy E2E gate transitions a
-- deploy job through e2e_running before it deploys). The original
-- devops_jobs_status_check did not include it, so the runner's update was
-- rejected and the job stuck in 'pending'.
ALTER TABLE devops_jobs DROP CONSTRAINT IF EXISTS devops_jobs_status_check;
ALTER TABLE devops_jobs ADD CONSTRAINT devops_jobs_status_check
  CHECK (status IN ('pending', 'e2e_running', 'backend_running', 'frontend_running', 'ready', 'failed', 'torn_down'));
