-- 0011_feedback_relax_reporter_fk.sql
-- Drops the FK on feedback_reports.reporter_slack_user_id so the column can
-- accept non-Slack reporters (e.g. web viewers from Live Reports who fill the
-- "Report a wrong number" form). The column is still NOT NULL — Slack-thread
-- feedback continues to use real Slack user IDs; web feedback uses prefixed
-- sentinels like 'web:anonymous' or 'web:@handle'.
--
-- Why drop instead of widen: Slack user IDs and web handles share no
-- namespace; pretending they do (by adding fake authorized_users rows) would
-- pollute that table. The FK was guarding against a specific class of typos
-- that no longer matters now that the bot writes the column directly.

alter table feedback_reports
  drop constraint if exists feedback_reports_reporter_slack_user_id_fkey;
