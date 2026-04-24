import { describe, it, expect, vi } from 'vitest';
import { createDmHandler } from '../../../src/slack/handlers.js';

function makeContext(isAuthorized: boolean) {
  const runSpy = vi.fn(async () => ({
    response: 'You spent $700.',
    model: 'claude-sonnet-4-6',
    toolCalls: [],
    tokensInput: 100,
    tokensOutput: 10,
    iterations: 1,
  }));
  const insertSpy = vi.fn(async () => 'conv-1');
  const loadSpy = vi.fn(async () => []);
  const postMessage = vi.fn(async () => ({ ts: '1234.5678' }));
  const update = vi.fn(async () => ({}));
  return {
    spies: { runSpy, insertSpy, postMessage, update, loadSpy },
    deps: {
      orchestrator: { run: runSpy },
      usersRepo: { isAuthorized: vi.fn(async () => isAuthorized) },
      conversationsRepo: { insert: insertSpy, loadRecentByThread: loadSpy },
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
    client: { chat: { postMessage, update } } as any,
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

  it('ignores events from the bot itself (no bot_id loops)', async () => {
    const ctx = makeContext(true);
    const handler = createDmHandler(ctx.deps as any);
    const e = { ...ctx.event, bot_id: 'B1' };
    await handler({ event: e as any, client: ctx.client, say: ctx.say } as any);
    expect(ctx.spies.postMessage).not.toHaveBeenCalled();
  });
});
