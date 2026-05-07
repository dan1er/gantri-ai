import Papa from 'papaparse';

/** Canonical row shape after the LLM header-mapping step. The downstream
 *  Klaviyo connector consumes this directly as `RawProfile` / `ImportProfileRow`. */
export interface ParsedCsvRow {
  rowIndex: number;
  email: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  consent_source?: string;
  consented_at?: string;
}

/** Raw parse output — no canonical mapping yet. The header-mapper step turns
 *  this into ParsedCsvRow[] using an LLM to interpret arbitrary header names. */
export interface RawCsvParseResult {
  /** Header names as they appeared in the file (lowercased + trimmed; not mapped). */
  headers: string[];
  /** Each row keyed by raw (lowercased + trimmed) header. */
  rows: Array<Record<string, string>>;
  /** Soft warnings (e.g. >0 zero-byte rows) — never blocking. */
  warnings: string[];
}

const MAX_ROWS = 1000;

/** Parse a CSV into raw headers + rows WITHOUT validating against a fixed
 *  schema. The header-mapper step (using an LLM) decides which raw header
 *  maps to Klaviyo's canonical columns; we don't hardcode aliases here so
 *  the parser is locale-agnostic. */
export function parseRawCsv(text: string): RawCsvParseResult {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const result = Papa.parse<Record<string, string>>(stripped, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  if (result.errors.length > 0) {
    const e = result.errors[0];
    throw new Error(`CSV parse error at row ${e.row}: ${e.message}`);
  }
  const headers = result.meta.fields ?? [];
  const rows = result.data.map((raw) => {
    const trimmed: Record<string, string> = {};
    for (const h of headers) {
      const v = raw[h];
      if (typeof v === 'string') trimmed[h] = v.trim();
    }
    return trimmed;
  });
  if (rows.length > MAX_ROWS) {
    throw new Error(`CSV has ${rows.length} rows; max is ${MAX_ROWS}. Split into smaller files.`);
  }
  return { headers, rows, warnings: [] };
}
