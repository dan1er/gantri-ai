/**
 * Scalar arithmetic over already-resolved data step results.
 *
 * Spec authors declare a step like:
 *   { id: 'wow', kind: 'derived', op: 'pct_change',
 *     a: 'this_week.totals.fullTotal', b: 'last_week.totals.fullTotal' }
 *
 * The runner evaluates these AFTER all tool steps complete. The result is
 * stored at `dataResults[id]` and consumed by KPI / text blocks like any
 * other ref. No expression DSL — just declarative ops; keeps the eval
 * trivially auditable.
 */

import { resolveValueRef } from './value-ref.js';

export interface DerivedStep {
  id: string;
  kind: 'derived';
  op: 'add' | 'subtract' | 'multiply' | 'divide' | 'pct_change';
  a: string;
  b: string;
}

export function isDerivedStep(s: unknown): s is DerivedStep {
  return !!s && typeof s === 'object' && (s as { kind?: unknown }).kind === 'derived';
}

/** Coerce a resolved ref value to a finite number. NB metrics often arrive as
 *  numeric strings (e.g. "482.115493") — we accept those too. Throws if the
 *  ref didn't resolve to anything number-like. */
function toNumber(v: unknown, ref: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  throw new Error(`ref "${ref}" did not resolve to a number (got ${typeof v}: ${JSON.stringify(v)?.slice(0, 80)})`);
}

export function evaluateDerivedStep(step: DerivedStep, dataResults: Record<string, unknown>): number {
  const aRaw = resolveValueRef(step.a, dataResults);
  const bRaw = resolveValueRef(step.b, dataResults);
  const a = toNumber(aRaw, step.a);
  const b = toNumber(bRaw, step.b);
  switch (step.op) {
    case 'add': return a + b;
    case 'subtract': return a - b;
    case 'multiply': return a * b;
    case 'divide':
      if (b === 0) throw new Error(`divide by zero (b=${step.b})`);
      return a / b;
    case 'pct_change':
      if (b === 0) throw new Error(`pct_change with zero baseline (b=${step.b})`);
      return (a - b) / b;
    default: {
      const _exhaustive: never = step.op;
      throw new Error(`unknown derived op: ${String(_exhaustive)}`);
    }
  }
}
