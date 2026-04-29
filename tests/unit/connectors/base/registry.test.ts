import { describe, it, expect } from 'vitest';
import { unstringifyJsonObjects } from '../../../../src/connectors/base/registry.js';

/**
 * Unit tests for `unstringifyJsonObjects` — the registry-level preprocess that
 * recursively JSON-parses any string arg whose trimmed contents look like an
 * object or array. Defends against the LLM occasionally serializing nested
 * tool args (notably `dateRange`) as JSON-encoded strings instead of real
 * objects, which would otherwise trip every union branch on the receiving
 * Zod schema.
 *
 * Regression: feedback 18994b97 — Impact tools rejected
 *   `dateRange: '{"startDate":"2026-01-01","endDate":"2026-01-31"}'`
 * because Zod doesn't auto-parse strings.
 */
describe('unstringifyJsonObjects', () => {
  it('passes a plain object through unchanged', () => {
    const input = { a: 1, b: 'hello', c: { nested: true } };
    expect(unstringifyJsonObjects(input)).toEqual(input);
  });

  it('passes a non-JSON string through unchanged', () => {
    expect(unstringifyJsonObjects('last_30_days')).toBe('last_30_days');
    expect(unstringifyJsonObjects('hello world')).toBe('hello world');
  });

  it('parses a string that IS a valid JSON object', () => {
    const input = '{"startDate":"2026-01-01","endDate":"2026-01-31"}';
    expect(unstringifyJsonObjects(input)).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    });
  });

  it('parses a string that IS a valid JSON array', () => {
    const input = '[1, 2, "three"]';
    expect(unstringifyJsonObjects(input)).toEqual([1, 2, 'three']);
  });

  it('recursively unstringifies a nested object with stringified-object values', () => {
    const input = {
      dateRange: '{"startDate":"2026-01-01","endDate":"2026-01-31"}',
      breakdown: '{"key":"Platform","values":["Google Ads"]}',
      limit: 50,
    };
    expect(unstringifyJsonObjects(input)).toEqual({
      dateRange: { startDate: '2026-01-01', endDate: '2026-01-31' },
      breakdown: { key: 'Platform', values: ['Google Ads'] },
      limit: 50,
    });
  });

  it('returns numeric-string primitives untouched (only objects/arrays parse)', () => {
    expect(unstringifyJsonObjects('123')).toBe('123');
    expect(unstringifyJsonObjects('3.14')).toBe('3.14');
  });

  it('returns boolean-shaped strings untouched', () => {
    expect(unstringifyJsonObjects('true')).toBe('true');
    expect(unstringifyJsonObjects('false')).toBe('false');
    expect(unstringifyJsonObjects('null')).toBe('null');
  });

  it('returns the original string when it starts with `{` but is invalid JSON', () => {
    const input = '{not really json}';
    expect(unstringifyJsonObjects(input)).toBe(input);
  });

  it('returns the original string when it starts with `[` but is invalid JSON', () => {
    const input = '[oops, not json]';
    expect(unstringifyJsonObjects(input)).toBe(input);
  });

  it("top-level args object: dateRange string → parsed object (Lana's regression)", () => {
    const args = {
      dateRange: '{"startDate":"2026-01-01","endDate":"2026-01-31"}',
      state: 'ALL',
      sortBy: 'revenue',
      limit: 50,
    };
    expect(unstringifyJsonObjects(args)).toEqual({
      dateRange: { startDate: '2026-01-01', endDate: '2026-01-31' },
      state: 'ALL',
      sortBy: 'revenue',
      limit: 50,
    });
  });

  it('handles deeply nested arrays of stringified objects', () => {
    const input = {
      filters: ['{"key":"a"}', '{"key":"b"}'],
    };
    expect(unstringifyJsonObjects(input)).toEqual({
      filters: [{ key: 'a' }, { key: 'b' }],
    });
  });

  it('handles whitespace-padded JSON strings', () => {
    expect(unstringifyJsonObjects('  {"a": 1}  ')).toEqual({ a: 1 });
  });

  it('preserves null and undefined', () => {
    expect(unstringifyJsonObjects(null)).toBeNull();
    expect(unstringifyJsonObjects(undefined)).toBeUndefined();
  });

  it('preserves number and boolean primitives', () => {
    expect(unstringifyJsonObjects(42)).toBe(42);
    expect(unstringifyJsonObjects(true)).toBe(true);
  });
});
