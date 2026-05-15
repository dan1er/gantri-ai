import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GantriPorterConnector } from '../../../../src/connectors/gantri-porter/gantri-porter-connector.js';

// /api/admin/users/by-email returns the same adminUserInfo shape as by-id:
// `account` + `shop.orders`. Below is a minimal stub of just the fields the
// merge tool reads.
function makeByEmailResponse(opts: {
  userId: number;
  email: string;
  klaviyoId?: string | null;
  firstName?: string;
  lastName?: string;
  ordersCount?: number;
}) {
  return {
    account: {
      userId: opts.userId,
      email: opts.email,
      klaviyoId: opts.klaviyoId ?? null,
      firstName: opts.firstName ?? '',
      lastName: opts.lastName ?? '',
    },
    shop: {
      orders: Array.from({ length: opts.ordersCount ?? 0 }, (_, i) => ({ id: 1000 + i, type: 'Order' })),
    },
  };
}

interface Opts {
  callerRole?: 'cx' | 'admin' | 'marketing' | 'user' | null;
  porterFetchImpl?: any;
  envWriteTarget?: 'staging' | 'prod' | undefined;
}

function makeDeps(opts: Opts = {}) {
  const insertedRows: any[] = [];

  const conn = new GantriPorterConnector({
    baseUrl: 'https://stage.api.gantri.com',
    email: 'bot@gantri.com',
    password: 'pw',
    rollupRepo: {} as any,
    writesRepo: {
      insert: vi.fn(async (row: any) => {
        insertedRows.push(row);
        return { id: 'a', ...row, createdAt: 'now' };
      }),
    } as any,
    usersRepo: {
      getRole: vi.fn().mockResolvedValue(opts.callerRole === undefined ? 'cx' : opts.callerRole),
    } as any,
    getActor: vi.fn().mockReturnValue({ slackUserId: 'U_ZUZ' }),
    klaviyoClient: { updateProfileEmail: vi.fn().mockResolvedValue(undefined) } as any,
  });
  // Stub porterFetch — every test passes its own impl so we can assert exactly
  // which Porter endpoints were hit.
  if (opts.porterFetchImpl) {
    (conn as any).porterFetch = opts.porterFetchImpl;
  }
  return { conn, insertedRows };
}

function getTool(conn: GantriPorterConnector) {
  return conn.tools.find((t) => t.name === 'gantri.merge_customer_accounts')!;
}

