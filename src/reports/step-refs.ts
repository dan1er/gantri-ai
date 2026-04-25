import { isStepRef } from './plan-types.js';

/**
 * Walk a dot-and-bracket path (e.g. "rows[0].id") into an object/array tree.
 * Returns undefined if any segment is missing.
 */
export function getByPath(obj: unknown, path: string): unknown {
  // Tokenize: split on "." but keep "[N]" as separate tokens applied to prior key.
  const tokens = path.split('.').flatMap((seg) => {
    const out: Array<string | number> = [];
    let key = '';
    let i = 0;
    while (i < seg.length) {
      if (seg[i] === '[') {
        if (key) { out.push(key); key = ''; }
        const close = seg.indexOf(']', i);
        if (close < 0) return [];
        out.push(Number(seg.slice(i + 1, close)));
        i = close + 1;
      } else {
        key += seg[i];
        i++;
      }
    }
    if (key) out.push(key);
    return out;
  });
  let cur: any = obj;
  for (const t of tokens) {
    if (cur == null) return undefined;
    cur = cur[t as any];
  }
  return cur;
}

/**
 * Walk an args object and replace any { $ref: "alias.path" } token with the
 * value at that path inside `aliasMap`. Throws if a ref points to an alias
 * that isn't present, since that's a plan/data integrity bug worth surfacing.
 */
export function resolveStepRefs<T = unknown>(args: T, aliasMap: Record<string, unknown>): T {
  return walk(args) as T;

  function walk(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(walk);
    if (isStepRef(v)) {
      const path = v.$ref;
      const dot = path.indexOf('.');
      const alias = dot < 0 ? path : path.slice(0, dot);
      const rest = dot < 0 ? '' : path.slice(dot + 1);
      if (!(alias in aliasMap)) {
        throw new Error(`StepRef "${path}" points to a missing alias "${alias}"`);
      }
      const root = aliasMap[alias];
      return rest ? getByPath(root, rest) : root;
    }
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(vv);
      }
      return out;
    }
    return v;
  }
}
