import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseRawCsv } from '../../../../src/connectors/klaviyo/csv-parser.js';

const FIX = 'tests/fixtures/klaviyo-imports';

describe('parseRawCsv', () => {
  it('parses a clean 3-row CSV preserving raw headers', () => {
    const r = parseRawCsv(readFileSync(`${FIX}/valid-3-rows.csv`, 'utf8'));
    expect(r.rows.length).toBe(3);
    expect(r.headers).toContain('email');
    expect(r.rows[0].email).toBe('alice@x.com');
    expect(r.rows[0].phone).toBe('+1 415 555 0100');
    expect(r.warnings).toEqual([]);
  });

  it('parses a BOM-prefixed CSV cleanly', () => {
    const r = parseRawCsv(readFileSync(`${FIX}/invalid-bom.csv`, 'utf8'));
    expect(r.rows.length).toBe(2);
    expect(r.rows[0].email).toBe('alice@x.com');
  });

  it('preserves arbitrary header names without canonicalizing them', () => {
    // Spanish headers should round-trip exactly as the LLM mapper will see them.
    const csv = ['Correo del usuario,Nombre,Telefono', 'alice@x.com,Alice,415-555-0101'].join('\n');
    const r = parseRawCsv(csv);
    expect(r.headers).toEqual(['correo del usuario', 'nombre', 'telefono']);
    expect(r.rows[0]).toEqual({
      'correo del usuario': 'alice@x.com',
      nombre: 'Alice',
      telefono: '415-555-0101',
    });
  });

  it('does NOT enforce an email column at this layer (delegated to LLM mapper)', () => {
    // Previously this layer threw "CSV must have an email column". With LLM-driven
    // mapping the parser is locale-agnostic — the mapper decides feasibility.
    const r = parseRawCsv('name,phone\nbob,415-555-0100');
    expect(r.headers).toEqual(['name', 'phone']);
    expect(r.rows[0]).toEqual({ name: 'bob', phone: '415-555-0100' });
  });

  it('throws when over the 1000-row cap', () => {
    expect(() => parseRawCsv(readFileSync(`${FIX}/valid-1001-rows.csv`, 'utf8'))).toThrow(/max is 1000/);
  });
});
