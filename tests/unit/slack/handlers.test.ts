import { describe, it, expect, vi } from 'vitest';
import { createDmHandler, handleFileShared } from '../../../src/slack/handlers.js';

function makeContext(isAuthorized: boolean) {
  const runSpy = vi.fn(async () => ({
    response: 'You spent $700.',
    model: 'claude-sonnet-4-6',
    toolCalls: [],
    tokensInput: 100,
    tokensOutput: 10,
    iterations: 1,
    attachments: [],
  }));
  const insertSpy = vi.fn(async () => 'conv-1');
  const loadSpy = vi.fn(async () => []);
  const postMessage = vi.fn(async () => ({ ts: '1234.5678' }));
  const update = vi.fn(async () => ({}));
  // Stub confirmation handler that always reports "not consumed" so the
  // existing flow (LLM dispatch) continues unchanged. Tests for the
  // confirmation flow itself live in tests/unit/orchestrator/.
  const tryHandleSpy = vi.fn(async () => false);
  return {
    spies: { runSpy, insertSpy, postMessage, update, loadSpy, tryHandleSpy },
    deps: {
      orchestrator: { run: runSpy },
      usersRepo: { isAuthorized: vi.fn(async () => isAuthorized) },
      conversationsRepo: { insert: insertSpy, loadRecentByThread: loadSpy },
      confirmationHandler: { tryHandle: tryHandleSpy },
    },
    event: {
      channel_type: 'im',
      channel: 'D1',
      user: 'U1',
      text: 'how much did we spend',
      ts: '1000.0001',
      thread_ts: undefined,
    },
    say: vi.fn(async () => ({})),
    client: {
      chat: { postMessage, update },
    } as any,
  };
}

