import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  callClaudeWithResilience,
  AnthropicCapacityExhausted,
  isTransientError,
} from '../../../src/llm/resilient-claude.js';

// Minimal stand-in for Anthropic.Message — only the fields the orchestrator
// touches matter for resilience-helper tests.
function fakeMessage(model = 'm') {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    model,
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  } as any;
}

/** Build an Anthropic-shaped error with a numeric .status, like the SDK
 *  throws for HTTP failures (APIError exposes `status`). */
function httpError(status: number, msg = 'transient'): Error & { status: number } {
  const e = new Error(msg) as Error & { status: number };
  e.status = status;
  return e;
}

function fakeClaude(handler: (params: any) => Promise<any>) {
  return {
    messages: {
      create: vi.fn(handler),
    },
  } as any;
}

const baseParams = {
  max_tokens: 32,
  messages: [{ role: 'user' as const, content: 'hi' }],
};

describe('callClaudeWithResilience', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns response on the first attempt when the SDK succeeds', async () => {
    const claude = fakeClaude(async () => fakeMessage('claude-sonnet-4-6'));
    const result = await callClaudeWithResilience(
      { claude, model: 'claude-sonnet-4-6', fallbackModels: ['claude-haiku-4-5'] },
      baseParams,
    );
    expect(result.modelUsed).toBe('claude-sonnet-4-6');
    expect(result.attemptsUsed).toBe(1);
    expect(result.failedOver).toBe(false);
    expect(claude.messages.create).toHaveBeenCalledTimes(1);
  });

  it('retries on a transient 529 and succeeds on the second attempt', async () => {
    let calls = 0;
    const claude = fakeClaude(async () => {
      calls++;
      if (calls === 1) throw httpError(529, 'overloaded_error');
      return fakeMessage('claude-sonnet-4-6');
    });

    const promise = callClaudeWithResilience(
      { claude, model: 'claude-sonnet-4-6', fallbackModels: ['claude-haiku-4-5'] },
      baseParams,
    );

    // First attempt fails, then we sleep ~1000ms before the second attempt.
    await vi.advanceTimersByTimeAsync(1500);

    const result = await promise;
    expect(result.modelUsed).toBe('claude-sonnet-4-6');
    expect(result.attemptsUsed).toBe(2);
    expect(result.failedOver).toBe(false);
    expect(claude.messages.create).toHaveBeenCalledTimes(2);
  });

  it('exhausts primary retries then succeeds on the fallback model', async () => {
    let calls = 0;
    let lastModel: string | undefined;
    const claude = fakeClaude(async (params: any) => {
      calls++;
      lastModel = params.model;
      // First 3 attempts (primary, Sonnet) -> 529. 4th (fallback, Haiku) -> ok.
      if (calls <= 3) throw httpError(529, 'overloaded_error');
      return fakeMessage(params.model);
    });

    const promise = callClaudeWithResilience(
      {
        claude,
        model: 'claude-sonnet-4-6',
        fallbackModels: ['claude-haiku-4-5'],
        // Big budget so the 1s + 3s waits between retries comfortably fit.
        totalBudgetMs: 60_000,
      },
      baseParams,
    );

    // Drain backoff waits (1s + 3s + small jitter) + the no-op gap before
    // failover, plus headroom.
    await vi.advanceTimersByTimeAsync(10_000);

    const result = await promise;
    expect(result.failedOver).toBe(true);
    expect(result.modelUsed).toBe('claude-haiku-4-5');
    expect(result.attemptsUsed).toBe(4);
    expect(lastModel).toBe('claude-haiku-4-5');
  });

  it('throws AnthropicCapacityExhausted when primary + fallback both exhaust', async () => {
    const claude = fakeClaude(async () => {
      throw httpError(529, 'overloaded_error');
    });

    const promise = callClaudeWithResilience(
      {
        claude,
        model: 'claude-sonnet-4-6',
        fallbackModels: ['claude-haiku-4-5'],
        totalBudgetMs: 60_000,
      },
      baseParams,
    );
    // Detach the rejection from microtask sync so timer advances can run first.
    const settled = promise.catch((e) => e);

    await vi.advanceTimersByTimeAsync(60_000);

    const err = await settled;
    expect(err).toBeInstanceOf(AnthropicCapacityExhausted);
    const cap = err as AnthropicCapacityExhausted;
    // 3 attempts on primary + 3 attempts on fallback = 6.
    expect(cap.attempts).toHaveLength(6);
    expect(cap.attempts.filter((a) => a.model === 'claude-sonnet-4-6')).toHaveLength(3);
    expect(cap.attempts.filter((a) => a.model === 'claude-haiku-4-5')).toHaveLength(3);
  });

  it('does not retry on a non-transient validation error (400)', async () => {
    const claude = fakeClaude(async () => {
      throw httpError(400, 'invalid request');
    });
    await expect(
      callClaudeWithResilience(
        { claude, model: 'claude-sonnet-4-6', fallbackModels: ['claude-haiku-4-5'] },
        baseParams,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(claude.messages.create).toHaveBeenCalledTimes(1);
  });

  it('stops trying once the total wall-clock budget is exhausted', async () => {
    // Each call "takes" 1500ms of fake time, then throws 529. With a 2000ms
    // budget, the helper should bail after attempt 2 at the latest (no time
    // left for a third primary retry, no time left to start the fallback).
    const claude = fakeClaude(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
      throw httpError(529, 'overloaded_error');
    });

    const promise = callClaudeWithResilience(
      {
        claude,
        model: 'claude-sonnet-4-6',
        fallbackModels: ['claude-haiku-4-5'],
        totalBudgetMs: 2000,
      },
      baseParams,
    );
    const settled = promise.catch((e) => e);

    await vi.advanceTimersByTimeAsync(10_000);

    const err = await settled;
    expect(err).toBeInstanceOf(AnthropicCapacityExhausted);
    // Should have stopped well before the 6-attempt full budget.
    expect((err as AnthropicCapacityExhausted).attempts.length).toBeLessThan(6);
  });
});

describe('isTransientError', () => {
  it.each([429, 502, 503, 504, 529])('treats HTTP %i as transient', (status) => {
    expect(isTransientError(httpError(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])('treats HTTP %i as non-transient', (status) => {
    expect(isTransientError(httpError(status))).toBe(false);
  });

  it('treats network errors by code as transient', () => {
    expect(isTransientError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransientError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))).toBe(true);
  });

  it('treats socket hang up errors as transient', () => {
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
  });

  it('treats Anthropic APIConnectionError names as transient', () => {
    expect(isTransientError(Object.assign(new Error('x'), { name: 'APIConnectionError' }))).toBe(true);
  });
});
