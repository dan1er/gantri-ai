import type Anthropic from '@anthropic-ai/sdk';
import { logger } from '../logger.js';

/**
 * Resilient wrapper around `claude.messages.create(...)` that survives
 * transient Anthropic outages (especially 529 `overloaded_error`) by combining
 * three layers of defense:
 *
 *   1. Exponential-backoff retries per model on transient HTTP errors.
 *   2. Cross-pool model failover (e.g. Sonnet -> Haiku) when retries on the
 *      primary model are exhausted. Anthropic provisions capacity per model
 *      family, so a saturated Sonnet pool often coexists with a healthy
 *      Haiku pool.
 *   3. A total wall-clock budget that caps the whole resilience dance so a
 *      runaway retry storm never blocks a Slack handler past its useful TTL.
 *
 * On total exhaustion the helper throws `AnthropicCapacityExhausted` so the
 * Slack handler can recognize the case and post a friendly user-facing
 * message instead of a raw JSON error.
 */

export interface ResilientClaudeOpts {
  /** Anthropic SDK instance. */
  claude: Pick<Anthropic, 'messages'>;
  /** Primary model id. Required. */
  model: string;
  /** Fallback model ids tried in order if primary fails after retries. */
  fallbackModels?: string[];
  /** Max retry attempts per model. Default 3. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default 1000. */
  baseDelayMs?: number;
  /** Total wall-clock budget across all attempts + fallbacks. Default 15000 ms. */
  totalBudgetMs?: number;
}

export interface ResilientClaudeResult {
  response: Anthropic.Message;
  /** Model id that successfully produced the response. */
  modelUsed: string;
  /** Total attempts across all models (1 = first try succeeded). */
  attemptsUsed: number;
  /** True when we ended up using a fallback model instead of the primary. */
  failedOver: boolean;
}

export interface AttemptLogEntry {
  model: string;
  attempt: number;
  error: string;
}

/** Thrown when every model + retry combination has failed. The Slack
 *  handler catches this specific type to render the friendly Spanish
 *  message instead of the raw error. */
export class AnthropicCapacityExhausted extends Error {
  constructor(
    public readonly lastError: unknown,
    public readonly attempts: AttemptLogEntry[],
  ) {
    super(
      `Anthropic capacity exhausted after ${attempts.length} attempts across ` +
        `${new Set(attempts.map((a) => a.model)).size} model(s).`,
    );
    this.name = 'AnthropicCapacityExhausted';
  }
}

const TRANSIENT_HTTP_STATUSES = new Set<number>([429, 502, 503, 504, 529]);
const TRANSIENT_ERROR_CODES = new Set<string>([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'EPIPE',
]);

/** Classify an SDK error as transient (retry-worthy) or fatal. Anthropic's
 *  SDK exposes `APIError.status` for HTTP errors; network/abort errors
 *  surface as `APIConnectionError` / `APIUserAbortError` (status === undefined)
 *  and carry an underlying `code` from node's net stack. */
export function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: number; name?: string; code?: string; message?: string; cause?: { code?: string } };
  if (typeof e.status === 'number' && TRANSIENT_HTTP_STATUSES.has(e.status)) return true;
  if (e.name === 'AbortError' || e.name === 'APIUserAbortError') return true;
  if (e.name === 'APIConnectionError' || e.name === 'APIConnectionTimeoutError') return true;
  const code = e.code ?? e.cause?.code;
  if (typeof code === 'string' && TRANSIENT_ERROR_CODES.has(code)) return true;
  // socket hangup surfaces as a plain Error with that string and no status.
  if (typeof e.message === 'string' && /socket hang up/i.test(e.message)) return true;
  return false;
}

function describeError(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);
  const e = err as { status?: number; message?: string; name?: string };
  const parts: string[] = [];
  if (e.name) parts.push(e.name);
  if (typeof e.status === 'number') parts.push(`status=${e.status}`);
  if (e.message) parts.push(e.message);
  return parts.join(' | ') || 'unknown error';
}

