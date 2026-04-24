import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadEnv } from '../config/env.js';

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;
  const env = loadEnv();
  _client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  return _client;
}

/**
 * Reads a secret from Supabase Vault.
 * Requires a SECURITY DEFINER helper `read_vault_secret(secret_name text)` in the DB.
 */
export async function readVaultSecret(
  client: SupabaseClient,
  name: string,
): Promise<string> {
  const { data, error } = await client.rpc('read_vault_secret', { secret_name: name });
  if (error) throw new Error(`Vault read failed for ${name}: ${error.message}`);
  if (!data) throw new Error(`Vault secret ${name} not found`);
  return data as string;
}
