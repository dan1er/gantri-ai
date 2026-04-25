import { createHash } from 'node:crypto';

/** Per-tool caching policy. Read by CachingRegistry on every execute(). */
export interface CachePolicy {
  /** Bump on breaking arg/output shape changes to orphan stale cache rows. */
  version: number;
  /** Days after a date range closes before the result is considered final.
   *  0 = trust immediately. 3 = Northbeam attribution settling. 30 = Porter refunds. */
  settleDays: number;
  /** TTL (sec) when the range overlaps "today minus settleDays" or later. 0 = skip caching the open case. */
  openTtlSec: number;
  /** Dot-path inside args to the {startDate, endDate} object. Omit for tools without a date range (we always skip). */
  dateRangePath?: string;
}

export interface CacheDecision {
  mode: 'frozen' | 'ttl' | 'skip';
  key?: string;
  ttlSec?: number;
}

/** Compute a deterministic cache key for a tool call. */
export function canonicalKey(tool: string, args: unknown, version: number): string {
  const canonical = canonicalize(args);
  const payload = JSON.stringify({ tool, version, args: canonical });
  return createHash('sha256').update(payload).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  if (typeof value === 'string') {
    // Collapse internal whitespace for SQL-like fields.
    return value.replace(/\s+/g, ' ').trim();
  }
  return value;
}

/**
 * Decide whether to cache a tool call as frozen, TTL, or skip entirely.
 * `now` is injected for testability; in production it should be `new Date()`.
 */
export function decideCacheStrategy(
  toolName: string,
  policy: CachePolicy,
  args: unknown,
  now: Date,
  timezone: string,
): CacheDecision {
  if (!policy.dateRangePath) return { mode: 'skip' };
  const range = readByPath(args, policy.dateRangePath) as
    | { startDate?: string; endDate?: string }
    | undefined;
  if (!range || typeof range.endDate !== 'string') {
    return policy.openTtlSec > 0
      ? { mode: 'ttl', key: canonicalKey(toolName, args, policy.version), ttlSec: policy.openTtlSec }
      : { mode: 'skip' };
  }
  const todayPt = pacificDay(now, timezone);
  const boundary = addDays(todayPt, -policy.settleDays);
  // strictly less than: a range ending exactly at the boundary is still considered "open" (conservative).
  if (range.endDate < boundary) {
    return {
      mode: 'frozen',
      key: canonicalKey(toolName, args, policy.version),
    };
  }
  if (policy.openTtlSec > 0) {
    return {
      mode: 'ttl',
      key: canonicalKey(toolName, args, policy.version),
      ttlSec: policy.openTtlSec,
    };
  }
  return { mode: 'skip' };
}

function readByPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function pacificDay(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
