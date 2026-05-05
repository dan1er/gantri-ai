import { z } from 'zod';
import { normalizeToE164 } from './phone.js';

export interface RawProfile {
  rowIndex: number;
  email: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  consent_source?: string;
  consented_at?: string;
}

export interface ValidProfile extends RawProfile {
  email: string; // lowercased
  phone_e164?: string;
}

export interface InvalidProfile {
  rowIndex: number;
  email?: string;
  reason: string;
}

export interface ValidationResult {
  valid: ValidProfile[];
  invalid: InvalidProfile[];
}

const EmailSchema = z.string().email();

export function validateBatch(rows: RawProfile[], opts: { channels: Array<'email' | 'sms'> }): ValidationResult {
  const seen = new Map<string, number>();
  const valid: ValidProfile[] = [];
  const invalid: InvalidProfile[] = [];
  const requireSms = opts.channels.includes('sms');

  for (const row of rows) {
    const errs: string[] = [];
    let lower: string | null = null;
    if (!row.email) {
      errs.push('missing email');
    } else if (!EmailSchema.safeParse(row.email).success) {
      errs.push(`invalid email: ${row.email}`);
    } else {
      lower = row.email.toLowerCase();
      const prior = seen.get(lower);
      if (prior !== undefined) errs.push(`duplicate of row ${prior}`);
    }

    if (row.first_name && row.first_name.length > 100) errs.push('first_name >100 chars');
    if (row.last_name && row.last_name.length > 100) errs.push('last_name >100 chars');
    if (row.consent_source && row.consent_source.length > 200) errs.push('consent_source >200 chars');
    if (row.consented_at && Number.isNaN(Date.parse(row.consented_at))) errs.push('consented_at not ISO 8601');

    let phoneE164: string | undefined;
    if (row.phone) {
      const norm = normalizeToE164(row.phone);
      if (!norm) errs.push(`invalid phone: ${row.phone}`);
      else phoneE164 = norm;
    }
    if (requireSms && !phoneE164) errs.push('phone required when channels includes sms');

    if (errs.length > 0) {
      invalid.push({ rowIndex: row.rowIndex, email: row.email, reason: errs.join('; ') });
      continue;
    }

    seen.set(lower!, row.rowIndex);
    valid.push({
      ...row,
      email: lower!,
      phone_e164: phoneE164,
    });
  }

  return { valid, invalid };
}
