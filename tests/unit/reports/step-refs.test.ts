import { describe, it, expect } from 'vitest';
import { resolveStepRefs, getByPath } from '../../../src/reports/step-refs.js';

describe('getByPath', () => {
  const obj = {
    rows: [{ id: 7, name: 'foo' }, { id: 9, name: 'bar' }],
    nested: { count: 42 },
  };
  it('walks dotted paths', () => {
    expect(getByPath(obj, 'nested.count')).toBe(42);
  });
  it('walks array indices', () => {
    expect(getByPath(obj, 'rows[0].id')).toBe(7);
    expect(getByPath(obj, 'rows[1].name')).toBe('bar');
  });
  it('returns undefined for missing paths', () => {
    expect(getByPath(obj, 'missing.key')).toBeUndefined();
    expect(getByPath(obj, 'rows[10]')).toBeUndefined();
  });
});

describe('resolveStepRefs', () => {
  const aliasMap = {
    late: { rows: [{ id: 53107 }, { id: 50000 }] },
    spend: { total: 12345 },
  };

  it('replaces { $ref: "alias.path" } tokens recursively', () => {
    const args = {
      id: { $ref: 'late.rows[0].id' },
      meta: { spend: { $ref: 'spend.total' }, label: 'plain' },
      ids: [{ $ref: 'late.rows[0].id' }, { $ref: 'late.rows[1].id' }],
    };
    expect(resolveStepRefs(args, aliasMap)).toEqual({
      id: 53107,
      meta: { spend: 12345, label: 'plain' },
      ids: [53107, 50000],
    });
  });

  it('throws on unknown alias', () => {
    expect(() =>
      resolveStepRefs({ x: { $ref: 'missing.thing' } }, aliasMap),
    ).toThrow(/missing/);
  });

  it('passes through plain values', () => {
    expect(resolveStepRefs({ a: 1, b: 'two', c: null }, aliasMap)).toEqual({ a: 1, b: 'two', c: null });
  });
});
