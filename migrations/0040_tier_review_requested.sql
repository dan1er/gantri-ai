-- Delivery Tier Code-Review Slack request dedupe.
--
-- When the Code-Review authoritative pass first classifies a task (confirm,
-- supersede, or the no-PR description fallback) it posts a code-review request to
-- the software Slack channel so reviewers get pinged with context.
-- `review_requested` makes that ping fire at most once per task: it is set only
-- after a SUCCESSFUL post, so a failed post retries on the next check and later
-- pushes / re-checks never re-ping. `upsertBot` never writes this column, so its
-- upsert preserves the flag across re-classifications.
alter table tier_classifications
  add column if not exists review_requested boolean not null default false;
