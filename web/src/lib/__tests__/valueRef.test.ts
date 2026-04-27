import { describe, it, expect } from 'vitest';
import { resolveRef } from '../valueRef.js';

const root = { a: { rows: [{ x: 1 }, { x: 2 }], total: 99 } };

describe('resolveRef (frontend)', () => {
  it('navigates dotted paths', () => {
    expect(resolveRef('a.total', root)).toBe(99);
  });
  it('indexes arrays', () => {
    expect(resolveRef('a.rows[1].x', root)).toBe(2);
  });
  it('returns undefined for missing', () => {
    expect(resolveRef('a.nope', root)).toBeUndefined();
  });
});
