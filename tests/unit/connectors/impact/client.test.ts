import { describe, it, expect } from 'vitest';
import { chunkDateRangeByDays } from '../../../../src/connectors/impact/client.js';

/**
 * Impact's `/Actions` endpoint rejects windows >45 days with a 400. The
 * client chunks longer ranges automatically; this test pins that behavior so
 * future refactors don't silently regress to single-call mode.
 */
describe('chunkDateRangeByDays', () => {
  it('returns a single slice when range fits', () => {
    expect(chunkDateRangeByDays('2026-04-01', '2026-04-30', 45))
      .toEqual([{ startDate: '2026-04-01', endDate: '2026-04-30' }]);
  });

  it('splits a 60-day range into two ≤45-day slices that cover everything contiguously', () => {
    const slices = chunkDateRangeByDays('2026-01-01', '2026-03-01', 45);
    expect(slices).toHaveLength(2);
    expect(slices[0]).toEqual({ startDate: '2026-01-01', endDate: '2026-02-14' });
    expect(slices[1].startDate).toBe('2026-02-15');
    expect(slices[1].endDate).toBe('2026-03-01');
  });

  it('splits a year into 9 slices (≤45 days each)', () => {
    const slices = chunkDateRangeByDays('2025-01-01', '2025-12-31', 45);
    expect(slices.length).toBeGreaterThanOrEqual(9);
    // contiguity: every next slice starts the day after previous ends
    for (let i = 1; i < slices.length; i++) {
      const prevEnd = new Date(slices[i - 1].endDate + 'T00:00:00Z');
      const thisStart = new Date(slices[i].startDate + 'T00:00:00Z');
      expect(thisStart.getTime() - prevEnd.getTime()).toBe(86_400_000);
    }
    // boundaries
    expect(slices[0].startDate).toBe('2025-01-01');
    expect(slices[slices.length - 1].endDate).toBe('2025-12-31');
  });

  it('handles a single-day range', () => {
    expect(chunkDateRangeByDays('2026-04-15', '2026-04-15', 45))
      .toEqual([{ startDate: '2026-04-15', endDate: '2026-04-15' }]);
  });
});
