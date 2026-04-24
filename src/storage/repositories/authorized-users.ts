import type { SupabaseClient } from '@supabase/supabase-js';

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
}
