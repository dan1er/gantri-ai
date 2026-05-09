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
      // Default no-op fakes so the existing tests don't have to care about
      // pending-context wiring; the dedicated tests below override these.
      pendingRepo: { lookupByThread: async () => null },
      klaviyoClient: { listLists: async () => [] },
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

  it('passes pendingContext to orchestrator.run when a klaviyo_csv_pending row exists in the thread', async () => {
    const orchestratorRun = vi.fn(async () => ({
      response: 'ok',
      model: 'claude-sonnet-4-6',
      toolCalls: [],
      tokensInput: 0,
      tokensOutput: 0,
      iterations: 1,
      attachments: [],
    }));
    const lookupByThread = vi.fn(async () => ({
      id: 'pid_1',
      callerSlackId: 'U1',
      channelId: 'C1',
      threadTs: 'C1',
      kind: 'klaviyo_csv_pending',
      payload: { profiles: [{ email: 'a@x.com' }, { email: 'b@x.com' }], filename: 'leads.csv', storagePath: null, channels: ['email'] },
    }));
    const listLists = vi.fn(async () => [
      { id: 'L_TRADE', name: 'Trade Show Leads' },
      { id: 'L_PRUEBA', name: 'lista de prueba' },
    ]);
    const tryHandle = vi.fn(async () => false); // not a cancel, defer to orchestrator

    const handler = createDmHandler({
      orchestrator: { run: orchestratorRun } as any,
      usersRepo: { isAuthorized: async () => true } as any,
      conversationsRepo: { loadRecentByThread: async () => [], insert: async () => 'conv-1' } as any,
      confirmationHandler: { tryHandle } as any,
      pendingRepo: { lookupByThread } as any,
      klaviyoClient: { listLists } as any,
    });

    const fakeClient = {
      chat: {
        postMessage: vi.fn(async () => ({ ts: '1.000' })),
        update: vi.fn(async () => ({})),
      },
    };
    await handler({
      event: { channel_type: 'im', user: 'U1', channel: 'C1', text: 'lista de prueba', ts: '1.000' },
      client: fakeClient,
    });

    expect(orchestratorRun).toHaveBeenCalled();
    const runArgs = orchestratorRun.mock.calls[0][0] as any;
    expect(runArgs.pendingContext).toMatchObject({
      kind: 'klaviyo_csv_pending',
      filename: 'leads.csv',
      rowCount: 2,
      channels: ['email'],
      availableLists: expect.arrayContaining([
        expect.objectContaining({ id: 'L_PRUEBA', name: 'lista de prueba' }),
      ]),
    });
  });

  it('omits pendingContext and skips listLists when no pending row exists', async () => {
    const orchestratorRun = vi.fn(async () => ({
      response: 'ok', model: 'claude-sonnet-4-6', toolCalls: [],
      tokensInput: 0, tokensOutput: 0, iterations: 1, attachments: [],
    }));
    const listLists = vi.fn(async () => []);
    const handler = createDmHandler({
      orchestrator: { run: orchestratorRun } as any,
      usersRepo: { isAuthorized: async () => true } as any,
      conversationsRepo: { loadRecentByThread: async () => [], insert: async () => 'conv-1' } as any,
      confirmationHandler: { tryHandle: async () => false } as any,
      pendingRepo: { lookupByThread: async () => null } as any,
      klaviyoClient: { listLists } as any,
    });
    const fakeClient = {
      chat: { postMessage: vi.fn(async () => ({ ts: '1.000' })), update: vi.fn(async () => ({})) },
    };
    await handler({ event: { channel_type: 'im', user: 'U1', channel: 'C1', text: 'hi', ts: '1.000' }, client: fakeClient });
    const runArgs = orchestratorRun.mock.calls[0][0] as any;
    expect(runArgs.pendingContext).toBeUndefined();
    // Lock in the "no spurious Klaviyo API call on every DM" invariant.
    expect(listLists).not.toHaveBeenCalled();
  });

  it('falls back to empty availableLists when klaviyoClient.listLists() throws', async () => {
    const orchestratorRun = vi.fn(async () => ({
      response: 'ok', model: 'claude-sonnet-4-6', toolCalls: [],
      tokensInput: 0, tokensOutput: 0, iterations: 1, attachments: [],
    }));
    const lookupByThread = vi.fn(async () => ({
      id: 'pid_1', callerSlackId: 'U1', channelId: 'C1', threadTs: 'C1',
      kind: 'klaviyo_csv_pending',
      payload: { profiles: [{ email: 'a@x.com' }], filename: 'leads.csv', storagePath: null, channels: ['email'] },
    }));
    const listLists = vi.fn(async () => { throw new Error('Klaviyo down'); });
    const handler = createDmHandler({
      orchestrator: { run: orchestratorRun } as any,
      usersRepo: { isAuthorized: async () => true } as any,
      conversationsRepo: { loadRecentByThread: async () => [], insert: async () => 'conv-1' } as any,
      confirmationHandler: { tryHandle: async () => false } as any,
      pendingRepo: { lookupByThread } as any,
      klaviyoClient: { listLists } as any,
    });
    const fakeClient = {
      chat: { postMessage: vi.fn(async () => ({ ts: '1.000' })), update: vi.fn(async () => ({})) },
    };
    await handler({ event: { channel_type: 'im', user: 'U1', channel: 'C1', text: 'lista de prueba', ts: '1.000' }, client: fakeClient });
    const runArgs = orchestratorRun.mock.calls[0][0] as any;
    expect(runArgs.pendingContext.availableLists).toEqual([]);
  });
});

