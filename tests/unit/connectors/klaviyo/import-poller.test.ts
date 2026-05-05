import { describe, it, expect, vi } from 'vitest';
import { KlaviyoImportPollerJob } from '../../../../src/connectors/klaviyo/import-poller.js';

function makeJob(opts: any = {}) {
  return new KlaviyoImportPollerJob({
    importsRepo: opts.importsRepo ?? {
      listInFlight: vi.fn().mockResolvedValue([]),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    },
    pendingRepo: opts.pendingRepo ?? { sweepExpired: vi.fn().mockResolvedValue(0) },
    client: opts.client ?? { getBulkImportJobStatus: vi.fn() },
    slack: opts.slack ?? { postMessage: vi.fn().mockResolvedValue(undefined) },
    callerLookup: opts.callerLookup ?? { resolve: vi.fn().mockResolvedValue({ slackUserId: 'U1', dmChannelId: 'D1' }) },
    now: opts.now ?? (() => new Date('2026-05-05T10:00:00Z')),
  });
}

describe('KlaviyoImportPollerJob.tick', () => {
  it('sweepExpired runs each tick', async () => {
    const pendingRepo = { sweepExpired: vi.fn().mockResolvedValue(2) };
    const job = makeJob({ pendingRepo });
    await job.tick();
    expect(pendingRepo.sweepExpired).toHaveBeenCalledOnce();
  });

  it('queued → processing updates row, no DM', async () => {
    const importsRepo = {
      listInFlight: vi.fn().mockResolvedValue([{
        id: 'a1', klaviyoJobId: 'j1', status: 'queued',
        startedAt: '2026-05-05T09:59:00Z', callerSlackId: 'U1',
      }]),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    };
    const client = { getBulkImportJobStatus: vi.fn().mockResolvedValue({ status: 'processing' }) };
    const slack = { postMessage: vi.fn() };
    const job = makeJob({ importsRepo, client, slack });
    await job.tick();
    expect(importsRepo.updateStatus).toHaveBeenCalledWith('a1', { status: 'processing' });
    expect(slack.postMessage).not.toHaveBeenCalled();
  });

  it('queued → already processing — does NOT update if status unchanged', async () => {
    const importsRepo = {
      listInFlight: vi.fn().mockResolvedValue([{
        id: 'a1', klaviyoJobId: 'j1', status: 'processing',
        startedAt: '2026-05-05T09:59:00Z', callerSlackId: 'U1',
      }]),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    };
    const client = { getBulkImportJobStatus: vi.fn().mockResolvedValue({ status: 'processing' }) };
    const job = makeJob({ importsRepo, client });
    await job.tick();
    expect(importsRepo.updateStatus).not.toHaveBeenCalled();
  });

  it('queued → complete updates row + DMs caller with counts', async () => {
    const importsRepo = {
      listInFlight: vi.fn().mockResolvedValue([{
        id: 'a1', klaviyoJobId: 'j1', status: 'queued',
        startedAt: '2026-05-05T09:59:00Z', callerSlackId: 'U1', totalImported: 3,
      }]),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    };
    const client = { getBulkImportJobStatus: vi.fn().mockResolvedValue({ status: 'complete', totalCount: 3, completedCount: 3, failedCount: 0 }) };
    const slack = { postMessage: vi.fn().mockResolvedValue(undefined) };
    const job = makeJob({ importsRepo, client, slack });
    await job.tick();
    expect(importsRepo.updateStatus).toHaveBeenCalledWith('a1', expect.objectContaining({ status: 'complete', succeededCount: 3, failedCount: 0 }));
    expect(slack.postMessage).toHaveBeenCalledOnce();
    const text = (slack.postMessage as any).mock.calls[0][1];
    expect(text).toContain('Done');
  });

  it('queued → failed updates row + DMs failure reason', async () => {
    const importsRepo = {
      listInFlight: vi.fn().mockResolvedValue([{
        id: 'a1', klaviyoJobId: 'j1', status: 'queued',
        startedAt: '2026-05-05T09:59:00Z', callerSlackId: 'U1',
      }]),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    };
    const client = { getBulkImportJobStatus: vi.fn().mockResolvedValue({ status: 'failed', errors: [{ detail: 'malformed payload' }] }) };
    const slack = { postMessage: vi.fn().mockResolvedValue(undefined) };
    const job = makeJob({ importsRepo, client, slack });
    await job.tick();
    expect(importsRepo.updateStatus).toHaveBeenCalledWith('a1', expect.objectContaining({ status: 'failed', errorSummary: expect.stringContaining('malformed') }));
    expect(slack.postMessage).toHaveBeenCalledOnce();
  });

  it('30-min stuck timeout marks failed', async () => {
    const importsRepo = {
      listInFlight: vi.fn().mockResolvedValue([{
        id: 'a1', klaviyoJobId: 'j1', status: 'processing',
        startedAt: '2026-05-05T09:00:00Z', callerSlackId: 'U1',  // 60 min ago
      }]),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    };
    const client = { getBulkImportJobStatus: vi.fn().mockResolvedValue({ status: 'processing' }) };
    const slack = { postMessage: vi.fn().mockResolvedValue(undefined) };
    const job = makeJob({ importsRepo, client, slack });
    await job.tick();
    expect(importsRepo.updateStatus).toHaveBeenCalledWith('a1', { status: 'failed', errorSummary: 'timeout (>30 min in processing)' });
    expect(slack.postMessage).toHaveBeenCalledOnce();
    // The Klaviyo client should NOT be called for this row since timeout takes precedence
    expect(client.getBulkImportJobStatus).not.toHaveBeenCalled();
  });

  it('row processing failure does not stop other rows', async () => {
    const importsRepo = {
      listInFlight: vi.fn().mockResolvedValue([
        { id: 'a1', klaviyoJobId: 'j1', status: 'queued', startedAt: '2026-05-05T09:59:00Z', callerSlackId: 'U1' },
        { id: 'a2', klaviyoJobId: 'j2', status: 'queued', startedAt: '2026-05-05T09:59:00Z', callerSlackId: 'U2' },
      ]),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      getBulkImportJobStatus: vi.fn(async (id) => {
        if (id === 'j1') throw new Error('network blip');
        return { status: 'complete', completedCount: 5, failedCount: 0 };
      }),
    };
    const job = makeJob({ importsRepo, client });
    await job.tick();
    // Even though j1 threw, j2 should still get processed
    expect(importsRepo.updateStatus).toHaveBeenCalledWith('a2', expect.objectContaining({ status: 'complete' }));
  });

  it('start/stop manages the interval timer', async () => {
    vi.useFakeTimers();
    const job = makeJob();
    job.start(60_000);
    // advance 60s — should trigger one more tick (the first tick fires immediately on start)
    await vi.advanceTimersByTimeAsync(60_000);
    job.stop();
    vi.useRealTimers();
    // Smoke check — no exceptions, stop is idempotent
    job.stop();
  });
});
