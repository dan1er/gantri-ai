import { describe, it, expect } from 'vitest';
import { resolveTimeRef } from '../../../src/reports/time-refs.js';
import type { ResolvedDateRange, ResolvedDateRangePair } from '../../../src/reports/plan-types.js';

const TZ = 'America/Los_Angeles';

describe('resolveTimeRef', () => {
  // Reference run time: 2026-04-25 14:23:00 UTC == 2026-04-25 07:23 PT (Saturday).
  const runAt = new Date('2026-04-25T14:23:00.000Z');

  it('today_pt yields the current PT day', () => {
    const r = resolveTimeRef({ $time: 'today_pt' }, runAt, TZ) as ResolvedDateRange;
    expect(r.startDate).toBe('2026-04-25');
    expect(r.endDate).toBe('2026-04-25');
  });

  it('yesterday_pt yields the prior PT day', () => {
    const r = resolveTimeRef({ $time: 'yesterday_pt' }, runAt, TZ) as ResolvedDateRange;
    expect(r.startDate).toBe('2026-04-24');
    expect(r.endDate).toBe('2026-04-24');
  });

  it('this_week_pt yields Mon..Sun of the current week', () => {
    const r = resolveTimeRef({ $time: 'this_week_pt' }, runAt, TZ) as ResolvedDateRange;
    expect(r.startDate).toBe('2026-04-20'); // Monday before
    expect(r.endDate).toBe('2026-04-26');   // Sunday
  });

  it('last_week_pt yields the prior Mon..Sun', () => {
    const r = resolveTimeRef({ $time: 'last_week_pt' }, runAt, TZ) as ResolvedDateRange;
    expect(r.startDate).toBe('2026-04-13');
    expect(r.endDate).toBe('2026-04-19');
  });

  it('this_month_pt yields the current calendar month', () => {
    const r = resolveTimeRef({ $time: 'this_month_pt' }, runAt, TZ) as ResolvedDateRange;
    expect(r.startDate).toBe('2026-04-01');
    expect(r.endDate).toBe('2026-04-30');
  });

  it('last_month_pt yields the prior calendar month', () => {
    const r = resolveTimeRef({ $time: 'last_month_pt' }, runAt, TZ) as ResolvedDateRange;
    expect(r.startDate).toBe('2026-03-01');
    expect(r.endDate).toBe('2026-03-31');
  });

  it('last_n_days_pt(7) yields the trailing 7-day window ending today', () => {
    const r = resolveTimeRef({ $time: 'last_n_days_pt', n: 7 }, runAt, TZ) as ResolvedDateRange;
    expect(r.startDate).toBe('2026-04-19');
    expect(r.endDate).toBe('2026-04-25');
  });

  it('wow_compare_pt yields a pair of ranges (current week + previous week)', () => {
    const r = resolveTimeRef({ $time: 'wow_compare_pt' }, runAt, TZ) as ResolvedDateRangePair;
    expect(r.current.startDate).toBe('2026-04-20');
    expect(r.current.endDate).toBe('2026-04-26');
    expect(r.previous.startDate).toBe('2026-04-13');
    expect(r.previous.endDate).toBe('2026-04-19');
  });

  it('returns the from/to ms boundaries that cover the PT day in UTC', () => {
    const r = resolveTimeRef({ $time: 'today_pt' }, runAt, TZ) as ResolvedDateRange;
    // PT day 2026-04-25 = 2026-04-25T07:00:00Z .. 2026-04-26T06:59:59.999Z
    expect(new Date(r.fromMs).toISOString()).toBe('2026-04-25T07:00:00.000Z');
    expect(new Date(r.toMs).toISOString()).toBe('2026-04-26T06:59:59.999Z');
  });
});
