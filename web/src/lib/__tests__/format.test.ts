import { describe, it, expect } from 'vitest';
import { fmt } from '../format.js';

describe('fmt', () => {
  it('currency formats with USD + two decimals', () => {
    expect(fmt(1234.5, 'currency')).toBe('$1,234.50');
  });
  it('percent multiplies by 100 and adds %', () => {
    expect(fmt(0.123, 'percent')).toBe('12.30%');
  });
  it('number adds thousand separators', () => {
    expect(fmt(1234567, 'number')).toBe('1,234,567');
  });
  it('returns "—" for null/undefined', () => {
    expect(fmt(null, 'number')).toBe('—');
    expect(fmt(undefined, 'currency')).toBe('—');
  });
  it('passes through strings', () => {
    expect(fmt('hello', 'number')).toBe('hello');
  });
});