describe('createDmHandler', () => {
  it('replies with the orchestrator response in the thread', async () => {
    const ctx = makeContext(true);
    const handler = createDmHandler(ctx.deps as any);
    await handler({ event: ctx.event as any, client: ctx.client, say: ctx.say } as any);
    expect(ctx.spies.postMessage).toHaveBeenCalledTimes(1);
    expect(ctx.spies.update).toHaveBeenCalledTimes(1);
    expect(ctx.spies.runSpy).toHaveBeenCalledOnce();
    expect(ctx.spies.insertSpy).toHaveBeenCalledOnce();
  });

  it('declines politely for unauthorized users', async () => {
    const ctx = makeContext(false);
    const handler = createDmHandler(ctx.deps as any);
    await handler({ event: ctx.event as any, client: ctx.client, say: ctx.say } as any);
    expect(ctx.spies.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/not authorized/i),
    }));
    expect(ctx.spies.runSpy).not.toHaveBeenCalled();
  });

  it('ignores message_changed subtype events', async () => {
    const ctx = makeContext(true);
    const handler = createDmHandler(ctx.deps as any);
    const e = { ...ctx.event, subtype: 'message_changed' };
    await handler({ event: e as any, client: ctx.client, say: ctx.say } as any);
    expect(ctx.spies.postMessage).not.toHaveBeenCalled();
  });

  it('ignores events from the bot itself (no bot_id loops)', async () => {
    const ctx = makeContext(true);
    const handler = createDmHandler(ctx.deps as any);
    const e = { ...ctx.event, bot_id: 'B1' };
    await handler({ event: e as any, client: ctx.client, say: ctx.say } as any);
    expect(ctx.spies.postMessage).not.toHaveBeenCalled();
  });

  it('stores summary-only tool_calls when DEBUG_FULL_LOGS is off', async () => {
    process.env.DEBUG_FULL_LOGS = 'false';
    const ctx = makeContext(true);
    (ctx.spies.runSpy as any).mockResolvedValueOnce({
      response: 'ok', model: 'm', toolCalls: [{ name: 'x', args: { secret: 1 }, ok: true }],
      tokensInput: 0, tokensOutput: 0, iterations: 1, attachments: [],
    });
    const handler = createDmHandler(ctx.deps as any);
    await handler({ event: ctx.event as any, client: ctx.client, say: ctx.say } as any);
    const call = (ctx.spies.insertSpy.mock.calls[0] as any)[0];
    expect(call.tool_calls[0]).not.toHaveProperty('args');
  });

  it('uploads orchestrator attachments through the external-upload Slack API in the same thread', async () => {
    const origFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes('files.getUploadURLExternal')) {
        return new Response(JSON.stringify({ ok: true, upload_url: 'https://files.slack.com/upload/test', file_id: 'F_TEST' }));
      }
      if (u.startsWith('https://files.slack.com/upload/')) {
        return new Response('OK - 16');
      }
      if (u.includes('files.completeUploadExternal')) {
        return new Response(JSON.stringify({ ok: true }));
      }
      return new Response('{}');
    });
    globalThis.fetch = fetchSpy as any;
    try {
      const ctx = makeContext(true);
      (ctx.spies.runSpy as any).mockResolvedValueOnce({
        response: 'See attached.', model: 'm', toolCalls: [], tokensInput: 0, tokensOutput: 0, iterations: 1,
        attachments: [
          {
            format: 'csv', filename: 'orders', normalizedFilename: 'orders.csv',
            content: 'id,revenue\n1,100', title: 'Orders export',
          },
        ],
      });
      const handler = createDmHandler(ctx.deps as any);
      await handler({ event: ctx.event as any, client: ctx.client, say: ctx.say } as any);
      const urls = fetchSpy.mock.calls.map((c: any[]) => String(c[0]));
      expect(urls.some((u: string) => u.includes('files.getUploadURLExternal'))).toBe(true);
      expect(urls.some((u: string) => u.startsWith('https://files.slack.com/upload/'))).toBe(true);
      expect(urls.some((u: string) => u.includes('files.completeUploadExternal'))).toBe(true);

      const completeCall = fetchSpy.mock.calls.find((c: any[]) => String(c[0]).includes('files.completeUploadExternal'))!;
      const body = JSON.parse(String((completeCall[1] as RequestInit).body));
      expect(body).toMatchObject({ channel_id: 'D1', thread_ts: '1000.0001' });
      expect(body.files[0]).toMatchObject({ id: 'F_TEST', title: 'Orders export' });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('preserves args in tool_calls when DEBUG_FULL_LOGS is on', async () => {
    process.env.DEBUG_FULL_LOGS = 'true';
    const ctx = makeContext(true);
    (ctx.spies.runSpy as any).mockResolvedValueOnce({
      response: 'ok', model: 'm', toolCalls: [{ name: 'x', args: { secret: 1 }, ok: true }],
      tokensInput: 0, tokensOutput: 0, iterations: 1, attachments: [],
    });
    const handler = createDmHandler(ctx.deps as any);
    await handler({ event: ctx.event as any, client: ctx.client, say: ctx.say } as any);
    const call = (ctx.spies.insertSpy.mock.calls[0] as any)[0];
    expect(call.tool_calls[0]).toHaveProperty('args');
    // Cleanup for other tests
    delete process.env.DEBUG_FULL_LOGS;
  });
});

