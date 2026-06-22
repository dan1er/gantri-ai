-- Track when the bot last pinged the requester that a ready backend preview is
-- idle. Used for the hourly "still need this preview? tear it down" reminder
-- (cost control: backend previews run in EKS). NULL until the first ping.
ALTER TABLE devops_jobs ADD COLUMN IF NOT EXISTS idle_pinged_at timestamptz;
