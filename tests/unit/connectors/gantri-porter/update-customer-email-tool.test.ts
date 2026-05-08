import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GantriPorterConnector } from '../../../../src/connectors/gantri-porter/gantri-porter-connector.js';

function makeOrderResponse(overrides: any = {}) {
  return {
    order: {
      id: 43785,
      type: 'Order',
      status: 'Delivered',
      email: 'xavi@example.com',
      firstName: 'Xavi',
      lastName: 'Ocana',
      user: {
        id: 59516,
        klaviyoId: '01JHPN57KPZFTJVN8D4D2WVK2H',
        authToken: 'customer-jwt-token',
      },
      ...overrides,
    },
  };
}

function makePaginatedTransactionsResponse(count: number) {
  return {
    transactions: Array.from({ length: count }, (_, i) => ({ id: 1000 + i, type: 'Order' })),
    allOrders: count,
  };
}

interface Opts {
  callerRole?: 'cx' | 'admin' | 'marketing' | 'user' | null;
  porterFetchImpl?: any;
  klaviyoUpdate?: any;
  envWriteTarget?: 'staging' | 'prod' | undefined;
}

function makeDeps(opts: Opts = {}) {
  const insertedRows: any[] = [];
  // Default porterFetch sequence:
  //   GET order (preview): returns order data
  //   POST paginated-transactions (preview): count of user's orders
  //   GET order (execute, defensive re-fetch)
  //   GET /api/user (impersonation, fetch firstName/lastName)
  //   PUT /api/user (impersonation, the email change)
  let porterCallCount = 0;
  const defaultPorterFetch = vi.fn(async (callOpts: any) => {
    porterCallCount += 1;
    const { method, path } = callOpts;
    if (method === 'GET' && path === '/api/admin/transactions/43785') {
      return makeOrderResponse();
    }
    if (method === 'POST' && path === '/api/admin/paginated-transactions') {
      return makePaginatedTransactionsResponse(3);
    }
    if (method === 'GET' && path === '/api/user') {
      return { data: { id: 59516, email: 'xavi@example.com', firstName: 'Xavi', lastName: 'Ocana' } };
    }
    if (method === 'PUT' && path === '/api/user') {
      return { success: true, data: { id: 59516, email: callOpts.body?.email } };
    }
    throw new Error(`Unexpected porterFetch call #${porterCallCount}: ${method} ${path}`);
  });

  const conn = new GantriPorterConnector({
    baseUrl: 'https://api.gantri.com',
    email: 'bot@gantri.com',
    password: 'pw',
    rollupRepo: { /* unused in these tests */ } as any,
    writesRepo: {
      insert: vi.fn(async (row: any) => { insertedRows.push(row); return { id: 'a', ...row, createdAt: 'now' }; }),
    } as any,
    usersRepo: {
      getRole: vi.fn().mockResolvedValue(opts.callerRole === undefined ? 'cx' : opts.callerRole),
    } as any,
    getActor: vi.fn().mockReturnValue({ slackUserId: 'U_ZUZ' }),
    klaviyoClient: {
      updateProfileEmail: opts.klaviyoUpdate ?? vi.fn().mockResolvedValue(undefined),
    } as any,
  });
  // Replace porterFetch with a spy
  (conn as any).porterFetch = opts.porterFetchImpl ?? defaultPorterFetch;
  return { conn, insertedRows };
}

function getTool(conn: GantriPorterConnector) {
  return conn.tools.find((t) => t.name === 'gantri.update_customer_email')!;
}

