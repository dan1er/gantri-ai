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

// Header aliases — incoming names are lowercased + accent-stripped, then
// looked up here to produce a canonical English column name. Any header not
// in this map AND not already a canonical name is treated as unknown.
// Spanish variants cover Slack uploads that come from Spanish-localized
// spreadsheets (e.g. Numbers, Excel-ES). Add new locales here as needed.
const HEADER_ALIASES: Record<string, string> = {
  // email
  'correo': 'email',
  'correo electronico': 'email',
  'correo del usuario': 'email',
  'email del usuario': 'email',
  'e-mail': 'email',
  // first_name
  'nombre': 'first_name',
  'nombres': 'first_name',
  'primer nombre': 'first_name',
  'first name': 'first_name',
  // last_name
  'apellido': 'last_name',
  'apellidos': 'last_name',
  'last name': 'last_name',
  // phone
  'telefono': 'phone',
  'celular': 'phone',
  'movil': 'phone',
  'numero de telefono': 'phone',
  // consent_source
  'fuente': 'consent_source',
  'fuente de consentimiento': 'consent_source',
  // consented_at
  'fecha de consentimiento': 'consented_at',
  'consentido en': 'consented_at',
};

function canonicalizeHeader(rawHeader: string): string {
  // Lowercase + trim + strip diacritics so "Teléfono" / "TELEFONO" / "telefono"
  // all collide on the same alias key.
  const normalized = rawHeader
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
  if (ALLOWED_COLS.has(normalized) || IGNORED_COLS.has(normalized)) return normalized;
  return HEADER_ALIASES[normalized] ?? normalized;
}

export function parseCsv(text: string): ParseCsvResult {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const result = Papa.parse<Record<string, string>>(stripped, {
    header: true, skipEmptyLines: true, transformHeader: canonicalizeHeader,
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
