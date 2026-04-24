import { describe, it, expect, vi } from 'vitest';
import { readVaultSecret } from '../../../src/storage/supabase.js';

describe('readVaultSecret', () => {
  it('returns decrypted_secret from vault.decrypted_secrets', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'danny@gantri.com', error: null });
    const fakeClient: any = { rpc };
    const value = await readVaultSecret(fakeClient, 'NORTHBEAM_EMAIL');
    expect(value).toBe('danny@gantri.com');
    expect(rpc).toHaveBeenCalledWith('read_vault_secret', { secret_name: 'NORTHBEAM_EMAIL' });
  });

  it('throws when vault call errors', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'nope' } });
    const fakeClient: any = { rpc };
    await expect(readVaultSecret(fakeClient, 'NORTHBEAM_EMAIL')).rejects.toThrow(/nope/);
  });

  it('throws when secret does not exist', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const fakeClient: any = { rpc };
    await expect(readVaultSecret(fakeClient, 'MISSING')).rejects.toThrow(/MISSING/);
  });
});
