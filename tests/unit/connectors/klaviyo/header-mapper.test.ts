import { describe, it, expect, vi } from 'vitest';
import { validateAndMapForKlaviyo } from '../../../../src/connectors/klaviyo/header-mapper.js';
import type { RawCsvParseResult } from '../../../../src/connectors/klaviyo/csv-parser.js';

function fakeClaude(jsonText: string) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text: jsonText }],
      })) as any,
    },
  };
}

const SPANISH_PARSED: RawCsvParseResult = {
  headers: ['correo del usuario', 'nombre', 'apellido', 'telefono'],
  rows: [
    { 'correo del usuario': 'alice@x.com', nombre: 'Alice', apellido: 'Anderson', telefono: '+1 415 555 0101' },
    { 'correo del usuario': 'bob@x.com', nombre: 'Bob', apellido: 'Brooks', telefono: '' },
    { 'correo del usuario': 'carol@x.com', nombre: 'Carol', apellido: '', telefono: '' },
  ],
  warnings: [],
};

describe('validateAndMapForKlaviyo', () => {
  it('maps Spanish headers to canonical schema using the LLM', async () => {
    const claude = fakeClaude(JSON.stringify({
      ok: true,
      mapping: {
        email: 'correo del usuario',
        first_name: 'nombre',
        last_name: 'apellido',
        phone: 'telefono',
        consent_source: null,
        consented_at: null,
      },
    }));
    const out = await validateAndMapForKlaviyo(SPANISH_PARSED, { claude });
    expect(out.rows).toHaveLength(3);
    expect(out.rows[0]).toEqual({
      rowIndex: 1,
      email: 'alice@x.com',
      first_name: 'Alice',
      last_name: 'Anderson',
      phone: '+1 415 555 0101',
    });
    expect(out.rows[1]).toEqual({
      rowIndex: 2,
      email: 'bob@x.com',
      first_name: 'Bob',
      last_name: 'Brooks',
      // phone empty in the row → omitted from canonical row
    });
    expect(out.rows[2]).toEqual({
      rowIndex: 3,
      email: 'carol@x.com',
      first_name: 'Carol',
    });
    expect(claude.messages.create).toHaveBeenCalledTimes(1);
  });

  it('throws with the LLM-provided reason when the CSV has no email column', async () => {
    const noEmail: RawCsvParseResult = {
      headers: ['nombre', 'telefono'],
      rows: [{ nombre: 'Alice', telefono: '+1 415 555 0101' }],
      warnings: [],
    };
    const claude = fakeClaude(JSON.stringify({
      ok: false,
      reason: 'Ningún campo del CSV parece contener correos electrónicos. Agrega una columna con direcciones de email.',
    }));
    await expect(validateAndMapForKlaviyo(noEmail, { claude })).rejects.toThrow(/correos electrónicos/);
  });

  it('throws when the CSV has zero rows', async () => {
    const empty: RawCsvParseResult = { headers: ['email'], rows: [], warnings: [] };
    const claude = fakeClaude('{}');
    await expect(validateAndMapForKlaviyo(empty, { claude })).rejects.toThrow(/empty/i);
    expect(claude.messages.create).not.toHaveBeenCalled();
  });

  it('throws when LLM returns malformed JSON', async () => {
    const claude = fakeClaude('I cannot map this CSV.');
    await expect(validateAndMapForKlaviyo(SPANISH_PARSED, { claude })).rejects.toThrow(/Couldn't validate/i);
  });

  it('throws when LLM returns JSON that violates the schema', async () => {
    const claude = fakeClaude(JSON.stringify({ ok: 'maybe' }));
    await expect(validateAndMapForKlaviyo(SPANISH_PARSED, { claude })).rejects.toThrow(/Couldn't validate/i);
  });

  it('tolerates LLM responses that wrap JSON in prose', async () => {
    // The mapper should pull the {…} substring out even if the LLM prepends a sentence.
    const claude = fakeClaude(
      'Sure! Here is the mapping you asked for:\n\n{"ok": true, "mapping": {"email": "correo del usuario", "first_name": "nombre", "last_name": "apellido", "phone": "telefono", "consent_source": null, "consented_at": null}}\n\nLet me know if you need anything else.',
    );
    const out = await validateAndMapForKlaviyo(SPANISH_PARSED, { claude });
    expect(out.rows).toHaveLength(3);
    expect(out.rows[0].email).toBe('alice@x.com');
  });

  it('warns when some rows have an empty mapped email and skips those rows', async () => {
    const partial: RawCsvParseResult = {
      headers: ['correo', 'nombre'],
      rows: [
        { correo: 'alice@x.com', nombre: 'Alice' },
        { correo: '', nombre: 'Bob' }, // skipped
        { correo: 'carol@x.com', nombre: 'Carol' },
      ],
      warnings: [],
    };
    const claude = fakeClaude(JSON.stringify({
      ok: true,
      mapping: { email: 'correo', first_name: 'nombre', last_name: null, phone: null, consent_source: null, consented_at: null },
    }));
    const out = await validateAndMapForKlaviyo(partial, { claude });
    expect(out.rows).toHaveLength(2);
    expect(out.rows.map((r) => r.email)).toEqual(['alice@x.com', 'carol@x.com']);
    expect(out.warnings.some((w) => w.includes('skipped'))).toBe(true);
  });

  it('throws when ALL rows have empty mapped email', async () => {
    const allEmpty: RawCsvParseResult = {
      headers: ['correo', 'nombre'],
      rows: [
        { correo: '', nombre: 'Alice' },
        { correo: '', nombre: 'Bob' },
      ],
      warnings: [],
    };
    const claude = fakeClaude(JSON.stringify({
      ok: true,
      mapping: { email: 'correo', first_name: 'nombre', last_name: null, phone: null, consent_source: null, consented_at: null },
    }));
    await expect(validateAndMapForKlaviyo(allEmpty, { claude })).rejects.toThrow(/empty in every row/i);
  });
});