describe('handleFileShared', () => {
  function makeDeps(opts: any = {}) {
    // Default fake Anthropic that maps a 2-row "email,first_name" CSV. Tests
    // can override `claudeResponse` to script different mapper outcomes.
    const defaultMapping = JSON.stringify({
      ok: true,
      mapping: { email: 'email', first_name: 'first_name', last_name: null, phone: null, consent_source: null, consented_at: null },
    });
    const claude = {
      messages: {
        create: vi.fn(async () => ({
          content: [{ type: 'text', text: opts.claudeResponse ?? defaultMapping }],
        })) as any,
      },
    };
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
      pendingRepo: {
        insert: vi.fn().mockResolvedValue({ id: 'p1', confirmationToken: 'tok-csv-1' }),
      },
      claude,
    };
  }

  it('happy path: DM + admin + CSV → stages pending row + asks for list (does NOT auto-import)', async () => {
    const deps = makeDeps();
    await handleFileShared({
      event: { channel_id: 'D1', user_id: 'U1', file_id: 'F1' },
      deps: deps as any,
    });
    // Bug fix: Klaviyo's bulk-subscribe silently drops profiles when no list is
    // attached. The handler now stages the parsed rows in pending_confirmations
    // and asks the user which list, instead of auto-submitting.
    expect(deps.orchestrator.runTool).not.toHaveBeenCalled();
    expect(deps.pendingRepo.insert).toHaveBeenCalledWith(expect.objectContaining({
      callerSlackId: 'U1',
      channelId: 'D1',
      kind: 'klaviyo_csv_pending',
      payload: expect.objectContaining({
        filename: 'leads.csv',
        profiles: expect.any(Array),
        storagePath: 'klaviyo-imports/F1-123.csv',
        channels: ['email'],
      }),
    }));
    expect(deps.slack.postMessage).toHaveBeenCalled();
    const replyText = (deps.slack.postMessage as any).mock.calls[0][1];
    expect(replyText).toContain('leads.csv');
    expect(replyText).toMatch(/which.*list/i);
    expect(replyText).toContain('tok-csv-1');
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

  // Regression: when the bot uploads a canvas/CSV as part of an analytics
  // reply, Slack fires a file_shared event with user_id = the bot's own
  // user_id. Without this filter, that event hit the role check and surfaced
  // a misleading "requires admin or marketing role" reply to the human user.
  it('drops events triggered by the bot itself (canvas/CSV self-uploads)', async () => {
    const deps = makeDeps();
    await handleFileShared({
      event: { channel_id: 'D1', user_id: 'U_BOT', file_id: 'F1' },
      deps: { ...deps, botUserId: 'U_BOT' } as any,
    });
    expect(deps.usersRepo.getRole).not.toHaveBeenCalled();
    expect(deps.slack.postMessage).not.toHaveBeenCalled();
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

  it('allows marketing role (stages pending CSV, asks for list)', async () => {
    const deps = makeDeps({ role: 'marketing' });
    await handleFileShared({
      event: { channel_id: 'D1', user_id: 'U1', file_id: 'F1' },
      deps: deps as any,
    });
    expect(deps.pendingRepo.insert).toHaveBeenCalled();
    expect(deps.orchestrator.runTool).not.toHaveBeenCalled();
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

  it('reports the LLM mapper reason when the CSV has no email-like column', async () => {
    const deps = makeDeps({
      downloadFile: vi.fn().mockResolvedValue(Buffer.from('name,phone\nAlice,415-555-0101')),
      claudeResponse: JSON.stringify({
        ok: false,
        reason: 'No header in this CSV looks like an email column.',
      }),
    });
    deps.orchestrator.runTool = vi.fn();
    await handleFileShared({
      event: { channel_id: 'D1', user_id: 'U1', file_id: 'F1' },
      deps: deps as any,
    });
    expect(deps.pendingRepo.insert).not.toHaveBeenCalled();
    expect(deps.slack.postMessage).toHaveBeenCalledWith(
      'D1',
      expect.stringContaining('No header in this CSV looks like an email column.'),
      undefined,
    );
  });

  it('accepts CSVs whose headers are in another language (Spanish via LLM mapping)', async () => {
    const deps = makeDeps({
      downloadFile: vi.fn().mockResolvedValue(Buffer.from(
        'Correo del usuario,Nombre,Telefono\nalice@x.com,Alice,+1 415 555 0101\nbob@x.com,Bob,',
      )),
      claudeResponse: JSON.stringify({
        ok: true,
        mapping: {
          email: 'correo del usuario',
          first_name: 'nombre',
          last_name: null,
          phone: 'telefono',
          consent_source: null,
          consented_at: null,
        },
      }),
    });
    await handleFileShared({
      event: { channel_id: 'D1', user_id: 'U1', file_id: 'F1' },
      deps: deps as any,
    });
    expect(deps.pendingRepo.insert).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'klaviyo_csv_pending',
      payload: expect.objectContaining({
        profiles: [
          expect.objectContaining({ email: 'alice@x.com', first_name: 'Alice', phone: '+1 415 555 0101' }),
          expect.objectContaining({ email: 'bob@x.com', first_name: 'Bob' }),
        ],
      }),
    }));
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
