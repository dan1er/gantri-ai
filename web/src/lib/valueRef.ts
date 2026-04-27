export function resolveRef(ref: string, root: unknown): unknown {
  if (!ref || typeof ref !== 'string') return undefined;
  const segments = ref.split('.');
  if (segments.some((s) => s === '')) return undefined;
  let cur: unknown = root;
  for (const raw of segments) {
    const m = raw.match(/^([^[\]]+)((?:\[\d+\])*)$/);
    if (!m) return undefined;
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[m[1]];
    const idxs = m[2].match(/\[(\d+)\]/g) ?? [];
    for (const idxStr of idxs) {
      const i = Number(idxStr.slice(1, -1));
      if (!Array.isArray(cur)) return undefined;
      cur = cur[i];
    }
  }
  return cur;
}
