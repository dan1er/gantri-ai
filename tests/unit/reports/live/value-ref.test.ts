import { describe, it, expect } from 'vitest';
import { resolveValueRef } from '../../../../src/reports/live/value-ref.js';

const fixture = {
  rev: { rows: [{ rev: 1234.5, channel: 'Google' }, { rev: 999, channel: 'Meta' }], totals: { rev: 2233.5 } },
  orders: { count: 87, daily: [{ date: '2026-04-25', count: 12 }, { date: '2026-04-26', count: 14 }] },
};

describe('resolveValueRef', () => {
  it('returns top-level scalar', () => {
    expect(resolveValueRef('orders.count', fixture)).toBe(87);
  });
  it('navigates nested objects', () => {
    expect(resolveValueRef('rev.totals.rev', fixture)).toBe(2233.5);
  });
  it('returns whole arrays', () => {
    expect(resolveValueRef('orders.daily', fixture)).toEqual(fixture.orders.daily);
  });
  it('indexes into arrays with [n]', () => {
    expect(resolveValueRef('rev.rows[0].rev', fixture)).toBe(1234.5);
    expect(resolveValueRef('rev.rows[1].channel', fixture)).toBe('Meta');
  });
  it('returns undefined for missing keys', () => {
    expect(resolveValueRef('nope.x', fixture)).toBeUndefined();
    expect(resolveValueRef('rev.rows[5].rev', fixture)).toBeUndefined();
  });
  it('returns undefined for unparseable refs', () => {
    expect(resolveValueRef('', fixture)).toBeUndefined();
    expect(resolveValueRef('rev..x', fixture)).toBeUndefined();
  });
});
