-- Extend authorized_users.role to allow 'marketing' alongside 'admin'/'user'.
-- Existing rows are unchanged. Marketing role gates Klaviyo write tools but NOT
-- bot.broadcast_notification or bot.add_user / bot.update_user_role.
ALTER TABLE authorized_users DROP CONSTRAINT IF EXISTS authorized_users_role_check;
ALTER TABLE authorized_users ADD CONSTRAINT authorized_users_role_check
  CHECK (role IN ('admin', 'marketing', 'user'));
