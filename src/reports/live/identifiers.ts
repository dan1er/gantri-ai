import { customAlphabet } from 'nanoid';

const tokenAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const generateToken = customAlphabet(tokenAlphabet, 32);

export function generateAccessToken(): string {
  return generateToken();
}

/**
 * Title → URL-safe slug. ASCII-only, lowercase, hyphen-separated.
 * Strips diacritics, punctuation, collapses runs of `-`. Caps at 60 chars.
 * Falls back to a random short id when input has no slug-able chars.
 */
export function slugifyTitle(title: string): string {
  if (!title) return `report-${generateToken().slice(0, 8).toLowerCase()}`;
  const normalized = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 60)
    .replace(/-+$/, '');
  if (!normalized) return `report-${generateToken().slice(0, 8).toLowerCase()}`;
  return normalized;
}

/**
 * Returns a slug that doesn't collide. Calls `isTaken(slug)` for the base
 * first, then `slug-2`, `slug-3`, ... up to 50 tries.
 */
export async function findFreeSlug(base: string, isTaken: (slug: string) => Promise<boolean>): Promise<string> {
  if (!await isTaken(base)) return base;
  for (let n = 2; n <= 50; n++) {
    const candidate = `${base}-${n}`;
    if (!await isTaken(candidate)) return candidate;
  }
  return `${base}-${generateToken().slice(0, 6).toLowerCase()}`;
}
