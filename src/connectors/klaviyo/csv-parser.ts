import Papa from 'papaparse';

export interface ParsedCsvRow {
  rowIndex: number;
  email: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  consent_source?: string;
  consented_at?: string;
}

export interface ParseCsvResult {
  rows: ParsedCsvRow[];
  warnings: string[];
}

const ALLOWED_COLS = new Set(['email', 'first_name', 'last_name', 'phone', 'consent_source', 'consented_at']);
const IGNORED_COLS = new Set(['consent_email', 'consent_sms']);
const MAX_ROWS = 1000;

export function parseCsv(text: string): ParseCsvResult {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const result = Papa.parse<Record<string, string>>(stripped, {
    header: true, skipEmptyLines: true, transformHeader: (h) => h.trim().toLowerCase(),
  });
  if (result.errors.length > 0) {
    const e = result.errors[0];
    throw new Error(`CSV parse error at row ${e.row}: ${e.message}`);
  }
  const headers = result.meta.fields ?? [];
  if (!headers.includes('email')) {
    throw new Error('CSV must have an "email" column');
  }
  const warnings: string[] = [];
  const seenIgnored = headers.filter((h) => IGNORED_COLS.has(h));
  if (seenIgnored.length > 0) {
    warnings.push(`Ignored columns (channels are set on the call, not per-row): ${seenIgnored.join(', ')}`);
  }
  const unknownCols = headers.filter((h) => !ALLOWED_COLS.has(h) && !IGNORED_COLS.has(h));
  if (unknownCols.length > 0) {
    warnings.push(`Unknown columns ignored: ${unknownCols.join(', ')}`);
  }

  const rows: ParsedCsvRow[] = result.data.map((raw, i) => {
    const row: ParsedCsvRow = { rowIndex: i + 1, email: (raw.email ?? '').trim() };
    if (raw.first_name?.trim()) row.first_name = raw.first_name.trim();
    if (raw.last_name?.trim()) row.last_name = raw.last_name.trim();
    if (raw.phone?.trim()) row.phone = raw.phone.trim();
    if (raw.consent_source?.trim()) row.consent_source = raw.consent_source.trim();
    if (raw.consented_at?.trim()) row.consented_at = raw.consented_at.trim();
    return row;
  });

  if (rows.length > MAX_ROWS) {
    throw new Error(`CSV has ${rows.length} rows; max is ${MAX_ROWS}. Split into smaller files.`);
  }

  return { rows, warnings };
}
