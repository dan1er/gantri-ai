import { describe, it, expect, vi } from 'vitest';
import { AuthorizedUsersRepo } from '../../../src/storage/repositories/authorized-users.js';
import { ConversationsRepo } from '../../../src/storage/repositories/conversations.js';
import { NorthbeamTokensRepo } from '../../../src/storage/repositories/northbeam-tokens.js';

function clientWithTable(handlers: Record<string, any>) {
  return {
    from(table: string) {
      return handlers[table] ?? {};
    },
  } as any;
}

describe('AuthorizedUsersRepo', () => {
  it('isAuthorized returns true when the user exists', async () => {
    const client = clientWithTable({
      authorized_users: {
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: { slack_user_id: 'U1' }, error: null }) }),
        }),
      },
    });
    const repo = new AuthorizedUsersRepo(client);
    expect(await repo.isAuthorized('U1')).toBe(true);
  });

  it('isAuthorized returns false when no row is found', async () => {
    const client = clientWithTable({
      authorized_users: {
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
        }),
      },
    });
    const repo = new AuthorizedUsersRepo(client);
    expect(await repo.isAuthorized('U_unknown')).toBe(false);
  });

  describe('updateRole', () => {
    it('returns null when target user does not exist', async () => {
      const update = vi.fn();
      const client = clientWithTable({
        authorized_users: {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
          }),
          update,
        },
      });
      const repo = new AuthorizedUsersRepo(client);
      const r = await repo.updateRole('U_MISSING', 'marketing');
      expect(r).toBeNull();
      // No update should be issued when the user doesn't exist.
      expect(update).not.toHaveBeenCalled();
    });

    it('returns previous role and updates row when user exists', async () => {
      const update = vi.fn().mockReturnValue({
        eq: () => Promise.resolve({ data: null, error: null }),
      });
      const client = clientWithTable({
        authorized_users: {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: { role: 'user' }, error: null }) }),
          }),
          update,
        },
      });
      const repo = new AuthorizedUsersRepo(client);
      const r = await repo.updateRole('U1', 'marketing');
      expect(r).toEqual({ previousRole: 'user' });
      expect(update).toHaveBeenCalledWith({ role: 'marketing' });
    });

    it('throws when update returns a Supabase error', async () => {
      const update = vi.fn().mockReturnValue({
        eq: () => Promise.resolve({ data: null, error: { message: 'permission denied' } }),
      });
      const client = clientWithTable({
        authorized_users: {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: { role: 'user' }, error: null }) }),
          }),
          update,
        },
      });
      const repo = new AuthorizedUsersRepo(client);
      await expect(repo.updateRole('U1', 'admin')).rejects.toThrow(/permission denied/);
    });
  });

  describe('upsertUser', () => {
    it('persists `name` when provided and returns it on the user object', async () => {
      const upsert = vi.fn().mockReturnValue({
        select: () => ({
          single: () => Promise.resolve({
            data: {
              slack_user_id: 'U1',
              slack_workspace_id: null,
              email: 'lana@gantri.com',
              role: 'user',
              name: 'Lana',
              created_at: '2026-05-08T00:00:00.000Z',
            },
            error: null,
          }),
        }),
      });
      const client = clientWithTable({
        authorized_users: {
          // existence probe → no existing row
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
          }),
          upsert,
        },
      });
      const repo = new AuthorizedUsersRepo(client);
      const result = await repo.upsertUser({
        slackUserId: 'U1',
        email: 'lana@gantri.com',
        role: 'user',
        name: 'Lana',
      });
      expect(result.created).toBe(true);
      expect(result.user.name).toBe('Lana');
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({ slack_user_id: 'U1', name: 'Lana', email: 'lana@gantri.com', role: 'user' }),
        expect.objectContaining({ onConflict: 'slack_user_id' }),
      );
    });

    it('omits `name` from the upsert payload when caller does not pass it', async () => {
      const upsert = vi.fn().mockReturnValue({
        select: () => ({
          single: () => Promise.resolve({
            data: {
              slack_user_id: 'U1',
              slack_workspace_id: null,
              email: null,
              role: 'user',
              name: null,
              created_at: '2026-05-08T00:00:00.000Z',
            },
            error: null,
          }),
        }),
      });
      const client = clientWithTable({
        authorized_users: {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
          }),
          upsert,
        },
      });
      const repo = new AuthorizedUsersRepo(client);
      await repo.upsertUser({ slackUserId: 'U1', role: 'user' });
      const payload = upsert.mock.calls[0][0];
      expect('name' in payload).toBe(false);
    });
  });
});

describe('ConversationsRepo', () => {
  it('insert stores the row and returns its id', async () => {
    const insert = vi.fn().mockReturnValue({
      select: () => ({ single: () => Promise.resolve({ data: { id: 'uuid-1' }, error: null }) }),
    });
    const client = clientWithTable({ conversations: { insert } });
    const repo = new ConversationsRepo(client);
    const id = await repo.insert({
      slack_thread_ts: 'ts', slack_channel_id: 'C', slack_user_id: 'U', question: 'q',
    });
    expect(id).toBe('uuid-1');
    expect(insert).toHaveBeenCalled();
  });
});

describe('NorthbeamTokensRepo', () => {
  it('get returns null when no token row exists', async () => {
    const client = clientWithTable({
      northbeam_tokens: {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
      },
    });
    const repo = new NorthbeamTokensRepo(client);
    expect(await repo.get()).toBeNull();
  });

  it('upsert writes the singleton row', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const client = clientWithTable({ northbeam_tokens: { upsert } });
    const repo = new NorthbeamTokensRepo(client);
    await repo.upsert({
      access_token: 'abc',
      expires_at: new Date().toISOString(),
      last_refresh_method: 'ropc',
    });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 1, access_token: 'abc' }));
  });
});
