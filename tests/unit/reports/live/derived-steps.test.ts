import { describe, it, expect } from 'vitest';
import { evaluateDerivedStep, isDerivedStep, type DerivedStep } from '../../../../src/reports/live/derived-steps.js';

const dataResults = {
  this_week: { totals: { fullTotal: 1200, orders: 24 } },
  last_week: { totals: { fullTotal: 1000, orders: 20 } },
  zero_baseline: { totals: { fullTotal: 0 } },
  string_metric: { totals: { fullTotal: '482.115493' } },
};

const step = (op: DerivedStep['op'], a: string, b: string): DerivedStep => ({ id: 'x', kind: 'derived', op, a, b });

describe('isDerivedStep', () => {
  it('detects derived steps by kind', () => {
    expect(isDerivedStep({ kind: 'derived' })).toBe(true);
    expect(isDerivedStep({ kind: 'tool' })).toBe(false);
    expect(isDerivedStep({ tool: 'foo' })).toBe(false);
    expect(isDerivedStep(null)).toBe(false);
  });
});

describe('evaluateDerivedStep', () => {
  it('add', () => {
    expect(evaluateDerivedStep(step('add', 'this_week.totals.fullTotal', 'last_week.totals.fullTotal'), dataResults)).toBe(2200);
  });
  it('subtract', () => {
    expect(evaluateDerivedStep(step('subtract', 'this_week.totals.fullTotal', 'last_week.totals.fullTotal'), dataResults)).toBe(200);
  });
  it('multiply', () => {
    expect(evaluateDerivedStep(step('multiply', 'this_week.totals.orders', 'last_week.totals.orders'), dataResults)).toBe(480);
  });
  it('divide', () => {
    expect(evaluateDerivedStep(step('divide', 'this_week.totals.fullTotal', 'last_week.totals.fullTotal'), dataResults)).toBe(1.2);
  });
  it('pct_change returns fractional change', () => {
    expect(evaluateDerivedStep(step('pct_change', 'this_week.totals.fullTotal', 'last_week.totals.fullTotal'), dataResults)).toBeCloseTo(0.2, 6);
  });
  it('coerces stringified numeric refs (NB-style "482.115493")', () => {
    const r = evaluateDerivedStep(step('add', 'string_metric.totals.fullTotal', 'last_week.totals.fullTotal'), dataResults);
    expect(r).toBeCloseTo(1482.115493, 5);
  });
  it('throws on divide by zero', () => {
    expect(() => evaluateDerivedStep(step('divide', 'this_week.totals.fullTotal', 'zero_baseline.totals.fullTotal'), dataResults)).toThrow(/divide by zero/);
  });
  it('throws on pct_change with zero baseline (would be infinite)', () => {
    expect(() => evaluateDerivedStep(step('pct_change', 'this_week.totals.fullTotal', 'zero_baseline.totals.fullTotal'), dataResults)).toThrow(/zero baseline/);
  });
  it('throws when a ref does not resolve to a number', () => {
    expect(() => evaluateDerivedStep(step('add', 'this_week.totals', 'last_week.totals'), dataResults)).toThrow(/did not resolve to a number/);
    expect(() => evaluateDerivedStep(step('add', 'missing.path', 'last_week.totals.fullTotal'), dataResults)).toThrow(/did not resolve to a number/);
  });
});
