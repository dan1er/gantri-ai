/**
 * Resolves a dotted/bracketed path against a data root and returns the value
 * at that path, or `undefined` if any segment is missing.
 *
 *   "rev.rows[0].rev"  → root.rev.rows[0].rev
 *   "orders.daily"     → root.orders.daily   (array)
 *   "rev"              → root.rev            (object)
 *
 * No expressions, no math, no transforms. Pure read.
 */
export function resolveValueRef(ref: string, root: Record<string, unknown>): unknown {
  if (!ref || typeof ref !== 'string') return undefined;
  const segments = ref.split('.');
  if (segments.some((s) => s === '')) return undefined;
  let cur: unknown = root;
  for (const raw of segments) {
    const m = raw.match(/^([^[\]]+)((?:\[\d+\])*)$/);
    if (!m) return undefined;
    const key = m[1];
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
    const indexes = m[2].match(/\[(\d+)\]/g) ?? [];
    for (const idxStr of indexes) {
      const idx = Number(idxStr.slice(1, -1));
      if (!Array.isArray(cur)) return undefined;
      cur = cur[idx];
    }
  }
  return cur;
}
