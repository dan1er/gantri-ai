import { describe, it, expect } from 'vitest';
import { derivePrimaryCause, deriveCauseSummary, computeBuckets } from '../../../../src/connectors/late-orders/late-orders-connector.js';

const empty = {
  failedJobCount: 0,
  cancelledJobCount: 0,
  reworkJobCount: 0,
  maxAttempt: 1,
  attentionCount: 0,
  lostPartCount: 0,
  failureModes: [] as string[],
};

describe('derivePrimaryCause', () => {
  it('lost parts beats everything else', () => {
    expect(derivePrimaryCause({ ...empty, lostPartCount: 2, attentionCount: 50, failedJobCount: 5 })).toBe('Part scrapped');
  });

  it('heavy rework (max attempt ≥ 3) wins over generic attention', () => {
    expect(derivePrimaryCause({ ...empty, maxAttempt: 4, attentionCount: 80 })).toBe('Reworked 4×');
  });

  it('failed jobs with a concrete mode surface that mode by name', () => {
    expect(derivePrimaryCause({ ...empty, failedJobCount: 3, failureModes: ['gunk', 'layer lines'] })).toBe('gunk');
  });

  it('falls back to needs attention when no harder signal', () => {
    expect(derivePrimaryCause({ ...empty, attentionCount: 50 })).toBe('Needs attention');
  });

  it('returns Unknown when nothing is set', () => {
    expect(derivePrimaryCause(empty)).toBe('Unknown');
  });
});

describe('deriveCauseSummary', () => {
  it('combines lost parts + failure modes', () => {
    const r = deriveCauseSummary({
      ...empty,
      lostPartCount: 3,
      failedJobCount: 12,
      failureModes: ['gunk', 'layer lines', 'cracking'],
      flagged: [],
    });
    expect(r).toBe('Part scrapped (3) — gunk, layer lines, cracking');
  });

  it('shows max attempt with concrete modes', () => {
    const r = deriveCauseSummary({
      ...empty,
      maxAttempt: 4,
      reworkJobCount: 5,
      failureModes: ['feature damage', 'cracking'],
      flagged: [],
    });
    expect(r).toBe('reworked 4× — feature damage, cracking');
  });

  it('falls back to Needs attention when nothing concrete', () => {
    const r = deriveCauseSummary({ ...empty, attentionCount: 78, flagged: [] });
    expect(r).toBe('Needs attention (78 jobs flagged)');
  });

  it('returns Unknown when truly bare', () => {
    const r = deriveCauseSummary({ ...empty, flagged: [] });
    expect(r).toBe('Unknown');
  });

  it('caps at 90 chars with ellipsis', () => {
    const r = deriveCauseSummary({
      ...empty,
      lostPartCount: 5,
      maxAttempt: 7,
      failureModes: ['really long failure mode description one', 'another exhaustively named failure mode', 'third extremely descriptive defect category'],
      flagged: [],
    });
    expect(r.length).toBeLessThanOrEqual(90);
    expect(r.endsWith('…')).toBe(true);
  });
});

describe('computeBuckets', () => {
  const sample = (
    daysLate: number,
    primaryCause: string,
    type: string,
    overrides: Partial<{ deliveryBy: string | null; daysPastDeliveryBy: number | null; deadlineMissed: boolean }> = {},
  ) => ({
    id: 1, type, status: 'Processed', customerName: 'X', organizationId: null,
    shipsAt: null,
    deliveryBy: overrides.deliveryBy ?? null,
    daysPastDeliveryBy: overrides.daysPastDeliveryBy ?? null,
    deadlineMissed: overrides.deadlineMissed ?? false,
    daysLate, totalDollars: 100,
    jobCount: 0, failedJobCount: 0, cancelledJobCount: 0, reworkJobCount: 0,
    maxAttempt: 1, lostPartCount: 0, attentionCount: 0, failureModes: [],
    primaryCause, causeSummary: primaryCause, flaggedJobs: [], adminLink: 'x',
  });
  it('buckets days-late into the right ranges', () => {
    const r = computeBuckets([sample(2, 'A', 'Order'), sample(5, 'A', 'Order'), sample(10, 'B', 'Wholesale'), sample(20, 'B', 'Order')]);
    expect(r.byDaysLate).toEqual({ '0-3': 1, '4-7': 1, '8-14': 1, '15+': 1 });
    expect(r.byPrimaryCause).toEqual({ A: 2, B: 2 });
    expect(r.byType).toEqual({ Order: 3, Wholesale: 1 });
    expect(r.byDeadline).toEqual({ customerDeadlineMissed: 0, withinCustomerWindow: 0, noCustomerDeadline: 4 });
  });
  it('counts deadline buckets', () => {
    const r = computeBuckets([
      sample(20, 'A', 'Order', { deliveryBy: '2026-04-01', daysPastDeliveryBy: 24, deadlineMissed: true }),
      sample(15, 'A', 'Order', { deliveryBy: '2026-04-01', daysPastDeliveryBy: 5, deadlineMissed: true }),
      sample(2, 'A', 'Order', { deliveryBy: '2026-05-15', daysPastDeliveryBy: null, deadlineMissed: false }),
      sample(2, 'A', 'Order'),
    ]);
    expect(r.byDeadline).toEqual({ customerDeadlineMissed: 2, withinCustomerWindow: 1, noCustomerDeadline: 1 });
  });
});

describe('derivePrimaryCause — deadline missed is not a cause', () => {
  it('returns the production cause even when the customer deadline was missed', () => {
    // Deadline missed is an outcome, not a cause. It is exposed via
    // `deadlineMissed` / `daysPastDeliveryBy` / `byDeadline` instead.
    expect(
      derivePrimaryCause({
        attentionCount: 50, reworkJobCount: 5, lostPartCount: 3,
        failedJobCount: 4, cancelledJobCount: 0, maxAttempt: 4,
        failureModes: ['gunk'], daysPastDeliveryBy: 7,
      }),
    ).toBe('Part scrapped');
  });

  it('falls back to rework / failure modes when no scrap, regardless of deadline', () => {
    expect(
      derivePrimaryCause({
        attentionCount: 0, reworkJobCount: 4, lostPartCount: 0,
        failedJobCount: 0, cancelledJobCount: 0, maxAttempt: 4,
        failureModes: [], daysPastDeliveryBy: 12,
      }),
    ).toBe('Reworked 4×');
  });
});
