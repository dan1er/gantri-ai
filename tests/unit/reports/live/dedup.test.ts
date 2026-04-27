import { describe, it, expect } from 'vitest';
import { extractKeywords, scoreSimilarity } from '../../../../src/reports/live/dedup.js';

describe('extractKeywords', () => {
  it('lowercases, dedupes, strips stopwords', () => {
    expect(extractKeywords('Weekly Sales Report by Channel for the team')).toEqual(
      expect.arrayContaining(['weekly', 'sales', 'report', 'channel']),
    );
  });
  it('preserves multi-language tokens', () => {
    const k = extractKeywords('Reporte de ventas por canal');
    expect(k).toEqual(expect.arrayContaining(['reporte', 'ventas', 'canal']));
  });
  it('drops short tokens (<3 chars)', () => {
    expect(extractKeywords('a b cc dd ee')).not.toContain('a');
    expect(extractKeywords('a b cc dd ee')).toContain('cc');
  });
});

describe('scoreSimilarity', () => {
  it('returns the count of shared keywords', () => {
    expect(scoreSimilarity(['a', 'b', 'c'], ['b', 'c', 'd'])).toBe(2);
  });
  it('handles empty arrays', () => {
    expect(scoreSimilarity([], ['a'])).toBe(0);
    expect(scoreSimilarity(['a'], [])).toBe(0);
  });
});