describe('gantri.merge_customer_accounts', () => {
  beforeEach(() => {
    delete process.env.PORTER_WRITE_TARGET;
  });
  afterEach(() => {
    delete process.env.PORTER_WRITE_TARGET;
  });

  it('cx role + confirm=false → returns preview with correct counts, no Porter write', async () => {
    const porterFetch = vi.fn(async (callOpts: any) => {
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/users/by-email?email=old%40x.com') {
        return makeByEmailResponse({ userId: 100, email: 'old@x.com', firstName: 'Han', lastName: 'Nguyen', ordersCount: 3, klaviyoId: 'OLD_K' });
      }
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/users/by-email?email=new%40x.com') {
        return makeByEmailResponse({ userId: 200, email: 'new@x.com', ordersCount: 0 });
      }
      throw new Error(`unexpected ${callOpts.method} ${callOpts.path}`);
    });
    const { conn, insertedRows } = makeDeps({ porterFetchImpl: porterFetch });
    const r = await getTool(conn).execute({ oldEmail: 'old@x.com', newEmail: 'new@x.com', confirm: false });

    expect((r as any).kind).toBe('awaiting_confirmation');
    expect((r as any).target).toBe('staging');
    expect((r as any).oldUserId).toBe(100);
    expect((r as any).newUserId).toBe(200);
    expect((r as any).oldEmail).toBe('old@x.com');
    expect((r as any).newEmail).toBe('new@x.com');
    expect((r as any).ordersToMove).toBe(3);
    expect((r as any).klaviyoConflict).toBe(false);
    expect((r as any).message).toMatch(/staging mode/);
    expect((r as any).message).toMatch(/Han Nguyen/);
    expect((r as any).message).toMatch(/3 orders/);
    expect(insertedRows).toHaveLength(0);
    // No Porter POST in the preview branch.
    expect(porterFetch.mock.calls.every((c) => c[0].method === 'GET')).toBe(true);
  });

  it('cx role + confirm=true → POSTs /merge, writes audit, returns ok with credits surfaced', async () => {
    const porterFetch = vi.fn(async (callOpts: any) => {
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/users/by-email?email=old%40x.com') {
        return makeByEmailResponse({ userId: 100, email: 'old@x.com', firstName: 'Han', lastName: 'Nguyen', ordersCount: 2 });
      }
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/users/by-email?email=new%40x.com') {
        return makeByEmailResponse({ userId: 200, email: 'new@x.com', ordersCount: 1 });
      }
      if (callOpts.method === 'POST' && callOpts.path === '/api/admin/users/merge') {
        expect(callOpts.body).toEqual({ oldEmail: 'old@x.com', newEmail: 'new@x.com' });
        return {
          success: true,
          oldUserId: 100,
          newUserId: 200,
          ordersMoved: 2,
          creditsMoved: 4,
          userCreditsBalanceMoved: 12.5,
          giftCardCreditsBalanceMoved: 0,
          profileCopied: { firstName: 'Han', lastName: 'Nguyen' },
          oldAccountSoftDeleted: true,
          klaviyoIds: { old: null, new: null },
        };
      }
      throw new Error(`unexpected ${callOpts.method} ${callOpts.path}`);
    });
    const { conn, insertedRows } = makeDeps({ porterFetchImpl: porterFetch });
    const r = await getTool(conn).execute({ oldEmail: 'old@x.com', newEmail: 'new@x.com', confirm: true });

    expect((r as any).ok).toBe(true);
    expect((r as any).target).toBe('staging');
    expect((r as any).oldUserId).toBe(100);
    expect((r as any).newUserId).toBe(200);
    expect((r as any).ordersMoved).toBe(2);
    expect((r as any).creditsMoved).toBe(4);
    expect((r as any).userCreditsBalanceMoved).toBe(12.5);
    expect((r as any).message).toMatch(/2 orders/);
    expect((r as any).message).toMatch(/4 credit ledger rows/);
    expect((r as any).message).toMatch(/\$12\.50 user credits/);

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      callerSlackId: 'U_ZUZ',
      action: 'merge_customer_accounts',
      porterUserId: 200,
      porterOrderId: null,
      klaviyoProfileId: null,
      status: 'success',
      writeTarget: 'staging',
    });
    expect(insertedRows[0].requestPayload).toMatchObject({ oldEmail: 'old@x.com', newEmail: 'new@x.com', oldUserId: 100, newUserId: 200 });
    expect((insertedRows[0].responsePayload as any).ordersMoved).toBe(2);
  });

  it('confirm=false + old user not found → OLD_USER_NOT_FOUND, no audit', async () => {
    const porterFetch = vi.fn(async (callOpts: any) => {
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/users/by-email?email=ghost%40x.com') {
        const err: any = new Error('not found');
        err.status = 404;
        throw err;
      }
      throw new Error(`unexpected ${callOpts.method} ${callOpts.path}`);
    });
    const { conn, insertedRows } = makeDeps({ porterFetchImpl: porterFetch });
    const r = await getTool(conn).execute({ oldEmail: 'ghost@x.com', newEmail: 'new@x.com', confirm: false });
    expect((r as any).error.code).toBe('OLD_USER_NOT_FOUND');
    expect(insertedRows).toHaveLength(0);
  });

  it('confirm=false + new user not found → NEW_USER_NOT_FOUND, no audit', async () => {
    const porterFetch = vi.fn(async (callOpts: any) => {
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/users/by-email?email=old%40x.com') {
        return makeByEmailResponse({ userId: 100, email: 'old@x.com', ordersCount: 1 });
      }
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/users/by-email?email=missing%40x.com') {
        const err: any = new Error('not found');
        err.status = 404;
        throw err;
      }
      throw new Error(`unexpected ${callOpts.method} ${callOpts.path}`);
    });
    const { conn, insertedRows } = makeDeps({ porterFetchImpl: porterFetch });
    const r = await getTool(conn).execute({ oldEmail: 'old@x.com', newEmail: 'missing@x.com', confirm: false });
    expect((r as any).error.code).toBe('NEW_USER_NOT_FOUND');
    expect(insertedRows).toHaveLength(0);
  });

  it('confirm=false + same userId → EMAILS_IDENTICAL', async () => {
    // Both emails resolve to the same Porter user. Could happen if the
    // customer's email got auto-aliased or if the operator typo'd the same
    // address twice. Refuse early — there's nothing to merge.
    const porterFetch = vi.fn(async (callOpts: any) => {
      if (callOpts.method === 'GET' && callOpts.path.startsWith('/api/admin/users/by-email')) {
        return makeByEmailResponse({ userId: 100, email: 'old@x.com', ordersCount: 1 });
      }
      throw new Error(`unexpected ${callOpts.method} ${callOpts.path}`);
    });
    const { conn, insertedRows } = makeDeps({ porterFetchImpl: porterFetch });
    const r = await getTool(conn).execute({ oldEmail: 'old@x.com', newEmail: 'new@x.com', confirm: false });
    expect((r as any).error.code).toBe('EMAILS_IDENTICAL');
    expect(insertedRows).toHaveLength(0);
  });

  it('confirm=true + Porter returns 422 NEW_ALREADY_SOFT_DELETED → typed error, audit failure', async () => {
    const porterFetch = vi.fn(async (callOpts: any) => {
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/users/by-email?email=old%40x.com') {
        return makeByEmailResponse({ userId: 100, email: 'old@x.com', ordersCount: 1 });
      }
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/users/by-email?email=new%40x.com') {
        return makeByEmailResponse({ userId: 200, email: 'new@x.com', ordersCount: 0 });
      }
      if (callOpts.method === 'POST' && callOpts.path === '/api/admin/users/merge') {
        const err: any = new Error('soft deleted');
        err.status = 422;
        err.body = { code: 'NEW_ALREADY_SOFT_DELETED', message: 'New user is already soft-deleted.' };
        throw err;
      }
      throw new Error(`unexpected ${callOpts.method} ${callOpts.path}`);
    });
    const { conn, insertedRows } = makeDeps({ porterFetchImpl: porterFetch });
    const r = await getTool(conn).execute({ oldEmail: 'old@x.com', newEmail: 'new@x.com', confirm: true });
    expect((r as any).error.code).toBe('NEW_ALREADY_SOFT_DELETED');
    expect((r as any).error.status).toBe(422);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].status).toBe('failure');
    expect(insertedRows[0].action).toBe('merge_customer_accounts');
  });

  it('confirm=true + Porter 5xx → PORTER_ERROR, audit failure', async () => {
    const porterFetch = vi.fn(async (callOpts: any) => {
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/users/by-email?email=old%40x.com') {
        return makeByEmailResponse({ userId: 100, email: 'old@x.com', ordersCount: 1 });
      }
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/users/by-email?email=new%40x.com') {
        return makeByEmailResponse({ userId: 200, email: 'new@x.com', ordersCount: 0 });
      }
      if (callOpts.method === 'POST' && callOpts.path === '/api/admin/users/merge') {
        const err: any = new Error('boom');
        err.status = 500;
        err.body = 'Internal server error';
        throw err;
      }
      throw new Error(`unexpected ${callOpts.method} ${callOpts.path}`);
    });
    const { conn, insertedRows } = makeDeps({ porterFetchImpl: porterFetch });
    const r = await getTool(conn).execute({ oldEmail: 'old@x.com', newEmail: 'new@x.com', confirm: true });
    expect((r as any).error.code).toBe('PORTER_ERROR');
    expect((r as any).error.status).toBe(500);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].status).toBe('failure');
  });

  it('FORBIDDEN for role=marketing → no Porter call, no audit', async () => {
    const porterFetch = vi.fn(async () => {
      throw new Error('Porter should never be called for FORBIDDEN');
    });
    const { conn, insertedRows } = makeDeps({ callerRole: 'marketing', porterFetchImpl: porterFetch });
    const r = await getTool(conn).execute({ oldEmail: 'old@x.com', newEmail: 'new@x.com', confirm: true });
    expect((r as any).error.code).toBe('FORBIDDEN');
    expect(insertedRows).toHaveLength(0);
    expect(porterFetch).not.toHaveBeenCalled();
  });

  it('FORBIDDEN for role=user → no Porter call, no audit', async () => {
    const porterFetch = vi.fn(async () => {
      throw new Error('Porter should never be called for FORBIDDEN');
    });
    const { conn, insertedRows } = makeDeps({ callerRole: 'user', porterFetchImpl: porterFetch });
    const r = await getTool(conn).execute({ oldEmail: 'old@x.com', newEmail: 'new@x.com', confirm: false });
    expect((r as any).error.code).toBe('FORBIDDEN');
    expect(insertedRows).toHaveLength(0);
    expect(porterFetch).not.toHaveBeenCalled();
  });

  it('admin role also allowed', async () => {
    const porterFetch = vi.fn(async (callOpts: any) => {
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/users/by-email?email=old%40x.com') {
        return makeByEmailResponse({ userId: 100, email: 'old@x.com', ordersCount: 1 });
      }
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/users/by-email?email=new%40x.com') {
        return makeByEmailResponse({ userId: 200, email: 'new@x.com', ordersCount: 0 });
      }
      throw new Error(`unexpected ${callOpts.method} ${callOpts.path}`);
    });
    const { conn } = makeDeps({ callerRole: 'admin', porterFetchImpl: porterFetch });
    const r = await getTool(conn).execute({ oldEmail: 'old@x.com', newEmail: 'new@x.com', confirm: false });
    expect((r as any).kind).toBe('awaiting_confirmation');
  });

  it('both users have klaviyoId → preview includes Klaviyo conflict warning', async () => {
    const porterFetch = vi.fn(async (callOpts: any) => {
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/users/by-email?email=old%40x.com') {
        return makeByEmailResponse({ userId: 100, email: 'old@x.com', ordersCount: 1, klaviyoId: 'K_OLD' });
      }
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/users/by-email?email=new%40x.com') {
        return makeByEmailResponse({ userId: 200, email: 'new@x.com', ordersCount: 0, klaviyoId: 'K_NEW' });
      }
      throw new Error(`unexpected ${callOpts.method} ${callOpts.path}`);
    });
    const { conn } = makeDeps({ porterFetchImpl: porterFetch });
    const r = await getTool(conn).execute({ oldEmail: 'old@x.com', newEmail: 'new@x.com', confirm: false });
    expect((r as any).klaviyoConflict).toBe(true);
    expect((r as any).message).toMatch(/Klaviyo merge is NOT done/);
    expect((r as any).message).toMatch(/K_OLD/);
    expect((r as any).message).toMatch(/K_NEW/);
  });

  it('PORTER_WRITE_TARGET=prod → target=prod and (PROD MODE) prefix', async () => {
    process.env.PORTER_WRITE_TARGET = 'prod';
    const porterFetch = vi.fn(async (callOpts: any) => {
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/users/by-email?email=old%40x.com') {
        return makeByEmailResponse({ userId: 100, email: 'old@x.com', ordersCount: 1 });
      }
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/users/by-email?email=new%40x.com') {
        return makeByEmailResponse({ userId: 200, email: 'new@x.com', ordersCount: 0 });
      }
      throw new Error(`unexpected ${callOpts.method} ${callOpts.path}`);
    });
    const { conn } = makeDeps({ porterFetchImpl: porterFetch });
    const r = await getTool(conn).execute({ oldEmail: 'old@x.com', newEmail: 'new@x.com', confirm: false });
    expect((r as any).target).toBe('prod');
    expect((r as any).message).toMatch(/PROD MODE/);
  });

  it('PORTER_WRITE_TARGET=staging (default) → target=staging and (staging mode) prefix', async () => {
    // No env var set — connector defaults to staging.
    const porterFetch = vi.fn(async (callOpts: any) => {
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/users/by-email?email=old%40x.com') {
        return makeByEmailResponse({ userId: 100, email: 'old@x.com', ordersCount: 1 });
      }
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/users/by-email?email=new%40x.com') {
        return makeByEmailResponse({ userId: 200, email: 'new@x.com', ordersCount: 0 });
      }
      throw new Error(`unexpected ${callOpts.method} ${callOpts.path}`);
    });
    const { conn } = makeDeps({ porterFetchImpl: porterFetch });
    const r = await getTool(conn).execute({ oldEmail: 'old@x.com', newEmail: 'new@x.com', confirm: false });
    expect((r as any).target).toBe('staging');
    expect((r as any).message).toMatch(/staging mode/);
  });

  it('schema rejects invalid emails', () => {
    const { conn } = makeDeps();
    const tool = getTool(conn);
    expect(() => tool.schema.parse({ oldEmail: 'not-an-email', newEmail: 'x@y.com' })).toThrow();
    expect(() => tool.schema.parse({ oldEmail: 'x@y.com', newEmail: 'not-an-email' })).toThrow();
  });

  it('schema defaults confirm to false', () => {
    const { conn } = makeDeps();
    const tool = getTool(conn);
    const parsed = tool.schema.parse({ oldEmail: 'a@x.com', newEmail: 'b@x.com' });
    expect((parsed as any).confirm).toBe(false);
  });
});
