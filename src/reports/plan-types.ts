/**
 * Scheduled-report plan format (v1). A ReportPlan is the deterministic,
 * compiled output of the user's natural-language report intent. Compiled
 * once at subscribe time, executed verbatim by the runner thereafter.
 */

export const PLAN_SCHEMA_VERSION = 1 as const;

export interface ReportPlan {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  steps: PlanStep[];
  output: OutputSpec;
  narrativeWrapup?: NarrativeSpec;
}

export interface PlanStep {
  /** Unique within the plan; referenced by other steps and by output blocks. */
  alias: string;
  /** Tool name as registered in ConnectorRegistry, e.g. "grafana.sql". */
  tool: string;
  /** Tool args. Values may contain TimeRef ({$time:...}) or StepRef ({$ref:...}) tokens. */
  args: Record<string, unknown>;
  /** Optional explicit dep aliases when args reference prior step results. */
  dependsOn?: string[];
}

export type TimeRef =
  | { $time: 'now_pt' }
  | { $time: 'today_pt' }
  | { $time: 'yesterday_pt' }
  | { $time: 'this_week_pt' }
  | { $time: 'last_week_pt' }
  | { $time: 'this_month_pt' }
  | { $time: 'last_month_pt' }
  | { $time: 'last_n_days_pt'; n: number }
  | { $time: 'wow_compare_pt' };

export interface StepRef {
  $ref: string; // dot-path, e.g. "late.rows[0].id"
}

export interface OutputSpec {
  blocks: BlockSpec[];
}

export type BlockSpec =
  | { type: 'header'; text: string }
  | { type: 'text'; text: string }                                       // ${alias.path} placeholders
  | { type: 'table'; from: string; columns: ColumnSpec[]; maxRows?: number }
  | { type: 'csv_attachment'; from: string; filename: string };

export interface ColumnSpec {
  header: string;
  field: string; // dot-path into a row
  format?:
    | 'currency_dollars'
    | 'integer'
    | 'datetime_pt'
    | 'date_pt'
    | 'admin_order_link'
    | 'percent';
}

export interface NarrativeSpec {
  promptTemplate: string; // ${alias.path} interpolations
  maxTokens?: number;     // default 400
}

/** Date-range pair returned by resolving any TimeRef. */
export interface ResolvedDateRange {
  startDate: string; // YYYY-MM-DD PT
  endDate: string;   // YYYY-MM-DD PT
  fromMs: number;    // UTC epoch ms (PT-aware)
  toMs: number;      // UTC epoch ms (PT-aware), end-of-day
}

/** wow_compare_pt resolves to a pair of ranges. */
export interface ResolvedDateRangePair {
  current: ResolvedDateRange;
  previous: ResolvedDateRange;
}

export type TimeRefValue = ResolvedDateRange | ResolvedDateRangePair;

/** Type guards for safely walking JSON args. */
export function isTimeRef(v: unknown): v is TimeRef {
  return typeof v === 'object' && v !== null && '$time' in (v as Record<string, unknown>);
}
export function isStepRef(v: unknown): v is StepRef {
  return typeof v === 'object' && v !== null && '$ref' in (v as Record<string, unknown>);
}
export function isResolvedRangePair(v: unknown): v is ResolvedDateRangePair {
  return typeof v === 'object' && v !== null && 'current' in (v as Record<string, unknown>) && 'previous' in (v as Record<string, unknown>);
}
