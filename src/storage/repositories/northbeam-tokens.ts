import type { SupabaseClient } from '@supabase/supabase-js';

export interface TokenRow {
  access_token_encrypted: string;
  expires_at: string;
  last_refresh_method: 'ropc' | 'playwright';
}

export class NorthbeamTokensRepo {
  constructor(private readonly client: SupabaseClient) {}

  async get(): Promise<TokenRow | null> {
    const { data, error } = await this.client
      .from('northbeam_tokens')
      .select('access_token_encrypted,expires_at,last_refresh_method')
      .eq('id', 1)
      .maybeSingle();
    if (error) throw new Error(`northbeam_tokens read failed: ${error.message}`);
    return (data as TokenRow | null) ?? null;
  }

  async upsert(row: TokenRow): Promise<void> {
    const { error } = await this.client
      .from('northbeam_tokens')
      .upsert({ id: 1, ...row });
    if (error) throw new Error(`northbeam_tokens upsert failed: ${error.message}`);
  }
}
