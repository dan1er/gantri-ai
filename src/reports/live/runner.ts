import { logger } from '../../logger.js';
import { WHITELISTED_TOOLS, type LiveReportSpec, type UiBlock } from './spec.js';
import { substituteDateMacros } from './date-macros.js';
import { evaluateDerivedStep, isDerivedStep, type DerivedStep } from './derived-steps.js';

interface MinimalRegistry {
  execute(toolName: string, args: unknown): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
}

export interface LiveSpecRunResult {
  dataResults: Record<string, unknown>;
  ui: UiBlock[];
  errors: Array<{ stepId: string; tool: string; code: string; message: string }>;
  meta: {
    generatedAt: string;
    durationMs: number;
    sources: string[];
    spec: LiveReportSpec;
    effectiveRange: unknown;
    /** Concrete date range covered by the report on this render — derived
     *  from substituted args. The frontend renders it as a header subtitle so
     *  the viewer ALWAYS sees what period the numbers reflect, regardless of
     *  whether the spec is parametric ($REPORT_RANGE) or fixed ($DATE: macros). */
    effectivePeriod?: { startDate: string; endDate: string };
  };
}

/** Walk every leaf string in a value tree and extract YYYY-MM-DD dates. We
 *  use this to compute `effectivePeriod` from already-substituted step args:
 *  the union of every date string we find is the period the report covers. */
function collectDateStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) out.push(value);
    return;
  }
  if (Array.isArray(value)) { for (const v of value) collectDateStrings(v, out); return; }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectDateStrings(v, out);
  }
}

/**
 * Recursively substitutes the literal token "$REPORT_RANGE" in step args with
 * the actual effective range (a preset string or { start, end } object).
 */
function substituteReportRange(args: Record<string, unknown>, effectiveRange: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === '$REPORT_RANGE') out[k] = effectiveRange;
    else if (Array.isArray(v)) out[k] = v.map((x) => x === '$REPORT_RANGE' ? effectiveRange : x);
    else if (v && typeof v === 'object') out[k] = substituteReportRange(v as Record<string, unknown>, effectiveRange);
    else out[k] = v;
  }
  return out;
}

/**
 * Runs every step in `spec.data` in parallel and returns a unified result with:
 *   - `dataResults`: { [stepId]: tool result data }
 *   - `ui`: passed through unchanged (frontend hydrates via valueRef)
 *   - `errors`: per-step failures (the report degrades gracefully)
 *   - `meta.sources`: distinct tool names used (for the footer)
 *
 * Steps that fail produce a row in `errors[]` but do NOT abort other steps.
 * The frontend renders blocks bound to a failed step as ErrorState.
 */
export async function runLiveSpec(spec: LiveReportSpec, registry: MinimalRegistry, effectiveRange?: unknown): Promise<LiveSpecRunResult> {
  // Tool steps are dispatched in parallel; derived steps run after, reading
  // from `dataResults`. We split them up front so the parallel section sees
  // tool steps only.
  const toolSteps = spec.data.filter((s) => !isDerivedStep(s));
  const derivedSteps = spec.data.filter((s) => isDerivedStep(s)) as unknown as DerivedStep[];

  for (const step of toolSteps) {
    const tool = (step as { tool: string }).tool;
    if (!WHITELISTED_TOOLS.has(tool)) {
      throw new Error(`Tool ${tool} is not whitelisted for live reports`);
    }
  }

  const range = effectiveRange ?? spec.dateRange ?? 'last_7_days';

  const startedAt = Date.now();
  // Single point-in-time anchor — all date macros across all steps in this
  // run resolve against the same `now`, so results are internally consistent.
  const now = new Date();
  // Collect every YYYY-MM-DD date that flows into any tool's args after
  // substitution; we'll aggregate at the end into `effectivePeriod`.
  const collectedDates: string[] = [];
  const results = await Promise.all(
    toolSteps.map(async (step) => {
      const s = step as { id: string; tool: string; args: Record<string, unknown> };
      const t0 = Date.now();
      try {
        const rangeSubbed = substituteReportRange(s.args, range);
        const stepArgs = substituteDateMacros(rangeSubbed, now);
        collectDateStrings(stepArgs, collectedDates);
        const r = await registry.execute(s.tool, stepArgs);
        if (!r.ok) {
          logger.warn({ stepId: s.id, tool: s.tool, code: r.error?.code, ms: Date.now() - t0 }, 'live-report step failed');
          return { stepId: s.id, tool: s.tool, ok: false as const, error: r.error ?? { code: 'UNKNOWN', message: 'no detail' } };
        }
        return { stepId: s.id, tool: s.tool, ok: true as const, data: r.data };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ stepId: s.id, tool: s.tool, err: message, ms: Date.now() - t0 }, 'live-report step threw');
        return { stepId: s.id, tool: s.tool, ok: false as const, error: { code: 'THREW', message } };
      }
    }),
  );

  const dataResults: Record<string, unknown> = {};
  const errors: LiveSpecRunResult['errors'] = [];
  for (const r of results) {
    if (r.ok) dataResults[r.stepId] = r.data;
    else errors.push({ stepId: r.stepId, tool: r.tool, code: r.error.code, message: r.error.message });
  }

  // Derived steps run sequentially after tool steps. Failures degrade the
  // single derived value (NaN/null) but never abort the run.
  for (const dstep of derivedSteps) {
    try {
      const value = evaluateDerivedStep(dstep, dataResults);
      dataResults[dstep.id] = value;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ stepId: dstep.id, op: dstep.op, err: message }, 'derived step failed');
      errors.push({ stepId: dstep.id, tool: `derived:${dstep.op}`, code: 'DERIVED_FAILED', message });
    }
  }

  // Most tools also include a `period: { startDate, endDate }` (or similar)
  // in their result. Pulling dates from there means presets like
  // `last_14_days` (which collectDateStrings can't parse from args) still
  // produce a valid `effectivePeriod` so the header subtitle is never empty.
  collectDateStrings(dataResults, collectedDates);
  const sources = [...new Set(toolSteps.map((s) => (s as { tool: string }).tool))].sort();
  const sortedDates = [...new Set(collectedDates)].sort();
  const effectivePeriod = sortedDates.length > 0
    ? { startDate: sortedDates[0], endDate: sortedDates[sortedDates.length - 1] }
    : undefined;
  return {
    dataResults,
    ui: spec.ui,
    errors,
    meta: {
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      sources,
      spec,
      effectiveRange: range,
      effectivePeriod,
    },
  };
}
