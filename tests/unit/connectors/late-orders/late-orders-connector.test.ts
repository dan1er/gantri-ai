import { describe, it, expect } from 'vitest';
import { derivePrimaryCause, computeBuckets } from '../../../../src/connectors/late-orders/late-orders-connector.js';

describe('derivePrimaryCause', () => {
  it('prefers attention over rework', () => {
    expect(derivePrimaryCause({ attentionCount: 1, reworkCount: 5, lateJobCount: 0, exceededCount: 0, causes: [] })).toBe('Has attention');
  });
  it('prefers rework over exceeded', () => {
    expect(derivePrimaryCause({ attentionCount: 0, reworkCount: 2, lateJobCount: 0, exceededCount: 3, causes: [] })).toBe('Rework');
  });
  it('falls through to causes when no flags', () => {
    expect(derivePrimaryCause({ attentionCount: 0, reworkCount: 0, lateJobCount: 0, exceededCount: 0, causes: ['Material out'] })).toBe('Material out');
  });
  it('returns Unknown when nothing is flagged', () => {
    expect(derivePrimaryCause({ attentionCount: 0, reworkCount: 0, lateJobCount: 0, exceededCount: 0, causes: [] })).toBe('Unknown');
  });
});

describe('computeBuckets', () => {
  const sample = (daysLate: number, primaryCause: string, type: string) => ({
    id: 1, type, status: 'Processed', customerName: 'X', organizationId: null,
    shipsAt: null, daysLate, totalDollars: 100, jobCount: 0,
    attentionCount: 0, reworkCount: 0, lateJobCount: 0, exceededCount: 0,
    primaryCause, flaggedJobs: [], causes: [], adminLink: 'x',
  });
  it('buckets days-late into the right ranges', () => {
    const r = computeBuckets([sample(2, 'A', 'Order'), sample(5, 'A', 'Order'), sample(10, 'B', 'Wholesale'), sample(20, 'B', 'Order')]);
    expect(r.byDaysLate).toEqual({ '0-3': 1, '4-7': 1, '8-14': 1, '15+': 1 });
    expect(r.byPrimaryCause).toEqual({ A: 2, B: 2 });
    expect(r.byType).toEqual({ Order: 3, Wholesale: 1 });
  });
});
