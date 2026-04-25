import { describe, it, expect } from 'vitest';
import { isValidCron, computeNextFireAt } from '../../../src/reports/cron-utils.js';

describe('cron-utils', () => {
  describe('isValidCron', () => {
    it('accepts standard 5-field expressions', () => {
      expect(isValidCron('* * * * *')).toBe(true);
      expect(isValidCron('*/5 * * * *')).toBe(true);
      expect(isValidCron('0 9 * * 1-5')).toBe(true);
      expect(isValidCron('30 */2 * * *')).toBe(true);
    });
    it('rejects malformed expressions', () => {
      expect(isValidCron('not a cron')).toBe(false);
      expect(isValidCron('60 * * * *')).toBe(false);          // minute > 59
      expect(isValidCron('* * * *')).toBe(false);             // 4 fields
      expect(isValidCron('')).toBe(false);
    });
  });

  describe('computeNextFireAt', () => {
    it('computes the next minute-boundary fire in the requested timezone', () => {
      // 2026-04-25 14:23:00 UTC == 2026-04-25 07:23:00 PT
      const after = new Date('2026-04-25T14:23:00.000Z');
      // "Daily 9am PT" -> next fire is 2026-04-25 16:00:00 UTC (= 09:00 PT)
      const next = computeNextFireAt('0 9 * * *', 'America/Los_Angeles', after);
      expect(next.toISOString()).toBe('2026-04-25T16:00:00.000Z');
    });

    it('handles "every 5 minutes"', () => {
      const after = new Date('2026-04-25T14:23:00.000Z');
      const next = computeNextFireAt('*/5 * * * *', 'America/Los_Angeles', after);
      // Next */5 boundary after 14:23 UTC is 14:25 UTC.
      expect(next.toISOString()).toBe('2026-04-25T14:25:00.000Z');
    });

    it('handles "every Monday 7am PT" across week boundaries', () => {
      // 2026-04-25 is a Saturday; next Monday at 7am PT is 2026-04-27 14:00 UTC.
      const after = new Date('2026-04-25T14:23:00.000Z');
      const next = computeNextFireAt('0 7 * * 1', 'America/Los_Angeles', after);
      expect(next.toISOString()).toBe('2026-04-27T14:00:00.000Z');
    });

    it('throws on an invalid cron', () => {
      expect(() => computeNextFireAt('garbage', 'America/Los_Angeles', new Date()))
        .toThrow();
    });
  });
});