/** Sleep for `ms` milliseconds. Pulled out so tests using fake timers can
 *  advance time deterministically via `vi.advanceTimersByTimeAsync`. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call `claude.messages.create(...)` with retries + model failover.
 *
 * @param opts Resilience configuration (models, retry budget, time budget).
 * @param messagesCreateParams Same shape you would pass to the raw SDK call,
 *   minus the `model` field (we override it per attempt). If you pass `model`
 *   it is ignored — `opts.model` / `opts.fallbackModels` win.
 */
export async function callClaudeWithResilience(
  opts: ResilientClaudeOpts,
  messagesCreateParams: Omit<Anthropic.MessageCreateParamsNonStreaming, 'model'> &
    Partial<Pick<Anthropic.MessageCreateParamsNonStreaming, 'model'>>,
): Promise<ResilientClaudeResult> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const totalBudgetMs = opts.totalBudgetMs ?? 15000;
  const startedAt = Date.now();
  const attempts: AttemptLogEntry[] = [];
  const models = [opts.model, ...(opts.fallbackModels ?? [])];

  let totalAttempts = 0;
  let lastError: unknown = null;

  for (let modelIdx = 0; modelIdx < models.length; modelIdx++) {
    const model = models[modelIdx];
    const isFallback = modelIdx > 0;
    if (isFallback) {
      logger.warn(
        { event: 'anthropic_failover', from: models[modelIdx - 1], to: model },
        'falling over to next Anthropic model',
      );
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // Hard ceiling: stop trying once the wall-clock budget is gone.
      if (Date.now() - startedAt >= totalBudgetMs) {
        logger.warn(
          { event: 'anthropic_budget_exhausted', model, attempt, elapsedMs: Date.now() - startedAt },
          'total budget exhausted before next attempt',
        );
        throw new AnthropicCapacityExhausted(lastError, attempts);
      }

      totalAttempts++;
      try {
        const response = await opts.claude.messages.create({
          ...messagesCreateParams,
          model,
        } as Anthropic.MessageCreateParamsNonStreaming);
        return {
          response,
          modelUsed: model,
          attemptsUsed: totalAttempts,
          failedOver: isFallback,
        };
      } catch (err) {
        lastError = err;
        const errDesc = describeError(err);
        const transient = isTransientError(err);
        attempts.push({ model, attempt, error: errDesc });

        if (!transient) {
          // Non-transient (e.g. 400 validation, 401 auth): bubble up
          // immediately. Retrying / failing over won't help.
          logger.warn(
            { event: 'anthropic_non_transient', model, attempt, error: errDesc },
            'non-transient Anthropic error, not retrying',
          );
          throw err;
        }

        const moreRetriesOnThisModel = attempt < maxRetries;
        const moreModels = modelIdx < models.length - 1;
        const willRetry = moreRetriesOnThisModel || moreModels;

        if (moreRetriesOnThisModel) {
          // Exponential backoff: 1s, 3s, 9s (with baseDelay=1000) + small jitter.
          const backoff = baseDelayMs * Math.pow(3, attempt - 1);
          const jitter = Math.floor(Math.random() * 200);
          const delayMs = backoff + jitter;

          // Respect the total budget — if waiting this long would blow it,
          // bail to the next model (or to exhaustion) instead of sleeping.
          const remainingBudget = totalBudgetMs - (Date.now() - startedAt);
          if (delayMs > remainingBudget) {
            logger.warn(
              {
                event: 'anthropic_retry',
                model,
                attempt,
                status: (err as { status?: number }).status,
                willRetry: moreModels,
                delayMs,
                skipReason: 'delay_exceeds_budget',
              },
              'skipping retry delay because it exceeds remaining budget',
            );
            break; // fall through to next model (or to throw at end of for-loop)
          }

          logger.warn(
            {
              event: 'anthropic_retry',
              model,
              attempt,
              status: (err as { status?: number }).status,
              willRetry,
              delayMs,
            },
            'transient Anthropic error, will retry',
          );
          await sleep(delayMs);
        } else {
          logger.warn(
            {
              event: 'anthropic_retry',
              model,
              attempt,
              status: (err as { status?: number }).status,
              willRetry: moreModels,
              delayMs: 0,
            },
            'retries on this model exhausted',
          );
        }
      }
    }
  }

  logger.error(
    { event: 'anthropic_exhausted', attempts },
    'Anthropic capacity exhausted across all models',
  );
  throw new AnthropicCapacityExhausted(lastError, attempts);
}
