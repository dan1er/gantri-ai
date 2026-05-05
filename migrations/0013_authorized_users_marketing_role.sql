-- Extend authorized_users.role to allow 'marketing' alongside 'admin'/'user'.
-- Existing rows are unchanged. Marketing role gates Klaviyo write tools but NOT
-- bot.broadcast_notification or bot.add_user / bot.update_user_role.
alter table authorized_users drop constraint if exists authorized_users_role_check;
alter table authorized_users add constraint authorized_users_role_check
  check (role in ('admin', 'marketing', 'user'));