describe('handleFileShared', () => {
  function makeDeps(opts: any = {}) {
    return {
      usersRepo: { getRole: vi.fn().mockResolvedValue(opts.role ?? 'admin') },
      slack: {
        filesInfo: vi.fn().mockResolvedValue(opts.filesInfoResult ?? {
          ok: true,
          file: {
            id: 'F1', filetype: 'csv', mimetype: 'text/csv', size: 200,
            url_private_download: 'https://files.slack.com/F1', name: 'leads.csv',
          },
        }),
        postMessage: vi.fn().mockResolvedValue(undefined),
        downloadFile: opts.downloadFile ?? vi.fn().mockResolvedValue(Buffer.from('email,first_name\na@x.com,A\nb@y.com,B')),
      },
      orchestrator: {
        runTool: opts.runTool ?? vi.fn().mockResolvedValue({
          kind: 'imported_directly', audit_id: 'a1', klaviyo_job_id: 'j1', total_imported: 2,
        }),
      },
      storage: {
        upload: vi.fn().mockResolvedValue({ path: 'klaviyo-imports/F1-123.csv' }),
      },
    };
  }

  it('happy path: DM + admin + CSV → calls klaviyo.import_profiles', async () => {
    const deps = makeDeps();
    await handleFileShared({
      event: { channel_id: 'D1', user_id: 'U1', file_id: 'F1' },
      deps: deps as any,
    });
    expect(deps.orchestrator.runTool).toHaveBeenCalledWith(
      'klaviyo.import_profiles',
      expect.objectContaining({
        source: 'csv',
        profiles: expect.any(Array),
        storage_path: 'klaviyo-imports/F1-123.csv',
        filename: 'leads.csv',
      }),
      expect.objectContaining({ slackUserId: 'U1', channelId: 'D1' }),
    );
    expect(deps.slack.postMessage).toHaveBeenCalled();
  });

  it('skips when not a DM channel', async () => {
    const deps = makeDeps();
    await handleFileShared({
      event: { channel_id: 'C1', user_id: 'U1', file_id: 'F1' },
      deps: deps as any,
    });
    expect(deps.slack.filesInfo).not.toHaveBeenCalled();
    expect(deps.orchestrator.runTool).not.toHaveBeenCalled();
  });

  it('rejects role=user with friendly DM', async () => {
    const deps = makeDeps({ role: 'user' });
    await handleFileShared({
      event: { channel_id: 'D1', user_id: 'U1', file_id: 'F1' },
      deps: deps as any,
    });
    expect(deps.slack.filesInfo).not.toHaveBeenCalled();
    expect(deps.slack.postMessage).toHaveBeenCalledWith('D1', expect.stringContaining('admin or marketing'), undefined);
    expect(deps.orchestrator.runTool).not.toHaveBeenCalled();
  });

  it('allows marketing role', async () => {
    const deps = makeDeps({ role: 'marketing' });
    await handleFileShared({
      event: { channel_id: 'D1', user_id: 'U1', file_id: 'F1' },
      deps: deps as any,
    });
    expect(deps.orchestrator.runTool).toHaveBeenCalled();
  });

  it('rejects non-CSV files', async () => {
    const deps = makeDeps({
      filesInfoResult: {
        ok: true,
        file: { id: 'F1', filetype: 'png', mimetype: 'image/png', size: 100, url_private_download: '', name: 'a.png' },
      },
    });
    await handleFileShared({
      event: { channel_id: 'D1', user_id: 'U1', file_id: 'F1' },
      deps: deps as any,
    });
    expect(deps.orchestrator.runTool).not.toHaveBeenCalled();
  });

  it('rejects files >1 MB with helpful message', async () => {
    const deps = makeDeps({
      filesInfoResult: {
        ok: true,
        file: { id: 'F1', filetype: 'csv', mimetype: 'text/csv', size: 2_000_000, url_private_download: 'x', name: 'big.csv' },
      },
    });
    await handleFileShared({
      event: { channel_id: 'D1', user_id: 'U1', file_id: 'F1' },
      deps: deps as any,
    });
    expect(deps.orchestrator.runTool).not.toHaveBeenCalled();
    expect(deps.slack.postMessage).toHaveBeenCalledWith('D1', expect.stringContaining('max'), undefined);
  });

  it('reports CSV parse failure', async () => {
    const deps = makeDeps({
      downloadFile: vi.fn().mockResolvedValue(Buffer.from('this is not csv\nheader-not-found')),
    });
    deps.orchestrator.runTool = vi.fn();
    await handleFileShared({
      event: { channel_id: 'D1', user_id: 'U1', file_id: 'F1' },
      deps: deps as any,
    });
    expect(deps.orchestrator.runTool).not.toHaveBeenCalled();
    const args = (deps.slack.postMessage as any).mock.calls.map((c: any[]) => c[1]).join(' | ');
    expect(args).toMatch(/parse|email column|header/i);
  });

  it('handles download failure with retry-friendly message', async () => {
    const deps = makeDeps({
      downloadFile: vi.fn().mockRejectedValue(new Error('HTTP 403')),
    });
    deps.orchestrator.runTool = vi.fn();
    await handleFileShared({
      event: { channel_id: 'D1', user_id: 'U1', file_id: 'F1' },
      deps: deps as any,
    });
    expect(deps.orchestrator.runTool).not.toHaveBeenCalled();
    expect(deps.slack.postMessage).toHaveBeenCalledWith('D1', expect.stringContaining("download"), undefined);
  });
});
