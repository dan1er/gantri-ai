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
