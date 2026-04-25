import { describe, it, expect } from 'vitest';
import {
  decideCacheStrategy,
  canonicalKey,
  type CachePolicy,
} from '../../../../src/connectors/base/cache-policy.js';

const TZ = 'America/Los_Angeles';
// Pretend "now" is 2026-04-25 (PT). Anything ending before 2026-03-26 is
// "fully closed" given a 30-day settle window.
const NOW = new Date('2026-04-25T15:00:00.000Z');

describe('decideCacheStrategy', () => {
  const porterPolicy: CachePolicy = {
    version: 1,
    settleDays: 30,
    openTtlSec: 60,
    dateRangePath: 'dateRange',
  };

  it('returns frozen for a fully closed range', () => {
    const args = { dateRange: { startDate: '2025-01-01', endDate: '2025-12-31' } };
    const d = decideCacheStrategy('gantri.order_stats', porterPolicy, args, NOW, TZ);
    expect(d.mode).toBe('frozen');
    expect(d.key).toBeTruthy();
  });

  it('returns ttl for a partially-open range (this month)', () => {
    const args = { dateRange: { startDate: '2026-04-01', endDate: '2026-04-30' } };
    const d = decideCacheStrategy('gantri.order_stats', porterPolicy, args, NOW, TZ);
    expect(d.mode).toBe('ttl');
    expect(d.ttlSec).toBe(60);
  });

  it('returns skip when openTtlSec is 0 and range is open', () => {
    const policy = { ...porterPolicy, openTtlSec: 0 };
    const args = { dateRange: { startDate: '2026-04-01', endDate: '2026-04-30' } };
    const d = decideCacheStrategy('gantri.order_stats', policy, args, NOW, TZ);
    expect(d.mode).toBe('skip');
  });

  it('treats endDate exactly at the settle boundary as still-open (conservative)', () => {
    // 2026-04-25 - 30d = 2026-03-26. endDate of 2026-03-26 is NOT past the boundary.
    const args = { dateRange: { startDate: '2026-03-01', endDate: '2026-03-26' } };
    const d = decideCacheStrategy('gantri.order_stats', porterPolicy, args, NOW, TZ);
    expect(d.mode).toBe('ttl');
  });

  it('returns frozen one day past the boundary', () => {
    const args = { dateRange: { startDate: '2026-03-01', endDate: '2026-03-25' } };
    const d = decideCacheStrategy('gantri.order_stats', porterPolicy, args, NOW, TZ);
    expect(d.mode).toBe('frozen');
  });

  it('returns skip when policy has no dateRangePath', () => {
    const policy: CachePolicy = { version: 1, settleDays: 0, openTtlSec: 0 };
    const d = decideCacheStrategy('gantri.order_get', policy, { id: 53107 }, NOW, TZ);
    expect(d.mode).toBe('skip');
  });
});

describe('canonicalKey', () => {
  it('produces the same key regardless of object key order', () => {
    const a = canonicalKey('grafana.sql', { sql: 'SELECT 1', dateRange: { endDate: '2025-12-31', startDate: '2025-01-01' } }, 1);
    const b = canonicalKey('grafana.sql', { dateRange: { startDate: '2025-01-01', endDate: '2025-12-31' }, sql: 'SELECT 1' }, 1);
    expect(a).toBe(b);
  });

  it('changes when the version bumps', () => {
    const v1 = canonicalKey('x.y', { a: 1 }, 1);
    const v2 = canonicalKey('x.y', { a: 1 }, 2);
    expect(v1).not.toBe(v2);
  });

  it('collapses SQL whitespace', () => {
    const a = canonicalKey('grafana.sql', { sql: 'SELECT  1\nFROM t' }, 1);
    const b = canonicalKey('grafana.sql', { sql: 'SELECT 1 FROM t' }, 1);
    expect(a).toBe(b);
  });
});
