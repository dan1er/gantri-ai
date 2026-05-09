import type { SupabaseClient } from '@supabase/supabase-js';

export interface AuthorizedUser {
  slackUserId: string;
  slackWorkspaceId: string | null;
  email: string | null;
  role: string | null;
  name: string | null;
  createdAt: string | null;
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
      .select('slack_user_id, slack_workspace_id, email, role, name, created_at')
      .order('created_at', { ascending: true });
    if (error) throw new Error(`authorized_users list failed: ${error.message}`);
    return (data ?? []).map((r) => ({
      slackUserId: r.slack_user_id as string,
      slackWorkspaceId: (r.slack_workspace_id as string | null) ?? null,
      email: (r.email as string | null) ?? null,
      role: (r.role as string | null) ?? null,
      name: (r.name as string | null) ?? null,
      createdAt: (r.created_at as string | null) ?? null,
    }));
  }

  /**
   * Idempotent insert / update: upsert a user keyed by slack_user_id. Returns
   * `created` true when this call inserted a new row, false when the row was
   * already present (and was updated with any changed fields).
   */
  /**
   * Update an existing user's role in-place. Returns `{ previousRole }` on
   * success, or `null` if no row matches `slackUserId` (caller should fall back
   * to `bot.add_user` to enable an unknown user). Distinct from `upsertUser` so
   * callers who only want to change a role don't have to re-supply email etc.
   */
  async updateRole(
    slackUserId: string,
    role: 'admin' | 'marketing' | 'user',
  ): Promise<{ previousRole: string | null } | null> {
    const prev = await this.client
      .from('authorized_users')
      .select('role')
      .eq('slack_user_id', slackUserId)
      .maybeSingle();
    if (prev.error) throw new Error(`authorized_users read failed: ${prev.error.message}`);
    if (!prev.data) return null;
    const { error } = await this.client
      .from('authorized_users')
      .update({ role })
      .eq('slack_user_id', slackUserId);
    if (error) throw new Error(`authorized_users update failed: ${error.message}`);
    return { previousRole: ((prev.data as { role?: string | null }).role) ?? null };
  }

  async upsertUser(input: {
    slackUserId: string;
    slackWorkspaceId?: string | null;
    email?: string | null;
    role?: string | null;
    name?: string | null;
  }): Promise<{ created: boolean; user: AuthorizedUser }> {
    const existing = await this.client
      .from('authorized_users')
      .select('slack_user_id')
      .eq('slack_user_id', input.slackUserId)
      .maybeSingle();
    if (existing.error) throw new Error(`authorized_users probe failed: ${existing.error.message}`);
    const created = !existing.data;
    const row: Record<string, unknown> = { slack_user_id: input.slackUserId };
    if (input.slackWorkspaceId !== undefined) row.slack_workspace_id = input.slackWorkspaceId;
    if (input.email !== undefined) row.email = input.email;
    if (input.role !== undefined) row.role = input.role;
    if (input.name !== undefined) row.name = input.name;
    const { data, error } = await this.client
      .from('authorized_users')
      .upsert(row, { onConflict: 'slack_user_id' })
      .select('slack_user_id, slack_workspace_id, email, role, name, created_at')
      .single();
    if (error) throw new Error(`authorized_users upsert failed: ${error.message}`);
    return {
      created,
      user: {
        slackUserId: data.slack_user_id as string,
        slackWorkspaceId: (data.slack_workspace_id as string | null) ?? null,
        email: (data.email as string | null) ?? null,
        role: (data.role as string | null) ?? null,
        name: (data.name as string | null) ?? null,
        createdAt: (data.created_at as string | null) ?? null,
      },
    };
  }
}