describe('gantri.update_customer_email', () => {
  beforeEach(() => {
    delete process.env.PORTER_WRITE_TARGET;
  });
  afterEach(() => {
    delete process.env.PORTER_WRITE_TARGET;
  });

  it('cx role + confirm=false → returns preview, makes NO destructive calls', async () => {
    const { conn, insertedRows } = makeDeps();
    const r = await getTool(conn).execute({
      orderId: 43785,
      newEmail: 'danavoniel@gmail.com',
      confirm: false,
    });
    expect((r as any).kind).toBe('awaiting_confirmation');
    expect((r as any).orderId).toBe(43785);
    expect((r as any).userId).toBe(59516);
    expect((r as any).currentEmail).toBe('xavi@example.com');
    expect((r as any).newEmail).toBe('danavoniel@gmail.com');
    expect((r as any).customerName).toBe('Xavi Ocana');
    expect((r as any).klaviyoProfileLinked).toBe(true);
    expect((r as any).willSyncKlaviyo).toBe(true);
    expect((r as any).target).toBe('staging');
    expect(insertedRows).toHaveLength(0);
  });

  it('cx role + confirm=true + happy path → updates Porter + Klaviyo + audit success', async () => {
    const { conn, insertedRows } = makeDeps();
    const r = await getTool(conn).execute({
      orderId: 43785,
      newEmail: 'danavoniel@gmail.com',
      syncKlaviyo: true,
      confirm: true,
    });
    expect((r as any).ok).toBe(true);
    expect((r as any).porterOk).toBe(true);
    expect((r as any).klaviyoOk).toBe(true);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      callerSlackId: 'U_ZUZ',
      action: 'update_customer_email',
      porterUserId: 59516,
      porterOrderId: 43785,
      klaviyoProfileId: '01JHPN57KPZFTJVN8D4D2WVK2H',
      status: 'success',
      writeTarget: 'staging',
    });
  });

  it('confirm=true + Klaviyo fails → audit partial, klaviyoError surfaced', async () => {
    const { conn, insertedRows } = makeDeps({
      klaviyoUpdate: vi.fn().mockRejectedValue(new Error('klaviyo timeout')),
    });
    const r = await getTool(conn).execute({
      orderId: 43785,
      newEmail: 'danavoniel@gmail.com',
      syncKlaviyo: true,
      confirm: true,
    });
    expect((r as any).porterOk).toBe(true);
    expect((r as any).klaviyoOk).toBe(false);
    expect((r as any).klaviyoError).toMatch(/klaviyo timeout/);
    expect(insertedRows[0].status).toBe('partial');
  });

  it('confirm=true + syncKlaviyo:false → skips Klaviyo entirely, status=success', async () => {
    const { conn, insertedRows } = makeDeps();
    const r = await getTool(conn).execute({
      orderId: 43785,
      newEmail: 'danavoniel@gmail.com',
      syncKlaviyo: false,
      confirm: true,
    });
    expect((r as any).porterOk).toBe(true);
    expect((r as any).klaviyoOk).toBe(false);
    expect((r as any).klaviyoError).toBeUndefined();
    expect(insertedRows[0].status).toBe('success');
    expect(insertedRows[0].klaviyoProfileId).toBeNull();
  });

  it('confirm=true + user has no klaviyoId → skips Klaviyo, status=success', async () => {
    const customFetch = vi.fn(async (callOpts: any) => {
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/transactions/43785') {
        return makeOrderResponse({ user: { id: 59516, klaviyoId: null, authToken: 'tok' } });
      }
      if (callOpts.method === 'GET' && callOpts.path === '/api/user') {
        return { data: { firstName: 'Xavi', lastName: 'Ocana' } };
      }
      if (callOpts.method === 'PUT' && callOpts.path === '/api/user') {
        return { success: true };
      }
      if (callOpts.method === 'POST') {
        return makePaginatedTransactionsResponse(1);
      }
      throw new Error(`unexpected ${callOpts.method} ${callOpts.path}`);
    });
    const { conn, insertedRows } = makeDeps({ porterFetchImpl: customFetch });
    const r = await getTool(conn).execute({
      orderId: 43785,
      newEmail: 'x@y.com',
      syncKlaviyo: true,
      confirm: true,
    });
    expect((r as any).porterOk).toBe(true);
    expect(insertedRows[0].status).toBe('success');
    expect(insertedRows[0].klaviyoProfileId).toBeNull();
  });

  it('order not found → ORDER_NOT_FOUND, no audit row', async () => {
    const customFetch = vi.fn(async (callOpts: any) => {
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/transactions/99999') {
        const err: any = new Error('not found'); err.status = 404; throw err;
      }
      throw new Error('unexpected');
    });
    const { conn, insertedRows } = makeDeps({ porterFetchImpl: customFetch });
    const r = await getTool(conn).execute({ orderId: 99999, newEmail: 'x@y.com', confirm: false });
    expect((r as any).error.code).toBe('ORDER_NOT_FOUND');
    expect(insertedRows).toHaveLength(0);
  });

  it('Porter PUT 422 (email taken) → audit failure, error code surfaced', async () => {
    const customFetch = vi.fn(async (callOpts: any) => {
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/transactions/43785') {
        return makeOrderResponse();
      }
      if (callOpts.method === 'GET' && callOpts.path === '/api/user') {
        return { data: { firstName: 'Xavi', lastName: 'Ocana' } };
      }
      if (callOpts.method === 'PUT' && callOpts.path === '/api/user') {
        const err: any = new Error('email taken');
        err.status = 422;
        err.body = { error: 'The email already belongs to another account.' };
        throw err;
      }
      if (callOpts.method === 'POST') return makePaginatedTransactionsResponse(1);
      throw new Error('unexpected');
    });
    const { conn, insertedRows } = makeDeps({ porterFetchImpl: customFetch });
    const r = await getTool(conn).execute({ orderId: 43785, newEmail: 'taken@x.com', confirm: true });
    expect((r as any).error.code).toBe('PORTER_ERROR');
    expect((r as any).error.status).toBe(422);
    expect(insertedRows[0].status).toBe('failure');
  });

  it('FORBIDDEN for role=marketing', async () => {
    const { conn, insertedRows } = makeDeps({ callerRole: 'marketing' });
    const r = await getTool(conn).execute({ orderId: 43785, newEmail: 'x@y.com', confirm: true });
    expect((r as any).error.code).toBe('FORBIDDEN');
    expect(insertedRows).toHaveLength(0);
  });

  it('FORBIDDEN for role=user', async () => {
    const { conn, insertedRows } = makeDeps({ callerRole: 'user' });
    const r = await getTool(conn).execute({ orderId: 43785, newEmail: 'x@y.com', confirm: false });
    expect((r as any).error.code).toBe('FORBIDDEN');
    expect(insertedRows).toHaveLength(0);
  });

  it('admin role also allowed', async () => {
    const { conn } = makeDeps({ callerRole: 'admin' });
    const r = await getTool(conn).execute({ orderId: 43785, newEmail: 'x@y.com', confirm: false });
    expect((r as any).kind).toBe('awaiting_confirmation');
  });

  it('write_target=prod when env var set', async () => {
    process.env.PORTER_WRITE_TARGET = 'prod';
    const { conn, insertedRows } = makeDeps();
    const r = await getTool(conn).execute({ orderId: 43785, newEmail: 'x@y.com', confirm: true });
    expect((r as any).ok).toBe(true);
    expect(insertedRows[0].writeTarget).toBe('prod');
  });

  it('schema rejects invalid newEmail', () => {
    const { conn } = makeDeps();
    const tool = getTool(conn);
    expect(() => tool.schema.parse({ orderId: 43785, newEmail: 'not-an-email' })).toThrow();
  });

  it('schema defaults syncKlaviyo to true and confirm to false', () => {
    const { conn } = makeDeps();
    const tool = getTool(conn);
    const parsed = tool.schema.parse({ orderId: 43785, newEmail: 'x@y.com' });
    expect((parsed as any).syncKlaviyo).toBe(true);
    expect((parsed as any).confirm).toBe(false);
  });

  it('customerName falls back to "(unnamed)" when first/last missing', async () => {
    const customFetch = vi.fn(async (callOpts: any) => {
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/transactions/43785') {
        return makeOrderResponse({ firstName: null, lastName: null });
      }
      if (callOpts.method === 'POST') return makePaginatedTransactionsResponse(1);
      throw new Error('unexpected');
    });
    const { conn } = makeDeps({ porterFetchImpl: customFetch });
    const r = await getTool(conn).execute({ orderId: 43785, newEmail: 'x@y.com', confirm: false });
    expect((r as any).customerName).toBe('(unnamed)');
  });

  it('oldEmail-mode: happy path resolves user and returns awaiting_confirmation', async () => {
    const customFetch = vi.fn(async (callOpts: any) => {
      if (
        callOpts.method === 'GET' &&
        callOpts.path === '/api/admin/users/by-email?email=xavi%40example.com'
      ) {
        return {
          account: {
            userId: 59516,
            email: 'xavi@example.com',
            klaviyoId: '01JHPN57KPZFTJVN8D4D2WVK2H',
            firstName: 'Xavi',
            lastName: 'Ocana',
          },
        };
      }
      if (callOpts.method === 'POST' && callOpts.path === '/api/admin/paginated-transactions') {
        // The resolver fetches up to 50 with `search: email`. Return one match
        // with an exact email + authToken so it picks it up, plus a noisy
        // false-positive that should be filtered out.
        return {
          transactions: [
            {
              id: 43785,
              user: {
                id: 59516,
                email: 'xavi@example.com',
                authToken: 'customer-jwt-token',
                klaviyoId: '01JHPN57KPZFTJVN8D4D2WVK2H',
                firstName: 'Xavi',
                lastName: 'Ocana',
              },
            },
            {
              id: 99999,
              user: {
                id: 70000,
                email: 'xavi-but-different@example.com',
                authToken: 'should-not-be-picked',
              },
            },
          ],
          allOrders: 4,
        };
      }
      throw new Error(`unexpected ${callOpts.method} ${callOpts.path}`);
    });
    const { conn, insertedRows } = makeDeps({ porterFetchImpl: customFetch });
    const r = await getTool(conn).execute({
      oldEmail: 'xavi@example.com',
      newEmail: 'danavoniel@gmail.com',
      confirm: false,
    });
    expect((r as any).kind).toBe('awaiting_confirmation');
    expect((r as any).orderId).toBe(43785);
    expect((r as any).userId).toBe(59516);
    expect((r as any).currentEmail).toBe('xavi@example.com');
    expect((r as any).newEmail).toBe('danavoniel@gmail.com');
    expect((r as any).customerName).toBe('Xavi Ocana');
    expect((r as any).totalOrders).toBe(4);
    expect((r as any).klaviyoProfileLinked).toBe(true);
    expect((r as any).target).toBe('staging');
    expect(insertedRows).toHaveLength(0);
  });

  it('oldEmail-mode: returns USER_NOT_FOUND_BY_EMAIL when /api/admin/users/by-email is 404', async () => {
    const customFetch = vi.fn(async (callOpts: any) => {
      if (
        callOpts.method === 'GET' &&
        callOpts.path === '/api/admin/users/by-email?email=ghost%40example.com'
      ) {
        const err: any = new Error('not found');
        err.status = 404;
        throw err;
      }
      throw new Error(`unexpected ${callOpts.method} ${callOpts.path}`);
    });
    const { conn, insertedRows } = makeDeps({ porterFetchImpl: customFetch });
    const r = await getTool(conn).execute({
      oldEmail: 'ghost@example.com',
      newEmail: 'x@y.com',
      confirm: false,
    });
    expect((r as any).error.code).toBe('USER_NOT_FOUND_BY_EMAIL');
    expect(insertedRows).toHaveLength(0);
  });

  it('oldEmail-mode: returns USER_HAS_NO_ORDERS when paginated-transactions returns no matching order', async () => {
    const customFetch = vi.fn(async (callOpts: any) => {
      if (
        callOpts.method === 'GET' &&
        callOpts.path === '/api/admin/users/by-email?email=lonely%40example.com'
      ) {
        return {
          account: {
            userId: 80000,
            email: 'lonely@example.com',
            klaviyoId: null,
            firstName: 'Lonely',
            lastName: 'User',
          },
        };
      }
      if (callOpts.method === 'POST' && callOpts.path === '/api/admin/paginated-transactions') {
        // No matching order — could be because allOrders=0, or because the
        // fuzzy search returned only false positives (different email).
        return {
          transactions: [
            {
              id: 12345,
              user: {
                id: 99999,
                email: 'someone-else@example.com',
                authToken: 'irrelevant',
              },
            },
          ],
          allOrders: 0,
        };
      }
      throw new Error(`unexpected ${callOpts.method} ${callOpts.path}`);
    });
    const { conn, insertedRows } = makeDeps({ porterFetchImpl: customFetch });
    const r = await getTool(conn).execute({
      oldEmail: 'lonely@example.com',
      newEmail: 'x@y.com',
      confirm: false,
    });
    expect((r as any).error.code).toBe('USER_HAS_NO_ORDERS');
    expect(insertedRows).toHaveLength(0);
  });

  it('arg validation: returns INVALID_ARGS when both orderId and oldEmail provided', async () => {
    const { conn, insertedRows } = makeDeps();
    const r = await getTool(conn).execute({
      orderId: 43785,
      oldEmail: 'xavi@example.com',
      newEmail: 'x@y.com',
      confirm: false,
    });
    expect((r as any).error.code).toBe('INVALID_ARGS');
    expect(insertedRows).toHaveLength(0);
  });

  it('arg validation: returns INVALID_ARGS when neither orderId nor oldEmail provided', async () => {
    const { conn, insertedRows } = makeDeps();
    const r = await getTool(conn).execute({
      newEmail: 'x@y.com',
      confirm: false,
    });
    expect((r as any).error.code).toBe('INVALID_ARGS');
    expect(insertedRows).toHaveLength(0);
  });

  it('oldEmail-mode: confirm:true path completes the email change end-to-end (mock PUT /api/user, mock Klaviyo)', async () => {
    const customFetch = vi.fn(async (callOpts: any) => {
      if (
        callOpts.method === 'GET' &&
        callOpts.path === '/api/admin/users/by-email?email=xavi%40example.com'
      ) {
        return {
          account: {
            userId: 59516,
            email: 'xavi@example.com',
            klaviyoId: '01JHPN57KPZFTJVN8D4D2WVK2H',
            firstName: 'Xavi',
            lastName: 'Ocana',
          },
        };
      }
      if (callOpts.method === 'POST' && callOpts.path === '/api/admin/paginated-transactions') {
        return {
          transactions: [
            {
              id: 43785,
              user: {
                id: 59516,
                email: 'xavi@example.com',
                authToken: 'customer-jwt-token',
                klaviyoId: '01JHPN57KPZFTJVN8D4D2WVK2H',
                firstName: 'Xavi',
                lastName: 'Ocana',
              },
            },
          ],
          allOrders: 1,
        };
      }
      if (callOpts.method === 'GET' && callOpts.path === '/api/user') {
        return { data: { id: 59516, email: 'xavi@example.com', firstName: 'Xavi', lastName: 'Ocana' } };
      }
      if (callOpts.method === 'PUT' && callOpts.path === '/api/user') {
        return { success: true, data: { id: 59516, email: callOpts.body?.email } };
      }
      throw new Error(`unexpected ${callOpts.method} ${callOpts.path}`);
    });
    const { conn, insertedRows } = makeDeps({ porterFetchImpl: customFetch });
    const r = await getTool(conn).execute({
      oldEmail: 'xavi@example.com',
      newEmail: 'danavoniel@gmail.com',
      syncKlaviyo: true,
      confirm: true,
    });
    expect((r as any).ok).toBe(true);
    expect((r as any).porterOk).toBe(true);
    expect((r as any).klaviyoOk).toBe(true);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      callerSlackId: 'U_ZUZ',
      action: 'update_customer_email',
      porterUserId: 59516,
      // The audit row uses the orderId resolved from the most recent order,
      // not args.orderId (which is undefined in oldEmail mode).
      porterOrderId: 43785,
      klaviyoProfileId: '01JHPN57KPZFTJVN8D4D2WVK2H',
      status: 'success',
      writeTarget: 'staging',
    });
  });
});
