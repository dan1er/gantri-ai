import { describe, it, expect } from 'vitest';
import { slugifyTitle, generateAccessToken, findFreeSlug } from '../../../../src/reports/live/identifiers.js';

describe('slugifyTitle', () => {
  it('lowercases + hyphenates ASCII', () => {
    expect(slugifyTitle('Weekly Sales Report')).toBe('weekly-sales-report');
  });
  it('strips diacritics', () => {
    expect(slugifyTitle('ROAS por canál')).toBe('roas-por-canal');
  });
  it('drops punctuation', () => {
    expect(slugifyTitle("Today's Top 10 — A Snapshot!")).toBe('todays-top-10-a-snapshot');
  });
  it('caps at 60 chars', () => {
    const long = 'a'.repeat(80);
    expect(slugifyTitle(long).length).toBeLessThanOrEqual(60);
  });
  it('falls back when input is non-ASCII-only', () => {
    expect(slugifyTitle('!!!')).toMatch(/^report-/);
  });
});

describe('generateAccessToken', () => {
  it('returns 32 url-safe chars', () => {
    const t = generateAccessToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});

describe('findFreeSlug', () => {
  it('returns the base slug if not taken', async () => {
    const out = await findFreeSlug('weekly-sales', async () => false);
    expect(out).toBe('weekly-sales');
  });
  it('appends -2 if base is taken', async () => {
    const taken = new Set(['weekly-sales']);
    const out = await findFreeSlug('weekly-sales', async (s) => taken.has(s));
    expect(out).toBe('weekly-sales-2');
  });
  it('keeps incrementing past collisions', async () => {
    const taken = new Set(['s', 's-2', 's-3']);
    const out = await findFreeSlug('s', async (slug) => taken.has(slug));
    expect(out).toBe('s-4');
  });
});
