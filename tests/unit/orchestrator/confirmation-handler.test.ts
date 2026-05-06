import { describe, it, expect, vi } from 'vitest';
import { ConfirmationHandler } from '../../../src/orchestrator/confirmation-handler.js';

function makeHandler(opts: any = {}) {
  return new ConfirmationHandler({
    pendingRepo: opts.pendingRepo ?? {
      lookupByThread: vi.fn().mockResolvedValue(null),
      deleteById: vi.fn().mockResolvedValue(undefined),
    },
    importsRepo: opts.importsRepo ?? { insert: vi.fn() },
    deletionsRepo: opts.deletionsRepo ?? { insert: vi.fn() },
    client: opts.client ?? {},
    slack: opts.slack ?? { postMessage: vi.fn().mockResolvedValue(undefined) },
    sleep: opts.sleep ?? (async () => {}),
    runTool: opts.runTool,
  });
}

describe('ConfirmationHandler.tryHandle', () => {
  it('returns false when text is not yes/cancel', async () => {
    const handler = makeHandler();
    const r = await handler.tryHandle({ slackUserId: 'U1', channelId: 'D1', threadTs: 't0', text: 'hello world' });
    expect(r).toBe(false);
  });

  it('returns false when no pending row', async () => {
    const handler = makeHandler();
    const r = await handler.tryHandle({ slackUserId: 'U1', channelId: 'D1', threadTs: 't0', text: 'yes' });
    expect(r).toBe(false);
  });

  it('always queries pending row (kind decides how to interpret text); returns false when no row', async () => {
    // The handler now always looks up pending FIRST since klaviyo_csv_pending
    // can interpret any text as a list selection. When no pending row exists,
    // it always returns false (no LLM short-circuit).
    const pendingRepo = { lookupByThread: vi.fn().mockResolvedValue(null), deleteById: vi.fn() };
    const handler = makeHandler({ pendingRepo });
    for (const t of ['YES', 'yes', '  yes ', 'Y', 'CANCEL', 'cancel', 'No', 'n', 'maybe']) {
      const r = await handler.tryHandle({ slackUserId: 'U1', channelId: 'D1', threadTs: 't0', text: t });
      expect(r).toBe(false);
    }
    expect(pendingRepo.lookupByThread).toHaveBeenCalledTimes(9);
  });

  it('csv-pending: any non-cancel text dispatches commit_pending_csv_import with text as list', async () => {
    const pendingRepo = {
      lookupByThread: vi.fn().mockResolvedValue({
        id: 'p1', kind: 'klaviyo_csv_pending', callerSlackId: 'U1',
        channelId: 'D1', threadTs: 'D1',
        payload: { profiles: [{ email: 'a@x.com' }], filename: 'f.csv', storagePath: null, channels: ['email'] },
      }),
      deleteById: vi.fn(),
    };
    const runTool = vi.fn().mockResolvedValue({
      kind: 'imported_directly', total_imported: 1, list: { id: 'L1', name: 'Trade Show Leads' },
    });
    const slack = { postMessage: vi.fn().mockResolvedValue(undefined) };
    const handler = makeHandler({ pendingRepo, runTool, slack });
    const r = await handler.tryHandle({ slackUserId: 'U1', channelId: 'D1', threadTs: 'D1', text: 'prueba nueva' });
    expect(r).toBe(true);
    expect(runTool).toHaveBeenCalledWith(
      'klaviyo.commit_pending_csv_import',
      { list: 'prueba nueva' },
      expect.objectContaining({ slackUserId: 'U1', channelId: 'D1' }),
    );
    expect(slack.postMessage).toHaveBeenCalled();
  });

  it('csv-pending: LIST_NOT_FOUND surfaces top suggestions to the user', async () => {
    const pendingRepo = {
      lookupByThread: vi.fn().mockResolvedValue({
        id: 'p1', kind: 'klaviyo_csv_pending', callerSlackId: 'U1',
        channelId: 'D1', threadTs: 'D1',
        payload: { profiles: [{ email: 'a@x.com' }], filename: 'f.csv', storagePath: null, channels: ['email'] },
      }),
      deleteById: vi.fn(),
    };
    const runTool = vi.fn().mockResolvedValue({
      error: { code: 'LIST_NOT_FOUND', details: { suggestions: [{ id: 'L1', name: 'Trade Show Leads' }] } },
    });
    const slack = { postMessage: vi.fn().mockResolvedValue(undefined) };
    const handler = makeHandler({ pendingRepo, runTool, slack });
    await handler.tryHandle({ slackUserId: 'U1', channelId: 'D1', threadTs: 'D1', text: 'trade show' });
    const reply = (slack.postMessage as any).mock.calls[0][1];
    expect(reply).toMatch(/Trade Show Leads/);
  });

  it('csv-pending: cancel deletes the pending row + posts cancellation', async () => {
    const pendingRepo = {
      lookupByThread: vi.fn().mockResolvedValue({
        id: 'p1', kind: 'klaviyo_csv_pending', callerSlackId: 'U1',
        channelId: 'D1', threadTs: 'D1', payload: {},
      }),
      deleteById: vi.fn().mockResolvedValue(undefined),
    };
    const slack = { postMessage: vi.fn().mockResolvedValue(undefined) };
    const handler = makeHandler({ pendingRepo, slack });
    const r = await handler.tryHandle({ slackUserId: 'U1', channelId: 'D1', threadTs: 'D1', text: 'cancel' });
    expect(r).toBe(true);
    expect(pendingRepo.deleteById).toHaveBeenCalledWith('p1');
    // threadTs 'D1' (channel id) gets filtered to undefined by safeThreadTs to avoid Slack invalid_thread_ts.
    expect(slack.postMessage).toHaveBeenCalledWith('D1', expect.stringContaining('Cancelled'), undefined);
  });

  it('cancel deletes the pending row, DMs cancelled', async () => {
    const pendingRepo = {
      lookupByThread: vi.fn().mockResolvedValue({
        id: 'p1', kind: 'klaviyo_import', callerSlackId: 'U1', payload: {},
      }),
      deleteById: vi.fn().mockResolvedValue(undefined),
    };
    const slack = { postMessage: vi.fn().mockResolvedValue(undefined) };
    const handler = makeHandler({ pendingRepo, slack });
    const r = await handler.tryHandle({ slackUserId: 'U1', channelId: 'D1', threadTs: 't0', text: 'cancel' });
    expect(r).toBe(true);
    expect(pendingRepo.deleteById).toHaveBeenCalledWith('p1');
    expect(slack.postMessage).toHaveBeenCalled();
  });

  it('yes import calls bulkSubscribeProfiles + inserts audit + deletes pending', async () => {
    const pendingRepo = {
      lookupByThread: vi.fn().mockResolvedValue({
        id: 'p1', kind: 'klaviyo_import', callerSlackId: 'U1',
        payload: {
          valid: [{ email: 'a@x.com', rowIndex: 1 }, { email: 'b@y.com', rowIndex: 2, phone_e164: '+14155550100' }],
          listId: 'L1', listName: 'Trade',
          channels: ['email'], source: 'inline', filename: null, storagePath: null,
          totalSubmitted: 3, totalInvalidRejected: 1, defaultConsentSource: null,
        },
      }),
      deleteById: vi.fn().mockResolvedValue(undefined),
    };
    const client = { bulkSubscribeProfiles: vi.fn().mockResolvedValue({ job_id: 'job-1' }) };
    const importsRepo = { insert: vi.fn().mockResolvedValue({ id: 'a1', klaviyoJobId: 'job-1' }) };
    const slack = { postMessage: vi.fn().mockResolvedValue(undefined) };
    const handler = makeHandler({ pendingRepo, client, importsRepo, slack });
    const r = await handler.tryHandle({ slackUserId: 'U1', channelId: 'D1', threadTs: 't0', text: 'yes' });
    expect(r).toBe(true);
    expect(client.bulkSubscribeProfiles).toHaveBeenCalledOnce();
    const arg = (client.bulkSubscribeProfiles as any).mock.calls[0][0];
    expect(arg.profiles.length).toBe(2);
    expect(arg.listId).toBe('L1');
    expect(arg.channels).toEqual(['email']);
    expect(importsRepo.insert).toHaveBeenCalledOnce();
    const ins = (importsRepo.insert as any).mock.calls[0][0];
    expect(ins.totalSubmitted).toBe(3);
    expect(ins.totalImported).toBe(2);
    expect(ins.totalInvalidRejected).toBe(1);
    expect(ins.klaviyoJobId).toBe('job-1');
    expect(pendingRepo.deleteById).toHaveBeenCalledWith('p1');
  });

  it('yes delete loops with pacing + retries 429 once', async () => {
    const pendingRepo = {
      lookupByThread: vi.fn().mockResolvedValue({
        id: 'p1', kind: 'klaviyo_delete', callerSlackId: 'U1',
        payload: {
          found: [
            { email: 'a@x.com', profile_id: 'pid1', created_at: '2024-01-01T00:00:00Z', lists: [] },
            { email: 'b@y.com', profile_id: 'pid2', created_at: '2024-01-01T00:00:00Z', lists: [] },
            { email: 'c@z.com', profile_id: 'pid3', created_at: '2024-01-01T00:00:00Z', lists: [] },
          ],
          not_found: [], requested: ['a@x.com', 'b@y.com', 'c@z.com'],
        },
      }),
      deleteById: vi.fn().mockResolvedValue(undefined),
    };
    let callCount = 0;
    const client = {
      requestProfileDeletion: vi.fn(async () => {
        callCount++;
        if (callCount === 2) {
          const err: any = new Error('rate limited'); err.status = 429;
          throw err;
        }
        return { deletion_job_id: 'd' + callCount };
      }),
    };
    const deletionsRepo = { insert: vi.fn().mockResolvedValue({ id: 'del1' }) };
    const slack = { postMessage: vi.fn().mockResolvedValue(undefined) };
    const sleep = vi.fn().mockResolvedValue(undefined);
    const handler = makeHandler({ pendingRepo, client, deletionsRepo, slack, sleep });
    const r = await handler.tryHandle({ slackUserId: 'U1', channelId: 'D1', threadTs: 't0', text: 'yes' });
    expect(r).toBe(true);
    // 3 calls + 1 retry = 4 total
    expect(client.requestProfileDeletion).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalled();
    const ins = (deletionsRepo.insert as any).mock.calls[0][0];
    expect(ins.deletedCount).toBe(3); // all eventually succeeded
    expect(ins.failedCount).toBe(0);
  });

  it('yes delete records failed_details when retry fails', async () => {
    const pendingRepo = {
      lookupByThread: vi.fn().mockResolvedValue({
        id: 'p1', kind: 'klaviyo_delete', callerSlackId: 'U1',
        payload: {
          found: [
            { email: 'a@x.com', profile_id: 'pid1', created_at: '2024-01-01T00:00:00Z', lists: [] },
            { email: 'b@y.com', profile_id: 'pid2', created_at: '2024-01-01T00:00:00Z', lists: [] },
          ],
          not_found: [], requested: ['a@x.com', 'b@y.com'],
        },
      }),
      deleteById: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      requestProfileDeletion: vi.fn(async ({ email }: any) => {
        if (email === 'b@y.com') {
          const err: any = new Error('bad request'); err.status = 400;
          throw err;
        }
        return { deletion_job_id: 'd-' + email };
      }),
    };
    const deletionsRepo = { insert: vi.fn().mockResolvedValue({ id: 'del1' }) };
    const handler = makeHandler({ pendingRepo, client, deletionsRepo });
    await handler.tryHandle({ slackUserId: 'U1', channelId: 'D1', threadTs: 't0', text: 'yes' });
    const ins = (deletionsRepo.insert as any).mock.calls[0][0];
    expect(ins.deletedCount).toBe(1);
    expect(ins.failedCount).toBe(1);
    expect(ins.failedDetails[0].email).toBe('b@y.com');
    expect(ins.failedDetails[0].status).toBe(400);
  });

  it('caller mismatch falls through (defense in depth)', async () => {
    const pendingRepo = {
      lookupByThread: vi.fn().mockResolvedValue({
        id: 'p1', kind: 'klaviyo_import', callerSlackId: 'OTHER', payload: {},
      }),
      deleteById: vi.fn(),
    };
    const handler = makeHandler({ pendingRepo });
    const r = await handler.tryHandle({ slackUserId: 'U1', channelId: 'D1', threadTs: 't0', text: 'yes' });
    expect(r).toBe(false);
    expect(pendingRepo.deleteById).not.toHaveBeenCalled();
  });

  it('crash inside import executor still deletes pending row + DMs error', async () => {
    const pendingRepo = {
      lookupByThread: vi.fn().mockResolvedValue({
        id: 'p1', kind: 'klaviyo_import', callerSlackId: 'U1',
        payload: { valid: [{ email: 'a@x.com', rowIndex: 1 }], listId: null, listName: null, channels: ['email'], source: 'inline', filename: null, storagePath: null, totalSubmitted: 1, totalInvalidRejected: 0, defaultConsentSource: null },
      }),
      deleteById: vi.fn().mockResolvedValue(undefined),
    };
    const client = { bulkSubscribeProfiles: vi.fn().mockRejectedValue(new Error('boom')) };
    const importsRepo = { insert: vi.fn() };
    const slack = { postMessage: vi.fn().mockResolvedValue(undefined) };
    const handler = makeHandler({ pendingRepo, client, importsRepo, slack });
    const r = await handler.tryHandle({ slackUserId: 'U1', channelId: 'D1', threadTs: 't0', text: 'yes' });
    expect(r).toBe(true); // consumed
    expect(slack.postMessage).toHaveBeenCalled();
    expect(pendingRepo.deleteById).toHaveBeenCalledWith('p1');
  });
});
