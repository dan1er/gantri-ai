import { parsePhoneNumberWithError, type CountryCode } from 'libphonenumber-js';

/**
 * Normalize a free-text phone string to E.164 (e.g., "+14155550100").
 * Returns null if the string can't be parsed as a valid phone in `defaultCountry`
 * (or as a fully-qualified international number when no country is provided).
 */
export function normalizeToE164(input: string, defaultCountry: CountryCode = 'US'): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const parsed = parsePhoneNumberWithError(trimmed, defaultCountry);
    if (!parsed.isValid()) return null;
    return parsed.number;
  } catch {
    return null;
  }
}
