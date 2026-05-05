import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCsv } from '../../../../src/connectors/klaviyo/csv-parser.js';

const FIX = 'tests/fixtures/klaviyo-imports';

describe('parseCsv', () => {
  it('parses a clean 3-row CSV', () => {
    const r = parseCsv(readFileSync(`${FIX}/valid-3-rows.csv`, 'utf8'));
    expect(r.rows.length).toBe(3);
    expect(r.rows[0].email).toBe('alice@x.com');
    expect(r.rows[0].phone).toBe('+1 415 555 0100');
    expect(r.warnings).toEqual([]);
  });

  it('parses a BOM-prefixed CSV cleanly', () => {
    const r = parseCsv(readFileSync(`${FIX}/invalid-bom.csv`, 'utf8'));
    expect(r.rows.length).toBe(2);
    expect(r.rows[0].email).toBe('alice@x.com');
  });

  it('emits a warning for legacy consent_* columns', () => {
    const r = parseCsv(readFileSync(`${FIX}/legacy-with-consent-cols.csv`, 'utf8'));
    expect(r.warnings.some((w) => w.includes('consent_email'))).toBe(true);
    expect(r.rows[0]).not.toHaveProperty('consent_email');
  });

  it('throws when email column is missing', () => {
    expect(() => parseCsv('name,phone\nbob,415-555-0100')).toThrow(/email/i);
  });

  it('throws when over the 1000-row cap', () => {
    expect(() => parseCsv(readFileSync(`${FIX}/valid-1001-rows.csv`, 'utf8'))).toThrow(/max is 1000/);
  });
});
