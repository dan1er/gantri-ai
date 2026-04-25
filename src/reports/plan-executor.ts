import type { ConnectorRegistry } from '../connectors/base/registry.js';
import type {
  ReportPlan,
  PlanStep,
  ResolvedDateRangePair,
} from './plan-types.js';
import { isTimeRef, isResolvedRangePair } from './plan-types.js';
import { resolveTimeRef } from './time-refs.js';
import { resolveStepRefs } from './step-refs.js';
import { renderOutput, type RenderedAttachment } from './block-renderer.js';
import { logger } from '../logger.js';

export interface ExecutePlanOptions {
  plan: ReportPlan;
  registry: ConnectorRegistry;
  runAt: Date;
  timezone: string;
}

export interface ExecutePlanResult {
  status: 'ok' | 'partial' | 'error';
  text: string;
  attachments: RenderedAttachment[];
  errors: Array<{ alias: string; message: string }>;
  aliasMap: Record<string, unknown>;
}

/**
 * Execute a ReportPlan and return the rendered Slack content. Independent
 * steps run in parallel; steps with dependsOn or unresolved StepRefs run
 * only after their dependencies complete. A single failed step produces a
 * "partial" status; results from other steps are still rendered.
 */
export async function executePlan(opts: ExecutePlanOptions): Promise<ExecutePlanResult> {
  const { plan, registry, runAt, timezone } = opts;
  const aliasMap: Record<string, unknown> = {};
  const errors: Array<{ alias: string; message: string }> = [];

  const remaining = new Map<string, PlanStep>(plan.steps.map((s) => [s.alias, s]));
  const completed = new Set<string>();
  const failed = new Set<string>();

  while (remaining.size > 0) {
    const ready: PlanStep[] = [];
    for (const step of remaining.values()) {
      const deps = step.dependsOn ?? [];
      if (deps.every((d) => completed.has(d) || failed.has(d))) {
        if (deps.some((d) => failed.has(d))) {
          remaining.delete(step.alias);
          failed.add(step.alias);
          errors.push({ alias: step.alias, message: `skipped: dependency failed` });
          continue;
        }
        ready.push(step);
      }
    }
    if (ready.length === 0) {
      for (const step of remaining.values()) {
        errors.push({ alias: step.alias, message: 'unmet dependency or cycle' });
        failed.add(step.alias);
      }
      break;
    }
    await Promise.all(ready.map(async (step) => {
      remaining.delete(step.alias);
      try {
        const value = await runStep(step, registry, runAt, timezone, aliasMap);
        aliasMap[step.alias] = value;
        completed.add(step.alias);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ alias: step.alias, err: msg }, 'report step failed');
        errors.push({ alias: step.alias, message: msg });
        failed.add(step.alias);
      }
    }));
  }

  const rendered = renderOutput(plan.output, aliasMap);
  const status: ExecutePlanResult['status'] =
    failed.size === 0 ? 'ok' : completed.size === 0 ? 'error' : 'partial';
  return {
    status,
    text: rendered.text,
    attachments: rendered.attachments,
    errors,
    aliasMap,
  };
}

async function runStep(
  step: PlanStep,
  registry: ConnectorRegistry,
  runAt: Date,
  timezone: string,
  aliasMap: Record<string, unknown>,
): Promise<unknown> {
  const argsWithTimes = walkTimeRefs(step.args, runAt, timezone);
  if (containsRangePair(argsWithTimes)) {
    const { current, previous } = splitRangePair(argsWithTimes);
    const [cur, prev] = await Promise.all([
      callTool(step.tool, registry, resolveStepRefs(current, aliasMap)),
      callTool(step.tool, registry, resolveStepRefs(previous, aliasMap)),
    ]);
    return { current: cur, previous: prev };
  }
  const resolved = resolveStepRefs(argsWithTimes, aliasMap);
  return callTool(step.tool, registry, resolved);
}

async function callTool(toolName: string, registry: ConnectorRegistry, args: unknown): Promise<unknown> {
  const result = await registry.execute(toolName, args);
  if (!result.ok) {
    throw new Error(result.error?.message ?? 'tool failed');
  }
  // The registry passes through ToolResult-shaped returns verbatim. When the
  // connector returns its result with `ok: true` baked in, `result.data` is
  // undefined and the actual payload lives on the result object itself.
  if (result.data === undefined) {
    const { ok: _ok, error: _error, ...rest } = result as Record<string, unknown> & { ok: unknown; error?: unknown };
    return rest;
  }
  return result.data;
}

function walkTimeRefs(value: unknown, runAt: Date, timezone: string): unknown {
  if (Array.isArray(value)) return value.map((v) => walkTimeRefs(v, runAt, timezone));
  if (isTimeRef(value)) return resolveTimeRef(value, runAt, timezone);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walkTimeRefs(v, runAt, timezone);
    }
    return out;
  }
  return value;
}

function containsRangePair(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRangePair);
  if (isResolvedRangePair(value)) return true;
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsRangePair);
  }
  return false;
}

function splitRangePair(value: unknown): { current: unknown; previous: unknown } {
  return {
    current: substitutePair(value, 'current'),
    previous: substitutePair(value, 'previous'),
  };
}

function substitutePair(value: unknown, side: 'current' | 'previous'): unknown {
  if (Array.isArray(value)) return value.map((v) => substitutePair(v, side));
  if (isResolvedRangePair(value)) return (value as ResolvedDateRangePair)[side];
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substitutePair(v, side);
    }
    return out;
  }
  return value;
}
