import type { SupabaseClient } from '@supabase/supabase-js';

export interface AuthorizedUser {
  slackUserId: string;
  slackWorkspaceId: string | null;
  email: string | null;
  role: string | null;
}

export class AuthorizedUsersRepo {
  constructor(private readonly client: SupabaseClient) {}

  async isAuthorized(slackUserId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from('authorized_users')
      .select('slack_user_id')
      .eq('slack_user_id', slackUserId)
      .maybeSingle();
    if (error) throw new Error(`authorized_users read failed: ${error.message}`);
    return !!data;
  }

  async getRole(slackUserId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from('authorized_users')
      .select('role')
      .eq('slack_user_id', slackUserId)
      .maybeSingle();
    if (error) throw new Error(`authorized_users read failed: ${error.message}`);
    return data?.role ?? null;
  }

  async listAll(): Promise<AuthorizedUser[]> {
    const { data, error } = await this.client
      .from('authorized_users')
      .select('slack_user_id, slack_workspace_id, email, role')
      .order('created_at', { ascending: true });
    if (error) throw new Error(`authorized_users list failed: ${error.message}`);
    return (data ?? []).map((r) => ({
      slackUserId: r.slack_user_id as string,
      slackWorkspaceId: (r.slack_workspace_id as string | null) ?? null,
      email: (r.email as string | null) ?? null,
      role: (r.role as string | null) ?? null,
    }));
  }
}
