-- Add a `name` column to authorized_users so we can render and address users
-- by their human-readable Slack name. We persist the value at add_user time
-- (display_name -> real_name precedence) instead of looking it up on every
-- read. Nullable: legacy rows backfill via scripts/backfill-authorized-users-names.mjs.
ALTER TABLE authorized_users ADD COLUMN name text;
