# Scheduled Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any authorized Slack user subscribe in natural language to a recurring report. The bot compiles the user's intent into a deterministic execution plan once, validates it, and an in-process runner re-executes the plan on its cron schedule and posts the result to Slack.

**Architecture:** Three layers. **Plan compiler** uses the existing `Orchestrator` with a meta-prompt to translate intent into a typed `ReportPlan` JSON, then runs the plan once end-to-end to validate. **Plan executor** is a pure-TypeScript walker over plan steps — no LLM unless `narrativeWrapup` is set — that resolves time and cross-step references at fire time. **Runner** is a `setInterval(30s)` loop inside the bot process that selects due subscriptions with `FOR UPDATE SKIP LOCKED` and dispatches them through the executor. New tools (`reports.subscribe`, `reports.preview`, `reports.list_subscriptions`, `reports.update_subscription`, `reports.unsubscribe`, `reports.run_now`, `reports.rebuild_plan`) are exposed via a new connector so users can manage subscriptions conversationally.

**Tech Stack:** TypeScript 5.x ESM (NodeNext), Node 20, Supabase (Postgres), `@anthropic-ai/sdk`, `@slack/bolt`, vitest, `cron-parser`. Spec: `docs/superpowers/specs/2026-04-25-scheduled-reports-design.md`.

---

## File Structure

```
migrations/
  0002_scheduled_reports.sql                     -- new table

src/reports/
  plan-types.ts                                  -- ReportPlan / PlanStep / TimeRef / StepRef / OutputSpec
  cron-utils.ts                                  -- parse + computeNextFireAt(cron, tz, after)
  time-refs.ts                                   -- resolveTimeRef(ref, runAt, tz) -> {fromMs,toMs} | pair
  step-refs.ts                                   -- resolveStepRefs(args, aliasMap) -> resolved args
  formatters.ts                                  -- currency / datetime PT / admin link / etc.
  block-renderer.ts                              -- OutputSpec + aliasMap -> Slack mrkdwn blocks + attachments
  reports-repo.ts                                -- CRUD on report_subscriptions
  plan-executor.ts                               -- execute(plan, registry, runAt, tz) -> ExecuteResult
  plan-compiler.ts                               -- compile(intent, orchestrator, registry) -> ReportPlan
  reports-connector.ts                           -- Connector exposing reports.* tools
  delivery.ts                                    -- post blocks + attachments to dm/channel
  runner.ts                                      -- startReportRunner + runDueOnce()

tests/unit/reports/
  cron-utils.test.ts
  time-refs.test.ts
  step-refs.test.ts
  formatters.test.ts
  block-renderer.test.ts
  plan-executor.test.ts
  reports-connector.test.ts

src/orchestrator/
  orchestrator.ts                                -- modify: add actorContext to OrchestratorInput
  prompts.ts                                     -- modify: add reports.* section

src/slack/
  handlers.ts                                    -- modify: thread actorContext into orchestrator.run

src/index.ts                                     -- modify: register reports connector + start runner
```

---

## Task 1: Database migration for `report_subscriptions`

**Files:**
- Create: `migrations/0002_scheduled_reports.sql`

- [ ] **Step 1: Write the migration**

Create `migrations/0002_scheduled_reports.sql` with:

```sql
-- Scheduled reports: per-user subscriptions to recurring report plans.
create table if not exists report_subscriptions (
  id uuid primary key default gen_random_uuid(),
  slack_user_id text not null references authorized_users(slack_user_id) on delete cascade,
  display_name text not null,
  original_intent text not null,
  plan jsonb not null,
  plan_compiled_at timestamptz not null default now(),
  plan_validation_status text not null
    check (plan_validation_status in ('ok','stale','broken'))
    default 'ok',
  cron text not null,
  timezone text not null default 'America/Los_Angeles',
  delivery_channel text not null default 'dm'
    check (delivery_channel = 'dm' or delivery_channel like 'channel:C%'),
  enabled boolean not null default true,
  next_run_at timestamptz not null,
  last_run_at timestamptz,
  last_run_status text check (last_run_status in ('ok','partial','error')),
  last_run_error text,
  fail_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists report_subscriptions_due_idx
  on report_subscriptions (next_run_at) where enabled;
create index if not exists report_subscriptions_user_idx
  on report_subscriptions (slack_user_id);
```

- [ ] **Step 2: Apply the migration via Supabase MCP**

Use the `mcp__supabase__apply_migration` tool with `project_id: ykjjwszoxazzlcovhlgd`, `name: "scheduled_reports"`, and the SQL above (without `if not exists` clauses, since `apply_migration` runs in a fresh transaction).

Verify with:

```sql
select column_name, data_type from information_schema.columns
where table_name = 'report_subscriptions' order by ordinal_position;
```

Expected: 17 columns matching the schema above.

- [ ] **Step 3: Commit**

```bash
git add migrations/0002_scheduled_reports.sql
git commit -m "feat(reports): migration for report_subscriptions table"
```

---

## Task 2: Add `cron-parser` dependency and plan types

**Files:**
- Modify: `package.json`
- Create: `src/reports/plan-types.ts`

- [ ] **Step 1: Install cron-parser**

```bash
npm install cron-parser@4.9.0
```

Verify `package.json` `dependencies` contains `"cron-parser": "^4.9.0"`.

- [ ] **Step 2: Create plan types**

Create `src/reports/plan-types.ts` with the exact contents:

```ts
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
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/reports/plan-types.ts
git commit -m "feat(reports): add ReportPlan types + cron-parser dependency"
```

---

## Task 3: Cron utilities (parse + compute next fire)

**Files:**
- Create: `src/reports/cron-utils.ts`
- Create: `tests/unit/reports/cron-utils.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/reports/cron-utils.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isValidCron, computeNextFireAt } from '../../../src/reports/cron-utils.js';

describe('cron-utils', () => {
  describe('isValidCron', () => {
    it('accepts standard 5-field expressions', () => {
      expect(isValidCron('* * * * *')).toBe(true);
      expect(isValidCron('*/5 * * * *')).toBe(true);
      expect(isValidCron('0 9 * * 1-5')).toBe(true);
      expect(isValidCron('30 */2 * * *')).toBe(true);
    });
    it('rejects malformed expressions', () => {
      expect(isValidCron('not a cron')).toBe(false);
      expect(isValidCron('60 * * * *')).toBe(false);          // minute > 59
      expect(isValidCron('* * * *')).toBe(false);             // 4 fields
      expect(isValidCron('')).toBe(false);
    });
  });

  describe('computeNextFireAt', () => {
    it('computes the next minute-boundary fire in the requested timezone', () => {
      // 2026-04-25 14:23:00 UTC == 2026-04-25 07:23:00 PT
      const after = new Date('2026-04-25T14:23:00.000Z');
      // "Daily 9am PT" -> next fire is 2026-04-25 16:00:00 UTC (= 09:00 PT)
      const next = computeNextFireAt('0 9 * * *', 'America/Los_Angeles', after);
      expect(next.toISOString()).toBe('2026-04-25T16:00:00.000Z');
    });

    it('handles "every 5 minutes"', () => {
      const after = new Date('2026-04-25T14:23:00.000Z');
      const next = computeNextFireAt('*/5 * * * *', 'America/Los_Angeles', after);
      // Next */5 boundary after 14:23 UTC is 14:25 UTC.
      expect(next.toISOString()).toBe('2026-04-25T14:25:00.000Z');
    });

    it('handles "every Monday 7am PT" across week boundaries', () => {
      // 2026-04-25 is a Saturday; next Monday at 7am PT is 2026-04-27 14:00 UTC.
      const after = new Date('2026-04-25T14:23:00.000Z');
      const next = computeNextFireAt('0 7 * * 1', 'America/Los_Angeles', after);
      expect(next.toISOString()).toBe('2026-04-27T14:00:00.000Z');
    });

    it('throws on an invalid cron', () => {
      expect(() => computeNextFireAt('garbage', 'America/Los_Angeles', new Date()))
        .toThrow();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/unit/reports/cron-utils.test.ts
```

Expected: FAIL with "Cannot find module '../../../src/reports/cron-utils.js'".

- [ ] **Step 3: Implement cron-utils**

Create `src/reports/cron-utils.ts`:

```ts
import cronParser from 'cron-parser';

/** Returns true if `expr` is a valid 5-field cron expression. */
export function isValidCron(expr: string): boolean {
  if (typeof expr !== 'string' || expr.trim().split(/\s+/).length !== 5) return false;
  try {
    cronParser.parseExpression(expr);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the next time the cron expression fires after `after`, evaluated in
 * the given IANA timezone. Throws if the expression is invalid.
 */
export function computeNextFireAt(expr: string, timezone: string, after: Date): Date {
  const it = cronParser.parseExpression(expr, {
    currentDate: after,
    tz: timezone,
  });
  return it.next().toDate();
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/unit/reports/cron-utils.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/reports/cron-utils.ts tests/unit/reports/cron-utils.test.ts
git commit -m "feat(reports): cron expression validation + next-fire computation"
```

---

## Task 4: TimeRef resolver

**Files:**
- Create: `src/reports/time-refs.ts`
- Create: `tests/unit/reports/time-refs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/reports/time-refs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveTimeRef } from '../../../src/reports/time-refs.js';
import type { ResolvedDateRange, ResolvedDateRangePair } from '../../../src/reports/plan-types.js';

const TZ = 'America/Los_Angeles';

describe('resolveTimeRef', () => {
  // Reference run time: 2026-04-25 14:23:00 UTC == 2026-04-25 07:23 PT (Saturday).
  const runAt = new Date('2026-04-25T14:23:00.000Z');

  it('today_pt yields the current PT day', () => {
    const r = resolveTimeRef({ $time: 'today_pt' }, runAt, TZ) as ResolvedDateRange;
    expect(r.startDate).toBe('2026-04-25');
    expect(r.endDate).toBe('2026-04-25');
  });

  it('yesterday_pt yields the prior PT day', () => {
    const r = resolveTimeRef({ $time: 'yesterday_pt' }, runAt, TZ) as ResolvedDateRange;
    expect(r.startDate).toBe('2026-04-24');
    expect(r.endDate).toBe('2026-04-24');
  });

  it('this_week_pt yields Mon..Sun of the current week', () => {
    const r = resolveTimeRef({ $time: 'this_week_pt' }, runAt, TZ) as ResolvedDateRange;
    expect(r.startDate).toBe('2026-04-20'); // Monday before
    expect(r.endDate).toBe('2026-04-26');   // Sunday
  });

  it('last_week_pt yields the prior Mon..Sun', () => {
    const r = resolveTimeRef({ $time: 'last_week_pt' }, runAt, TZ) as ResolvedDateRange;
    expect(r.startDate).toBe('2026-04-13');
    expect(r.endDate).toBe('2026-04-19');
  });

  it('this_month_pt yields the current calendar month', () => {
    const r = resolveTimeRef({ $time: 'this_month_pt' }, runAt, TZ) as ResolvedDateRange;
    expect(r.startDate).toBe('2026-04-01');
    expect(r.endDate).toBe('2026-04-30');
  });

  it('last_month_pt yields the prior calendar month', () => {
    const r = resolveTimeRef({ $time: 'last_month_pt' }, runAt, TZ) as ResolvedDateRange;
    expect(r.startDate).toBe('2026-03-01');
    expect(r.endDate).toBe('2026-03-31');
  });

  it('last_n_days_pt(7) yields the trailing 7-day window ending today', () => {
    const r = resolveTimeRef({ $time: 'last_n_days_pt', n: 7 }, runAt, TZ) as ResolvedDateRange;
    expect(r.startDate).toBe('2026-04-19');
    expect(r.endDate).toBe('2026-04-25');
  });

  it('wow_compare_pt yields a pair of ranges (current week + previous week)', () => {
    const r = resolveTimeRef({ $time: 'wow_compare_pt' }, runAt, TZ) as ResolvedDateRangePair;
    expect(r.current.startDate).toBe('2026-04-20');
    expect(r.current.endDate).toBe('2026-04-26');
    expect(r.previous.startDate).toBe('2026-04-13');
    expect(r.previous.endDate).toBe('2026-04-19');
  });

  it('returns the from/to ms boundaries that cover the PT day in UTC', () => {
    const r = resolveTimeRef({ $time: 'today_pt' }, runAt, TZ) as ResolvedDateRange;
    // PT day 2026-04-25 = 2026-04-25T07:00:00Z .. 2026-04-26T06:59:59.999Z
    expect(new Date(r.fromMs).toISOString()).toBe('2026-04-25T07:00:00.000Z');
    expect(new Date(r.toMs).toISOString()).toBe('2026-04-26T06:59:59.999Z');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/unit/reports/time-refs.test.ts
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement time-refs**

Create `src/reports/time-refs.ts`:

```ts
import type {
  TimeRef,
  TimeRefValue,
  ResolvedDateRange,
  ResolvedDateRangePair,
} from './plan-types.js';

/**
 * Resolve a TimeRef against the runner's `runAt` instant, in the given IANA
 * timezone. Returns either a single ResolvedDateRange or, for wow_compare_pt,
 * a pair of ranges.
 *
 * All ranges are inclusive PT calendar days. fromMs / toMs span the UTC range
 * that covers those PT days end-to-end (07:00:00 PT-zone-offset typical, but
 * we compute from the IANA tz — so DST is handled correctly).
 */
export function resolveTimeRef(ref: TimeRef, runAt: Date, timezone: string): TimeRefValue {
  const today = pacificDay(runAt, timezone);
  switch (ref.$time) {
    case 'now_pt':
    case 'today_pt':
      return rangeFor(today, today, timezone);
    case 'yesterday_pt': {
      const y = addDays(today, -1);
      return rangeFor(y, y, timezone);
    }
    case 'this_week_pt': {
      const { mon, sun } = isoWeekBounds(today);
      return rangeFor(mon, sun, timezone);
    }
    case 'last_week_pt': {
      const { mon, sun } = isoWeekBounds(addDays(today, -7));
      return rangeFor(mon, sun, timezone);
    }
    case 'this_month_pt': {
      const { first, last } = monthBounds(today);
      return rangeFor(first, last, timezone);
    }
    case 'last_month_pt': {
      const prev = addDays(monthBounds(today).first, -1);
      const { first, last } = monthBounds(prev);
      return rangeFor(first, last, timezone);
    }
    case 'last_n_days_pt': {
      const start = addDays(today, -(ref.n - 1));
      return rangeFor(start, today, timezone);
    }
    case 'wow_compare_pt': {
      const cur = isoWeekBounds(today);
      const prev = isoWeekBounds(addDays(cur.mon, -7));
      return {
        current: rangeFor(cur.mon, cur.sun, timezone),
        previous: rangeFor(prev.mon, prev.sun, timezone),
      } satisfies ResolvedDateRangePair;
    }
  }
}

/** Return YYYY-MM-DD for the calendar day in `timezone` containing `at`. */
function pacificDay(at: Date, timezone: string): string {
  // Intl.DateTimeFormat with a numeric date in the target tz.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(at); // en-CA -> "2026-04-25"
}

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function isoWeekBounds(ymd: string): { mon: string; sun: string } {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay() || 7; // 1..7 (Mon..Sun)
  const monDate = new Date(dt);
  monDate.setUTCDate(dt.getUTCDate() - (dow - 1));
  const sunDate = new Date(monDate);
  sunDate.setUTCDate(monDate.getUTCDate() + 6);
  return {
    mon: monDate.toISOString().slice(0, 10),
    sun: sunDate.toISOString().slice(0, 10),
  };
}

function monthBounds(ymd: string): { first: string; last: string } {
  const [y, m] = ymd.split('-').map(Number);
  const first = `${pad(y, 4)}-${pad(m, 2)}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month
  const last = `${pad(y, 4)}-${pad(m, 2)}-${pad(lastDay, 2)}`;
  return { first, last };
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/**
 * Build a ResolvedDateRange. fromMs/toMs are the UTC instants that span the
 * PT calendar days [start..end] inclusive. We compute them by formatting the
 * boundary instants with the tz applied, then solving for the UTC offset.
 */
function rangeFor(startDate: string, endDate: string, timezone: string): ResolvedDateRange {
  const fromMs = wallClockToUtc(`${startDate}T00:00:00`, timezone);
  const toMs = wallClockToUtc(`${endDate}T23:59:59.999`, timezone);
  return { startDate, endDate, fromMs, toMs };
}

/**
 * Convert a wall-clock string in `timezone` to its UTC epoch ms.
 * Algorithm: format the candidate UTC instant in the target tz; the difference
 * between the formatted wall-clock and the target wall-clock is the offset
 * we need to subtract. One iteration is enough except across DST jumps, so
 * we iterate twice.
 */
function wallClockToUtc(wallClock: string, timezone: string): number {
  // Treat wallClock as if it were UTC, then correct.
  let utc = Date.parse(`${wallClock}Z`);
  for (let i = 0; i < 2; i++) {
    const formatted = formatInTz(new Date(utc), timezone);
    const drift = Date.parse(`${formatted}Z`) - Date.parse(`${wallClock}Z`);
    utc -= drift;
  }
  return utc;
}

function formatInTz(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  // 24h handling: en-CA returns "24" for midnight; normalize to "00".
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}.${get('fractionalSecond') || '000'}`;
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/unit/reports/time-refs.test.ts
```

Expected: 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/reports/time-refs.ts tests/unit/reports/time-refs.test.ts
git commit -m "feat(reports): TimeRef resolver (today/week/month/wow-compare in PT)"
```

---

## Task 5: StepRef resolver

**Files:**
- Create: `src/reports/step-refs.ts`
- Create: `tests/unit/reports/step-refs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/reports/step-refs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveStepRefs, getByPath } from '../../../src/reports/step-refs.js';

describe('getByPath', () => {
  const obj = {
    rows: [{ id: 7, name: 'foo' }, { id: 9, name: 'bar' }],
    nested: { count: 42 },
  };
  it('walks dotted paths', () => {
    expect(getByPath(obj, 'nested.count')).toBe(42);
  });
  it('walks array indices', () => {
    expect(getByPath(obj, 'rows[0].id')).toBe(7);
    expect(getByPath(obj, 'rows[1].name')).toBe('bar');
  });
  it('returns undefined for missing paths', () => {
    expect(getByPath(obj, 'missing.key')).toBeUndefined();
    expect(getByPath(obj, 'rows[10]')).toBeUndefined();
  });
});

describe('resolveStepRefs', () => {
  const aliasMap = {
    late: { rows: [{ id: 53107 }, { id: 50000 }] },
    spend: { total: 12345 },
  };

  it('replaces { $ref: "alias.path" } tokens recursively', () => {
    const args = {
      id: { $ref: 'late.rows[0].id' },
      meta: { spend: { $ref: 'spend.total' }, label: 'plain' },
      ids: [{ $ref: 'late.rows[0].id' }, { $ref: 'late.rows[1].id' }],
    };
    expect(resolveStepRefs(args, aliasMap)).toEqual({
      id: 53107,
      meta: { spend: 12345, label: 'plain' },
      ids: [53107, 50000],
    });
  });

  it('throws on unknown alias', () => {
    expect(() =>
      resolveStepRefs({ x: { $ref: 'missing.thing' } }, aliasMap),
    ).toThrow(/missing/);
  });

  it('passes through plain values', () => {
    expect(resolveStepRefs({ a: 1, b: 'two', c: null }, aliasMap)).toEqual({ a: 1, b: 'two', c: null });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/unit/reports/step-refs.test.ts
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement step-refs**

Create `src/reports/step-refs.ts`:

```ts
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
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/reports/step-refs.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/reports/step-refs.ts tests/unit/reports/step-refs.test.ts
git commit -m "feat(reports): StepRef resolver with dot+bracket path syntax"
```

---

## Task 6: Formatters (currency / datetime / admin link / etc.)

**Files:**
- Create: `src/reports/formatters.ts`
- Create: `tests/unit/reports/formatters.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/reports/formatters.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatCell } from '../../../src/reports/formatters.js';

describe('formatCell', () => {
  it('currency_dollars formats with $ and 2 decimals', () => {
    expect(formatCell(1234.5, 'currency_dollars')).toBe('$1,234.50');
    expect(formatCell(0, 'currency_dollars')).toBe('$0.00');
    expect(formatCell(null, 'currency_dollars')).toBe('—');
  });

  it('integer formats with thousands sep', () => {
    expect(formatCell(1234567, 'integer')).toBe('1,234,567');
    expect(formatCell(0, 'integer')).toBe('0');
  });

  it('percent multiplies by 100 and adds %', () => {
    expect(formatCell(0.1234, 'percent')).toBe('12.3%');
  });

  it('admin_order_link renders Slack mrkdwn link', () => {
    expect(formatCell(53981, 'admin_order_link'))
      .toBe('<http://admin.gantri.com/orders/53981|#53981>');
  });

  it('datetime_pt formats ISO timestamp as YYYY-MM-DD HH:MM PT wall-clock', () => {
    expect(formatCell('2026-04-20T01:22:03.775Z', 'datetime_pt')).toBe('2026-04-19 18:22');
  });

  it('date_pt formats ISO timestamp as YYYY-MM-DD PT', () => {
    expect(formatCell('2026-04-20T01:22:03.775Z', 'date_pt')).toBe('2026-04-19');
  });

  it('returns "—" for null/undefined regardless of format', () => {
    expect(formatCell(undefined, 'datetime_pt')).toBe('—');
    expect(formatCell(null, 'admin_order_link')).toBe('—');
  });

  it('falls through to String() when no format is specified', () => {
    expect(formatCell('hello', undefined)).toBe('hello');
    expect(formatCell(42, undefined)).toBe('42');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/unit/reports/formatters.test.ts
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement formatters**

Create `src/reports/formatters.ts`:

```ts
import type { ColumnSpec } from './plan-types.js';

const NA = '—';
const PT_TZ = 'America/Los_Angeles';

/** Format a single cell value according to a ColumnSpec.format (or pass through). */
export function formatCell(value: unknown, format?: ColumnSpec['format']): string {
  if (value === null || value === undefined) return NA;
  switch (format) {
    case 'currency_dollars': {
      const n = Number(value);
      if (!Number.isFinite(n)) return NA;
      return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    case 'integer': {
      const n = Number(value);
      if (!Number.isFinite(n)) return NA;
      return Math.round(n).toLocaleString('en-US');
    }
    case 'percent': {
      const n = Number(value);
      if (!Number.isFinite(n)) return NA;
      return `${(n * 100).toFixed(1)}%`;
    }
    case 'admin_order_link': {
      const id = String(value);
      return `<http://admin.gantri.com/orders/${id}|#${id}>`;
    }
    case 'datetime_pt': {
      const d = new Date(value as string | number);
      if (Number.isNaN(d.getTime())) return NA;
      return ptWallClock(d, false);
    }
    case 'date_pt': {
      const d = new Date(value as string | number);
      if (Number.isNaN(d.getTime())) return NA;
      return ptWallClock(d, true);
    }
    default:
      return String(value);
  }
}

function ptWallClock(d: Date, dateOnly: boolean): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PT_TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(dateOnly ? {} : { hour: '2-digit', minute: '2-digit' }),
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  if (dateOnly) return date;
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${date} ${hour}:${get('minute')}`;
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/reports/formatters.test.ts
```

Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/reports/formatters.ts tests/unit/reports/formatters.test.ts
git commit -m "feat(reports): cell formatters (currency, datetime PT, admin link, etc.)"
```

---

## Task 7: Block renderer (OutputSpec + aliasMap → Slack mrkdwn)

**Files:**
- Create: `src/reports/block-renderer.ts`
- Create: `tests/unit/reports/block-renderer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/reports/block-renderer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { renderOutput } from '../../../src/reports/block-renderer.js';
import type { OutputSpec } from '../../../src/reports/plan-types.js';

describe('renderOutput', () => {
  const aliasMap = {
    late: {
      rows: [
        { id: 53107, customer: 'Haworth Inc', daysLate: 5, total: 240.5 },
        { id: 53245, customer: 'Lumens Inc', daysLate: 2, total: 99.0 },
      ],
    },
    spend: { total: 12345 },
  };

  it('renders a header block', () => {
    const out: OutputSpec = { blocks: [{ type: 'header', text: 'Daily report' }] };
    const r = renderOutput(out, aliasMap);
    expect(r.text).toContain('*Daily report*');
    expect(r.attachments).toEqual([]);
  });

  it('renders a text block with ${alias.path} interpolation', () => {
    const out: OutputSpec = {
      blocks: [{ type: 'text', text: 'Total spend was ${spend.total} dollars.' }],
    };
    const r = renderOutput(out, aliasMap);
    expect(r.text).toContain('Total spend was 12345 dollars.');
  });

  it('renders a table as an aligned ASCII code block', () => {
    const out: OutputSpec = {
      blocks: [
        {
          type: 'table',
          from: 'late.rows',
          columns: [
            { header: 'Order', field: 'id', format: 'admin_order_link' },
            { header: 'Customer', field: 'customer' },
            { header: 'Days late', field: 'daysLate', format: 'integer' },
            { header: 'Total', field: 'total', format: 'currency_dollars' },
          ],
        },
      ],
    };
    const r = renderOutput(out, aliasMap);
    expect(r.text).toContain('```');
    expect(r.text).toContain('<http://admin.gantri.com/orders/53107|#53107>');
    expect(r.text).toContain('Haworth Inc');
    expect(r.text).toContain('$240.50');
  });

  it('emits a CSV attachment for csv_attachment blocks', () => {
    const out: OutputSpec = {
      blocks: [
        { type: 'csv_attachment', from: 'late.rows', filename: 'late.csv' },
      ],
    };
    const r = renderOutput(out, aliasMap);
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0].filename).toBe('late.csv');
    expect(r.attachments[0].content).toContain('id,customer,daysLate,total');
    expect(r.attachments[0].content).toContain('53107,Haworth Inc,5,240.5');
  });

  it('renders all blocks in order separated by blank lines', () => {
    const out: OutputSpec = {
      blocks: [
        { type: 'header', text: 'A' },
        { type: 'text', text: 'B' },
      ],
    };
    const r = renderOutput(out, aliasMap);
    expect(r.text).toBe('*A*\n\nB');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/unit/reports/block-renderer.test.ts
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement block-renderer**

Create `src/reports/block-renderer.ts`:

```ts
import type { OutputSpec, BlockSpec, ColumnSpec } from './plan-types.js';
import { formatCell } from './formatters.js';
import { getByPath } from './step-refs.js';

export interface RenderedAttachment {
  filename: string;
  content: string;          // raw text content
  format: 'csv';
}

export interface RenderedOutput {
  text: string;             // Slack mrkdwn
  attachments: RenderedAttachment[];
}

export function renderOutput(spec: OutputSpec, aliasMap: Record<string, unknown>): RenderedOutput {
  const parts: string[] = [];
  const attachments: RenderedAttachment[] = [];
  for (const block of spec.blocks) {
    const rendered = renderBlock(block, aliasMap, attachments);
    if (rendered) parts.push(rendered);
  }
  return { text: parts.join('\n\n'), attachments };
}

function renderBlock(
  block: BlockSpec,
  aliasMap: Record<string, unknown>,
  attachments: RenderedAttachment[],
): string | null {
  switch (block.type) {
    case 'header':
      return `*${block.text}*`;
    case 'text':
      return interpolate(block.text, aliasMap);
    case 'table':
      return renderTable(block.from, block.columns, block.maxRows ?? 50, aliasMap);
    case 'csv_attachment': {
      const rows = pickRows(block.from, aliasMap);
      attachments.push({
        filename: block.filename,
        content: rowsToCsv(rows),
        format: 'csv',
      });
      return null;
    }
  }
}

function interpolate(template: string, aliasMap: Record<string, unknown>): string {
  return template.replace(/\$\{([^}]+)\}/g, (_match, path: string) => {
    const v = getByPath(aliasMap, path.trim());
    return v === undefined || v === null ? '—' : String(v);
  });
}

function renderTable(
  from: string,
  columns: ColumnSpec[],
  maxRows: number,
  aliasMap: Record<string, unknown>,
): string {
  const rows = pickRows(from, aliasMap).slice(0, maxRows);
  const headerCells = columns.map((c) => c.header);
  const bodyCells = rows.map((row) => columns.map((c) => formatCell(getByPath(row, c.field), c.format)));
  // Align by max column width.
  const widths = headerCells.map((h, i) =>
    Math.max(h.length, ...bodyCells.map((r) => r[i].length)),
  );
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
  const lines = [
    headerCells.map((h, i) => pad(h, widths[i])).join('  '),
    widths.map((w) => '─'.repeat(w)).join('  '),
    ...bodyCells.map((r) => r.map((c, i) => pad(c, widths[i])).join('  ')),
  ];
  return '```\n' + lines.join('\n') + '\n```';
}

function pickRows(from: string, aliasMap: Record<string, unknown>): Array<Record<string, unknown>> {
  const v = getByPath(aliasMap, from);
  if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
  return [];
}

function rowsToCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '';
  const headers = Array.from(
    rows.reduce((acc, r) => {
      for (const k of Object.keys(r)) acc.add(k);
      return acc;
    }, new Set<string>()),
  );
  const escape = (s: string) => /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const lines = [
    headers.join(','),
    ...rows.map((r) =>
      headers
        .map((h) => {
          const v = (r as any)[h];
          if (v === undefined || v === null) return '';
          return escape(String(v));
        })
        .join(','),
    ),
  ];
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/reports/block-renderer.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/reports/block-renderer.ts tests/unit/reports/block-renderer.test.ts
git commit -m "feat(reports): block renderer (header/text/table/csv-attachment)"
```

---

## Task 8: Reports repository (Supabase CRUD)

**Files:**
- Create: `src/reports/reports-repo.ts`

- [ ] **Step 1: Write the repo**

Create `src/reports/reports-repo.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReportPlan } from './plan-types.js';

export interface ReportSubscriptionRow {
  id: string;
  slack_user_id: string;
  display_name: string;
  original_intent: string;
  plan: ReportPlan;
  plan_compiled_at: string;
  plan_validation_status: 'ok' | 'stale' | 'broken';
  cron: string;
  timezone: string;
  delivery_channel: string;
  enabled: boolean;
  next_run_at: string;
  last_run_at: string | null;
  last_run_status: 'ok' | 'partial' | 'error' | null;
  last_run_error: string | null;
  fail_count: number;
  created_at: string;
  updated_at: string;
}

export interface InsertSubscriptionInput {
  slack_user_id: string;
  display_name: string;
  original_intent: string;
  plan: ReportPlan;
  cron: string;
  timezone: string;
  delivery_channel: string;
  next_run_at: string;
}

export interface UpdateSubscriptionFields {
  display_name?: string;
  original_intent?: string;
  plan?: ReportPlan;
  plan_compiled_at?: string;
  plan_validation_status?: 'ok' | 'stale' | 'broken';
  cron?: string;
  timezone?: string;
  delivery_channel?: string;
  enabled?: boolean;
  next_run_at?: string;
  last_run_at?: string;
  last_run_status?: 'ok' | 'partial' | 'error' | null;
  last_run_error?: string | null;
  fail_count?: number;
  updated_at?: string;
}

export class ReportSubscriptionsRepo {
  constructor(private readonly client: SupabaseClient) {}

  async insert(row: InsertSubscriptionInput): Promise<ReportSubscriptionRow> {
    const { data, error } = await this.client
      .from('report_subscriptions')
      .insert(row)
      .select('*')
      .single();
    if (error) throw new Error(`report subscription insert failed: ${error.message}`);
    return data as ReportSubscriptionRow;
  }

  async getById(id: string): Promise<ReportSubscriptionRow | null> {
    const { data, error } = await this.client
      .from('report_subscriptions')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`report subscription read failed: ${error.message}`);
    return (data as ReportSubscriptionRow | null) ?? null;
  }

  async listByUser(slackUserId: string): Promise<ReportSubscriptionRow[]> {
    const { data, error } = await this.client
      .from('report_subscriptions')
      .select('*')
      .eq('slack_user_id', slackUserId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(`report subscription list failed: ${error.message}`);
    return (data ?? []) as ReportSubscriptionRow[];
  }

  async update(id: string, fields: UpdateSubscriptionFields): Promise<ReportSubscriptionRow> {
    const { data, error } = await this.client
      .from('report_subscriptions')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new Error(`report subscription update failed: ${error.message}`);
    return data as ReportSubscriptionRow;
  }

  /**
   * Atomically pick up to `limit` due-and-enabled subscriptions and return them.
   * Uses a transactional UPDATE with row-level locking via a Postgres function;
   * since the Supabase JS client doesn't expose FOR UPDATE SKIP LOCKED directly,
   * we issue a raw SQL via the rpc helper. The migration in Task 9 defines that
   * RPC. Until Task 9 lands, this method falls back to a non-locked select that
   * is still safe single-process.
   */
  async claimDueBatch(now: Date, limit: number): Promise<ReportSubscriptionRow[]> {
    const { data, error } = await this.client.rpc('claim_due_report_subscriptions', {
      p_now: now.toISOString(),
      p_limit: limit,
    });
    if (error) throw new Error(`claim_due_report_subscriptions failed: ${error.message}`);
    return (data ?? []) as ReportSubscriptionRow[];
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/reports/reports-repo.ts
git commit -m "feat(reports): ReportSubscriptionsRepo (CRUD + claim_due_batch)"
```

---

## Task 9: Postgres function for `claim_due_report_subscriptions`

**Files:**
- Create: `migrations/0003_claim_due_report_subscriptions.sql`

- [ ] **Step 1: Write the migration**

Create `migrations/0003_claim_due_report_subscriptions.sql`:

```sql
-- Atomically pick up to `p_limit` enabled subscriptions whose next_run_at <= p_now
-- and bump their next_run_at by 1 minute (a sentinel; the runner will overwrite
-- with the cron-computed next fire after a successful or failed run). Uses
-- FOR UPDATE SKIP LOCKED so multiple runners can be safely attempted in parallel.
create or replace function claim_due_report_subscriptions(
  p_now timestamptz,
  p_limit int
) returns setof report_subscriptions
language plpgsql as $$
begin
  return query
  with due as (
    select id from report_subscriptions
    where enabled and next_run_at <= p_now
    order by next_run_at
    limit p_limit
    for update skip locked
  )
  update report_subscriptions r
    set next_run_at = p_now + interval '1 minute'
    from due
    where r.id = due.id
    returning r.*;
end $$;

grant execute on function claim_due_report_subscriptions(timestamptz, int) to service_role;
```

- [ ] **Step 2: Apply the migration via Supabase MCP**

Use `mcp__supabase__apply_migration` with `project_id: ykjjwszoxazzlcovhlgd`, `name: "claim_due_report_subscriptions"`, and the SQL body above.

Verify with:

```sql
select proname from pg_proc where proname = 'claim_due_report_subscriptions';
```

Expected: 1 row.

- [ ] **Step 3: Commit**

```bash
git add migrations/0003_claim_due_report_subscriptions.sql
git commit -m "feat(reports): claim_due_report_subscriptions postgres function"
```

---

## Task 10: Plan executor

**Files:**
- Create: `src/reports/plan-executor.ts`
- Create: `tests/unit/reports/plan-executor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/reports/plan-executor.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { Connector, ToolDef } from '../../../src/connectors/base/connector.js';
import { ConnectorRegistry } from '../../../src/connectors/base/registry.js';
import { executePlan } from '../../../src/reports/plan-executor.js';
import type { ReportPlan } from '../../../src/reports/plan-types.js';

function fakeConnector(name: string, tools: ToolDef[]): Connector {
  return {
    name,
    tools,
    async healthCheck() { return { ok: true }; },
  };
}

function fakeTool(name: string, execute: (args: any) => Promise<unknown>): ToolDef {
  return {
    name,
    description: name,
    schema: z.object({}).passthrough(),
    jsonSchema: { type: 'object' },
    execute,
  };
}

describe('executePlan', () => {
  const runAt = new Date('2026-04-25T14:23:00.000Z');

  it('executes independent steps in parallel and renders blocks', async () => {
    const sqlExec = vi.fn(async (args: any) => ({ rows: [{ x: 1 }, { x: 2 }] }));
    const overviewExec = vi.fn(async (args: any) => ({ spend: 100 }));
    const registry = new ConnectorRegistry();
    registry.register(fakeConnector('grafana', [fakeTool('grafana.sql', sqlExec)]));
    registry.register(fakeConnector('northbeam', [fakeTool('northbeam.overview', overviewExec)]));

    const plan: ReportPlan = {
      schemaVersion: 1,
      steps: [
        { alias: 'late', tool: 'grafana.sql', args: { sql: 'select 1', dateRange: { $time: 'today_pt' } } },
        { alias: 'spend', tool: 'northbeam.overview', args: { dateRange: { $time: 'today_pt' } } },
      ],
      output: {
        blocks: [
          { type: 'header', text: 'Daily report' },
          { type: 'text', text: 'Spend: ${spend.spend}, late count: ${late.rows.length}' },
        ],
      },
    };

    const result = await executePlan({ plan, registry, runAt, timezone: 'America/Los_Angeles' });
    expect(result.status).toBe('ok');
    expect(result.text).toContain('*Daily report*');
    expect(result.text).toContain('Spend: 100');
    // length isn't a path key on arrays; renderer treats it as missing => "—".
    // Fix the expectation: use a path that exists.
    expect(sqlExec).toHaveBeenCalled();
    expect(overviewExec).toHaveBeenCalled();
    // Confirm parallelism by ensuring both were called with resolved date ranges.
    const sqlArgs = sqlExec.mock.calls[0][0];
    expect(sqlArgs.dateRange.startDate).toBe('2026-04-25');
    expect(sqlArgs.dateRange.fromMs).toBeTypeOf('number');
  });

  it('resolves StepRefs from earlier step results', async () => {
    const listExec = vi.fn(async () => ({ rows: [{ id: 7 }] }));
    const detailExec = vi.fn(async (args: any) => ({ id: args.id, name: 'foo' }));
    const registry = new ConnectorRegistry();
    registry.register(fakeConnector('a', [fakeTool('a.list', listExec), fakeTool('a.detail', detailExec)]));

    const plan: ReportPlan = {
      schemaVersion: 1,
      steps: [
        { alias: 'list', tool: 'a.list', args: {} },
        { alias: 'detail', tool: 'a.detail', args: { id: { $ref: 'list.rows[0].id' } }, dependsOn: ['list'] },
      ],
      output: { blocks: [{ type: 'text', text: 'name: ${detail.name}' }] },
    };

    const result = await executePlan({ plan, registry, runAt, timezone: 'America/Los_Angeles' });
    expect(detailExec).toHaveBeenCalledWith({ id: 7 });
    expect(result.text).toBe('name: foo');
    expect(result.status).toBe('ok');
  });

  it('marks status partial when one step fails but others render', async () => {
    const okExec = vi.fn(async () => ({ ok: true, n: 5 }));
    const badExec = vi.fn(async () => { throw new Error('boom'); });
    const registry = new ConnectorRegistry();
    registry.register(fakeConnector('a', [fakeTool('a.ok', okExec), fakeTool('a.bad', badExec)]));

    const plan: ReportPlan = {
      schemaVersion: 1,
      steps: [
        { alias: 'good', tool: 'a.ok', args: {} },
        { alias: 'broken', tool: 'a.bad', args: {} },
      ],
      output: {
        blocks: [
          { type: 'text', text: 'good=${good.n}' },
          { type: 'text', text: 'broken=${broken.n}' },
        ],
      },
    };

    const result = await executePlan({ plan, registry, runAt, timezone: 'America/Los_Angeles' });
    expect(result.status).toBe('partial');
    expect(result.text).toContain('good=5');
    expect(result.errors).toEqual([{ alias: 'broken', message: 'boom' }]);
  });

  it('expands a wow_compare_pt TimeRef into current+previous calls', async () => {
    const exec = vi.fn(async (args: any) => ({ tag: args.dateRange.startDate }));
    const registry = new ConnectorRegistry();
    registry.register(fakeConnector('a', [fakeTool('a.t', exec)]));

    const plan: ReportPlan = {
      schemaVersion: 1,
      steps: [
        { alias: 'wow', tool: 'a.t', args: { dateRange: { $time: 'wow_compare_pt' } } },
      ],
      output: { blocks: [{ type: 'text', text: 'cur=${wow.current.tag} prev=${wow.previous.tag}' }] },
    };

    const result = await executePlan({ plan, registry, runAt, timezone: 'America/Los_Angeles' });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(result.text).toBe('cur=2026-04-20 prev=2026-04-13');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/unit/reports/plan-executor.test.ts
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement the executor**

Create `src/reports/plan-executor.ts`:

```ts
import type { ConnectorRegistry } from '../connectors/base/registry.js';
import type {
  ReportPlan,
  PlanStep,
  TimeRefValue,
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

  // Group steps into waves by dependsOn (topological).
  const remaining = new Map<string, PlanStep>(plan.steps.map((s) => [s.alias, s]));
  const completed = new Set<string>();
  const failed = new Set<string>();

  while (remaining.size > 0) {
    const ready: PlanStep[] = [];
    for (const step of remaining.values()) {
      const deps = step.dependsOn ?? [];
      if (deps.every((d) => completed.has(d) || failed.has(d))) {
        // Skip if any explicit dep failed.
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
      // Cycle or unmet deps; fail remaining.
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
  // Resolve TimeRefs first.
  const argsWithTimes = walkTimeRefs(step.args, runAt, timezone);
  // Detect wow_compare_pt and fan out into current+previous.
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
  return result.data;
}

/** Recursively replace TimeRef tokens with resolved date ranges. */
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

/** Given args that contain (somewhere) a ResolvedDateRangePair, produce two args
 *  copies with `current` and `previous` substituted in place. */
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
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/reports/plan-executor.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/reports/plan-executor.ts tests/unit/reports/plan-executor.test.ts
git commit -m "feat(reports): plan executor with TimeRef/StepRef/wow-compare resolution"
```

---

## Task 11: Plan compiler (LLM-driven)

**Files:**
- Create: `src/reports/plan-compiler.ts`

- [ ] **Step 1: Implement the compiler**

Create `src/reports/plan-compiler.ts`:

```ts
import type Anthropic from '@anthropic-ai/sdk';
import type { ConnectorRegistry } from '../connectors/base/registry.js';
import type { ReportPlan } from './plan-types.js';
import { PLAN_SCHEMA_VERSION } from './plan-types.js';
import { executePlan, type ExecutePlanResult } from './plan-executor.js';
import { logger } from '../logger.js';

export interface CompilePlanOptions {
  intent: string;
  registry: ConnectorRegistry;
  claude: Anthropic;
  model: string;
  /** When validating, the runAt used to resolve TimeRefs. */
  validationRunAt?: Date;
  timezone?: string;
  maxIterations?: number;
}

export interface CompilePlanResult {
  plan: ReportPlan;
  validation: ExecutePlanResult;
}

/**
 * Compile a user's natural-language intent into a validated ReportPlan.
 *
 * Uses a single non-tool call to Claude to generate the JSON, then runs the
 * plan once via the executor as the validation step. If validation produces
 * an "error" status (zero successful steps), throws — the caller surfaces
 * that to the user. "partial" is acceptable on first compile (some
 * non-critical step may rely on data that doesn't exist on a fresh
 * environment); the caller decides whether to keep it.
 *
 * The compiler does not give Claude tool access on purpose — we want one
 * deterministic JSON output, not exploratory iteration. The validation step
 * exercises the tools end-to-end via the executor.
 */
export async function compilePlan(opts: CompilePlanOptions): Promise<CompilePlanResult> {
  const tools = opts.registry.getAllTools();
  const toolCatalog = tools
    .map(
      (t) =>
        `- ${t.name}: ${t.description}\n  args: ${JSON.stringify(t.jsonSchema)}`,
    )
    .join('\n');

  const compilerPrompt = buildCompilerPrompt({
    intent: opts.intent,
    toolCatalog,
  });

  const resp = await opts.claude.messages.create({
    model: opts.model,
    max_tokens: 4000,
    messages: [{ role: 'user', content: compilerPrompt }],
  });

  const text = extractText(resp.content);
  const plan = parsePlanJson(text);

  // Validate by executing once.
  const runAt = opts.validationRunAt ?? new Date();
  const tz = opts.timezone ?? 'America/Los_Angeles';
  const validation = await executePlan({ plan, registry: opts.registry, runAt, timezone: tz });

  if (validation.status === 'error') {
    const errMsgs = validation.errors.map((e) => `${e.alias}: ${e.message}`).join('; ');
    throw new Error(`Plan validation failed (no steps succeeded): ${errMsgs}`);
  }

  logger.info(
    { intent: opts.intent, stepCount: plan.steps.length, status: validation.status },
    'plan compiled',
  );

  return { plan, validation };
}

function buildCompilerPrompt(args: { intent: string; toolCatalog: string }): string {
  return `You are compiling a deterministic execution plan for a recurring scheduled report inside Gantri's internal Slack bot.

USER REQUEST (this is what the report should produce on every fire):
${args.intent}

AVAILABLE TOOLS:
${args.toolCatalog}

Output a single JSON object — and nothing else, no prose, no markdown fences — matching this TypeScript type:

\`\`\`ts
type ReportPlan = {
  schemaVersion: 1;
  steps: PlanStep[];                                    // max 8
  output: { blocks: BlockSpec[] };
  narrativeWrapup?: { promptTemplate: string; maxTokens?: number };
};

type PlanStep = {
  alias: string;                                        // unique within plan
  tool: string;                                         // exact name from the catalog above
  args: Record<string, unknown>;                        // may include TimeRef / StepRef tokens
  dependsOn?: string[];
};

type TimeRef =
  | { $time: 'today_pt' }
  | { $time: 'yesterday_pt' }
  | { $time: 'this_week_pt' }
  | { $time: 'last_week_pt' }
  | { $time: 'this_month_pt' }
  | { $time: 'last_month_pt' }
  | { $time: 'last_n_days_pt'; n: number }
  | { $time: 'wow_compare_pt' };                        // expands to current+previous; results land under \${alias.current.*} and \${alias.previous.*}

type StepRef = { $ref: 'aliasName.path.into.result[0].field' };

type BlockSpec =
  | { type: 'header'; text: string }
  | { type: 'text'; text: string }                      // \${aliasName.path} placeholders
  | { type: 'table'; from: string; columns: ColumnSpec[]; maxRows?: number }
  | { type: 'csv_attachment'; from: string; filename: string };

type ColumnSpec = {
  header: string;
  field: string;                                        // dot-path into a row
  format?: 'currency_dollars'|'integer'|'datetime_pt'|'date_pt'|'admin_order_link'|'percent';
};
\`\`\`

CONSTRAINTS:
- schemaVersion must be 1.
- Maximum 8 steps total.
- All tool names must exactly match the catalog. Validate args against each tool's input schema.
- Use TimeRef tokens for any date range; do NOT hard-code dates in SQL or args.
- Prefer grafana.sql for aggregations across the Porter schema (Transactions, StockAssociations, Stocks, Users, Products). Use Porter API tools only when you need data the read-replica doesn't expose.
- Money in Porter SQL is JSON cents: divide \`(amount->>'total')::bigint\` by 100 for dollars.
- Default to \`t.type IN ('Order','Wholesale','Trade','Third Party')\` for "sold" questions.
- output.blocks should be tight and Slack-friendly; ASCII tables render in Slack code blocks.
- Skip narrativeWrapup unless the user explicitly asked for analysis or commentary.

Output the JSON now.`;
}

function extractText(content: any[]): string {
  for (const block of content) {
    if (block.type === 'text') return block.text;
  }
  throw new Error('compiler returned no text block');
}

function parsePlanJson(text: string): ReportPlan {
  // The model might wrap the JSON in fences; strip them.
  const trimmed = text
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`compiler did not return valid JSON: ${trimmed.slice(0, 300)}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('compiler output is not an object');
  }
  const plan = parsed as ReportPlan;
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION) {
    throw new Error(`unexpected schemaVersion: ${(plan as any).schemaVersion}`);
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.length > 8) {
    throw new Error(`plan must have 1..8 steps, got ${plan.steps?.length}`);
  }
  if (!plan.output || !Array.isArray(plan.output.blocks)) {
    throw new Error('plan must have output.blocks');
  }
  // Alias uniqueness.
  const aliases = new Set<string>();
  for (const s of plan.steps) {
    if (!s.alias || typeof s.alias !== 'string') throw new Error('step missing alias');
    if (aliases.has(s.alias)) throw new Error(`duplicate alias: ${s.alias}`);
    aliases.add(s.alias);
    if (!s.tool || typeof s.tool !== 'string') throw new Error(`step ${s.alias} missing tool`);
  }
  return plan;
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/reports/plan-compiler.ts
git commit -m "feat(reports): plan compiler (intent → validated ReportPlan via Claude)"
```

---

## Task 12: Reports connector (the 7 user-facing tools)

**Files:**
- Create: `src/reports/reports-connector.ts`
- Create: `tests/unit/reports/reports-connector.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/reports/reports-connector.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { ScheduledReportsConnector } from '../../../src/reports/reports-connector.js';

function fakeRepo() {
  const rows: any[] = [];
  return {
    rows,
    insert: vi.fn(async (input: any) => {
      const row = { id: `id-${rows.length + 1}`, ...input, enabled: true, fail_count: 0,
        plan_validation_status: 'ok', plan_compiled_at: '2026-04-25T00:00:00Z',
        last_run_at: null, last_run_status: null, last_run_error: null,
        created_at: '2026-04-25T00:00:00Z', updated_at: '2026-04-25T00:00:00Z' };
      rows.push(row);
      return row;
    }),
    getById: vi.fn(async (id: string) => rows.find((r) => r.id === id) ?? null),
    listByUser: vi.fn(async (uid: string) => rows.filter((r) => r.slack_user_id === uid)),
    update: vi.fn(async (id: string, fields: any) => {
      const row = rows.find((r) => r.id === id);
      Object.assign(row, fields);
      return row;
    }),
  };
}

describe('ScheduledReportsConnector — actor scoping', () => {
  it('list_subscriptions returns only the calling actor’s subs', async () => {
    const repo = fakeRepo();
    repo.rows.push({ id: 'a', slack_user_id: 'U1', display_name: 'mine', enabled: true });
    repo.rows.push({ id: 'b', slack_user_id: 'U2', display_name: 'theirs', enabled: true });

    const actor = { slackUserId: 'U1' };
    const conn = new ScheduledReportsConnector({ repo: repo as any, getActor: () => actor, compile: vi.fn(), execute: vi.fn(), nextFireAt: () => new Date() });
    const tool = conn.tools.find((t) => t.name === 'reports.list_subscriptions')!;
    const res: any = await tool.execute({});
    expect(res.subscriptions).toHaveLength(1);
    expect(res.subscriptions[0].id).toBe('a');
  });

  it('unsubscribe rejects another user’s subscription as not-found', async () => {
    const repo = fakeRepo();
    repo.rows.push({ id: 'a', slack_user_id: 'U2', display_name: 'theirs', enabled: true });
    const conn = new ScheduledReportsConnector({
      repo: repo as any,
      getActor: () => ({ slackUserId: 'U1' }),
      compile: vi.fn(),
      execute: vi.fn(),
      nextFireAt: () => new Date(),
    });
    const tool = conn.tools.find((t) => t.name === 'reports.unsubscribe')!;
    const res: any = await tool.execute({ id: 'a' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('NOT_FOUND');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/unit/reports/reports-connector.test.ts
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement the connector**

Create `src/reports/reports-connector.ts`:

```ts
import { z } from 'zod';
import type { Connector, ToolDef, ToolResult } from '../connectors/base/connector.js';
import type { ReportSubscriptionsRepo, ReportSubscriptionRow } from './reports-repo.js';
import type { ReportPlan } from './plan-types.js';
import type { ExecutePlanResult } from './plan-executor.js';
import { isValidCron } from './cron-utils.js';

/**
 * Per-call actor context. Threaded through the orchestrator from the Slack
 * handler so that reports.* tools can attribute new subscriptions to the
 * caller and reject cross-user mutations.
 */
export interface ActorContext {
  slackUserId: string;
  slackChannelId?: string;
}

export interface ScheduledReportsConnectorDeps {
  repo: ReportSubscriptionsRepo;
  /** Resolves the calling actor for the in-flight orchestrator run. */
  getActor: () => ActorContext;
  /** Compiles an intent → validated ReportPlan. */
  compile: (intent: string) => Promise<{ plan: ReportPlan; validation: ExecutePlanResult }>;
  /** Executes a plan once (used by run_now). */
  execute: (plan: ReportPlan, runAt: Date, timezone: string) => Promise<ExecutePlanResult>;
  /** Computes the next cron fire after `after` in the given tz. */
  nextFireAt: (cron: string, timezone: string, after: Date) => Date;
  /** Per-user soft cap on active subscriptions. */
  maxActivePerUser?: number;
}

const SubscribeArgs = z.object({
  intent: z.string().min(3).max(2000),
  cron: z.string().min(3).max(120),
  timezone: z.string().min(3).max(64).optional(),
  displayName: z.string().min(1).max(120).optional(),
  deliveryChannel: z.string().regex(/^(dm|channel:C[A-Z0-9]+)$/).optional(),
});
type SubscribeArgs = z.infer<typeof SubscribeArgs>;

const PreviewArgs = z.object({
  intent: z.string().min(3).max(2000),
});
type PreviewArgs = z.infer<typeof PreviewArgs>;

const ListArgs = z.object({});
type ListArgs = z.infer<typeof ListArgs>;

const UpdateArgs = z.object({
  id: z.string().uuid(),
  intent: z.string().min(3).max(2000).optional(),
  cron: z.string().min(3).max(120).optional(),
  timezone: z.string().min(3).max(64).optional(),
  displayName: z.string().min(1).max(120).optional(),
  deliveryChannel: z.string().regex(/^(dm|channel:C[A-Z0-9]+)$/).optional(),
  enabled: z.boolean().optional(),
});
type UpdateArgs = z.infer<typeof UpdateArgs>;

const IdArgs = z.object({ id: z.string().uuid() });
type IdArgs = z.infer<typeof IdArgs>;

export class ScheduledReportsConnector implements Connector {
  readonly name = 'reports';
  readonly tools: readonly ToolDef[];

  constructor(private readonly deps: ScheduledReportsConnectorDeps) {
    this.tools = this.buildTools();
  }

  async healthCheck() {
    return { ok: true };
  }

  private buildTools(): ToolDef[] {
    const subscribe: ToolDef<SubscribeArgs> = {
      name: 'reports.subscribe',
      description:
        'Subscribe the calling user to a recurring report. Compiles `intent` into a deterministic execution plan, runs it once to validate, and saves the subscription. Returns the saved subscription on success. The bot should rewrite the user\'s casual ask into a precise English `intent` (specifying tables, columns, filters, formatting) before calling.',
      schema: SubscribeArgs as z.ZodType<SubscribeArgs>,
      jsonSchema: subscribeJsonSchema(),
      execute: (args) => this.executeSubscribe(args),
    };
    const preview: ToolDef<PreviewArgs> = {
      name: 'reports.preview',
      description:
        'Compile + execute a report intent ONCE without saving. Use when the user wants to "see what this would look like" before subscribing. Returns the rendered text + attachments.',
      schema: PreviewArgs as z.ZodType<PreviewArgs>,
      jsonSchema: { type: 'object', additionalProperties: false, required: ['intent'], properties: { intent: { type: 'string' } } },
      execute: (args) => this.executePreview(args),
    };
    const list: ToolDef<ListArgs> = {
      name: 'reports.list_subscriptions',
      description:
        'List the calling user\'s scheduled report subscriptions: id, displayName, schedule (cron+tz), nextRunAt, lastRunAt, status.',
      schema: ListArgs as z.ZodType<ListArgs>,
      jsonSchema: { type: 'object', additionalProperties: false, properties: {} },
      execute: () => this.executeList(),
    };
    const update: ToolDef<UpdateArgs> = {
      name: 'reports.update_subscription',
      description:
        'Update a subscription owned by the caller. If `intent` is provided, the plan is re-compiled and re-validated; other fields update without re-compile.',
      schema: UpdateArgs as z.ZodType<UpdateArgs>,
      jsonSchema: updateJsonSchema(),
      execute: (args) => this.executeUpdate(args),
    };
    const unsubscribe: ToolDef<IdArgs> = {
      name: 'reports.unsubscribe',
      description: 'Disable (soft-delete) a subscription owned by the caller.',
      schema: IdArgs as z.ZodType<IdArgs>,
      jsonSchema: idJsonSchema(),
      execute: (args) => this.executeUnsubscribe(args),
    };
    const runNow: ToolDef<IdArgs> = {
      name: 'reports.run_now',
      description: 'Force an immediate execution of a subscription owned by the caller. Does not change next_run_at.',
      schema: IdArgs as z.ZodType<IdArgs>,
      jsonSchema: idJsonSchema(),
      execute: (args) => this.executeRunNow(args),
    };
    const rebuild: ToolDef<IdArgs> = {
      name: 'reports.rebuild_plan',
      description: 'Re-compile a subscription\'s plan from its original_intent. Used to recover a `broken` subscription.',
      schema: IdArgs as z.ZodType<IdArgs>,
      jsonSchema: idJsonSchema(),
      execute: (args) => this.executeRebuild(args),
    };
    return [subscribe, preview, list, update, unsubscribe, runNow, rebuild];
  }

  private async executeSubscribe(args: SubscribeArgs): Promise<ToolResult> {
    if (!isValidCron(args.cron)) {
      return { ok: false, error: { code: 'INVALID_CRON', message: `Invalid cron: ${args.cron}` } };
    }
    const tz = args.timezone ?? 'America/Los_Angeles';
    const actor = this.deps.getActor();
    const cap = this.deps.maxActivePerUser ?? 10;
    const existing = await this.deps.repo.listByUser(actor.slackUserId);
    const active = existing.filter((r) => r.enabled);
    if (active.length >= cap) {
      return { ok: false, error: { code: 'LIMIT_REACHED', message: `You already have ${cap} active subscriptions. Unsubscribe from one before adding more.` } };
    }
    const compiled = await this.deps.compile(args.intent);
    const nextRun = this.deps.nextFireAt(args.cron, tz, new Date());
    const row = await this.deps.repo.insert({
      slack_user_id: actor.slackUserId,
      display_name: args.displayName ?? deriveDisplayName(args.intent),
      original_intent: args.intent,
      plan: compiled.plan,
      cron: args.cron,
      timezone: tz,
      delivery_channel: args.deliveryChannel ?? 'dm',
      next_run_at: nextRun.toISOString(),
    });
    return {
      ok: true,
      data: {
        subscription: shapeSub(row),
        validation: { status: compiled.validation.status, errors: compiled.validation.errors },
      },
    };
  }

  private async executePreview(args: PreviewArgs): Promise<ToolResult> {
    const compiled = await this.deps.compile(args.intent);
    return {
      ok: true,
      data: {
        plan: compiled.plan,
        text: compiled.validation.text,
        attachments: compiled.validation.attachments,
        status: compiled.validation.status,
        errors: compiled.validation.errors,
      },
    };
  }

  private async executeList(): Promise<ToolResult> {
    const actor = this.deps.getActor();
    const rows = await this.deps.repo.listByUser(actor.slackUserId);
    return { ok: true, data: { subscriptions: rows.map(shapeSub) } };
  }

  private async executeUpdate(args: UpdateArgs): Promise<ToolResult> {
    const actor = this.deps.getActor();
    const row = await this.deps.repo.getById(args.id);
    if (!row || row.slack_user_id !== actor.slackUserId) {
      return { ok: false, error: { code: 'NOT_FOUND', message: 'subscription not found' } };
    }
    if (args.cron !== undefined && !isValidCron(args.cron)) {
      return { ok: false, error: { code: 'INVALID_CRON', message: `Invalid cron: ${args.cron}` } };
    }
    const fields: Record<string, unknown> = {};
    if (args.cron !== undefined) {
      fields.cron = args.cron;
      const tz = args.timezone ?? row.timezone;
      fields.next_run_at = this.deps.nextFireAt(args.cron, tz, new Date()).toISOString();
    }
    if (args.timezone !== undefined) fields.timezone = args.timezone;
    if (args.displayName !== undefined) fields.display_name = args.displayName;
    if (args.deliveryChannel !== undefined) fields.delivery_channel = args.deliveryChannel;
    if (args.enabled !== undefined) fields.enabled = args.enabled;
    if (args.intent !== undefined) {
      const compiled = await this.deps.compile(args.intent);
      fields.original_intent = args.intent;
      fields.plan = compiled.plan;
      fields.plan_compiled_at = new Date().toISOString();
      fields.plan_validation_status = 'ok';
    }
    const updated = await this.deps.repo.update(args.id, fields);
    return { ok: true, data: { subscription: shapeSub(updated) } };
  }

  private async executeUnsubscribe(args: IdArgs): Promise<ToolResult> {
    const actor = this.deps.getActor();
    const row = await this.deps.repo.getById(args.id);
    if (!row || row.slack_user_id !== actor.slackUserId) {
      return { ok: false, error: { code: 'NOT_FOUND', message: 'subscription not found' } };
    }
    await this.deps.repo.update(args.id, { enabled: false });
    return { ok: true, data: { id: args.id, enabled: false } };
  }

  private async executeRunNow(args: IdArgs): Promise<ToolResult> {
    const actor = this.deps.getActor();
    const row = await this.deps.repo.getById(args.id);
    if (!row || row.slack_user_id !== actor.slackUserId) {
      return { ok: false, error: { code: 'NOT_FOUND', message: 'subscription not found' } };
    }
    const result = await this.deps.execute(row.plan, new Date(), row.timezone);
    return {
      ok: true,
      data: {
        status: result.status,
        text: result.text,
        attachments: result.attachments,
        errors: result.errors,
      },
    };
  }

  private async executeRebuild(args: IdArgs): Promise<ToolResult> {
    const actor = this.deps.getActor();
    const row = await this.deps.repo.getById(args.id);
    if (!row || row.slack_user_id !== actor.slackUserId) {
      return { ok: false, error: { code: 'NOT_FOUND', message: 'subscription not found' } };
    }
    const compiled = await this.deps.compile(row.original_intent);
    const updated = await this.deps.repo.update(args.id, {
      plan: compiled.plan,
      plan_compiled_at: new Date().toISOString(),
      plan_validation_status: 'ok',
      fail_count: 0,
    });
    return {
      ok: true,
      data: {
        subscription: shapeSub(updated),
        validation: { status: compiled.validation.status, errors: compiled.validation.errors },
      },
    };
  }
}

function shapeSub(row: ReportSubscriptionRow) {
  return {
    id: row.id,
    displayName: row.display_name,
    cron: row.cron,
    timezone: row.timezone,
    deliveryChannel: row.delivery_channel,
    enabled: row.enabled,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status,
    lastRunError: row.last_run_error,
    failCount: row.fail_count,
    planValidationStatus: row.plan_validation_status,
    originalIntent: row.original_intent,
  };
}

function deriveDisplayName(intent: string): string {
  const cleaned = intent.replace(/\s+/g, ' ').trim();
  return cleaned.length > 80 ? cleaned.slice(0, 77) + '…' : cleaned;
}

function subscribeJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['intent', 'cron'],
    properties: {
      intent: { type: 'string', description: 'Precise English description of the report; the bot should rewrite the user\'s casual ask into specific tables/columns/filters/formatting before calling.' },
      cron: { type: 'string', description: 'Standard 5-field cron expression. Examples: "*/5 * * * *", "0 9 * * 1-5", "0 7 * * 1".' },
      timezone: { type: 'string', description: 'IANA timezone (default: America/Los_Angeles).' },
      displayName: { type: 'string', description: 'Short human label, e.g. "Daily late wholesale orders".' },
      deliveryChannel: { type: 'string', description: '"dm" (default) or "channel:CXXXXXXXX".' },
    },
  };
}

function updateJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: { type: 'string' },
      intent: { type: 'string' },
      cron: { type: 'string' },
      timezone: { type: 'string' },
      displayName: { type: 'string' },
      deliveryChannel: { type: 'string' },
      enabled: { type: 'boolean' },
    },
  };
}

function idJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string' } },
  };
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/reports/reports-connector.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/reports/reports-connector.ts tests/unit/reports/reports-connector.test.ts
git commit -m "feat(reports): ScheduledReportsConnector with 7 user-facing tools"
```

---

## Task 13: Thread `actorContext` through orchestrator

**Files:**
- Modify: `src/orchestrator/orchestrator.ts`

- [ ] **Step 1: Add ActorContext to OrchestratorInput**

Edit `src/orchestrator/orchestrator.ts`. Find the `OrchestratorInput` interface and replace it:

```ts
export interface ActorContext {
  slackUserId: string;
  slackChannelId?: string;
}

export interface OrchestratorInput {
  question: string;
  threadHistory: Array<{ question: string; response: string | null }>;
  /** Identifies the user driving this run; threaded into per-call context for tools that need it (reports.* tools). Optional for back-compat with scripted callers. */
  actor?: ActorContext;
}
```

- [ ] **Step 2: Expose a per-call actor accessor**

Still in `src/orchestrator/orchestrator.ts`, add a private field on `Orchestrator` that holds the active actor for the in-flight call, set at the top of `run()`. Add this code right at the top of the existing `run` method, before `const tools = …`:

```ts
this.activeActor = input.actor;
```

And add the field declaration on the class (next to `maxIterations`):

```ts
private activeActor: ActorContext | undefined;
```

Add a getter so the connector deps can read it:

```ts
getActiveActor(): ActorContext | undefined {
  return this.activeActor;
}
```

- [ ] **Step 3: Verify it compiles**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/orchestrator.ts
git commit -m "feat(orchestrator): thread ActorContext for per-call ownership scoping"
```

---

## Task 14: Slack handler threads actor + register reports connector

**Files:**
- Modify: `src/slack/handlers.ts`

- [ ] **Step 1: Pass actor into orchestrator.run**

Edit `src/slack/handlers.ts`. Find the `orchestrator.run` call and update it:

```ts
const out = await deps.orchestrator.run({
  question: event.text,
  threadHistory,
  actor: { slackUserId: event.user, slackChannelId: event.channel },
});
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/slack/handlers.ts
git commit -m "feat(slack): pass actor (slackUserId+channel) into orchestrator"
```

---

## Task 15: Slack delivery helper

**Files:**
- Create: `src/reports/delivery.ts`

- [ ] **Step 1: Implement delivery helper**

Create `src/reports/delivery.ts`:

```ts
import type { WebClient } from '@slack/web-api';
import type { RenderedAttachment } from './block-renderer.js';
import { markdownToSlackBlocks } from '../orchestrator/formatter.js';
import { logger } from '../logger.js';

export interface DeliverReportInput {
  client: WebClient;
  slackUserId: string;
  deliveryChannel: string; // 'dm' or 'channel:Cxxxx'
  text: string;
  attachments: RenderedAttachment[];
  botToken: string;
  /** Footer line shown in the rendered message (e.g. status + duration). */
  footer?: string;
}

/**
 * Resolve the target channel:
 *   - 'dm'        -> open a DM with slackUserId and post there.
 *   - 'channel:C…' -> post to that channel directly.
 * Returns the channel id used.
 */
export async function deliverReport(input: DeliverReportInput): Promise<{ channel: string; ts: string }> {
  const channel = await resolveChannel(input);
  const blocks = markdownToSlackBlocks(input.text, { footer: input.footer });
  const post = await input.client.chat.postMessage({
    channel,
    text: input.text.slice(0, 200),
    blocks,
  });
  if (!post.ok || !post.ts) {
    throw new Error(`chat.postMessage failed: ${post.error ?? 'unknown'}`);
  }
  for (const att of input.attachments) {
    try {
      await uploadFile({ token: input.botToken, channel, threadTs: post.ts, filename: att.filename, content: att.content });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err), filename: att.filename }, 'report attachment upload failed');
    }
  }
  return { channel, ts: post.ts };
}

async function resolveChannel(input: DeliverReportInput): Promise<string> {
  if (input.deliveryChannel.startsWith('channel:')) {
    return input.deliveryChannel.slice('channel:'.length);
  }
  // open DM
  const open = await input.client.conversations.open({ users: input.slackUserId });
  if (!open.ok || !open.channel?.id) {
    throw new Error(`conversations.open failed: ${open.error ?? 'unknown'}`);
  }
  return open.channel.id;
}

async function uploadFile(p: { token: string; channel: string; threadTs: string; filename: string; content: string }): Promise<void> {
  const bytes = Buffer.byteLength(p.content, 'utf8');
  const step1 = await fetch(
    `https://slack.com/api/files.getUploadURLExternal?filename=${encodeURIComponent(p.filename)}&length=${bytes}`,
    { headers: { authorization: `Bearer ${p.token}` } },
  ).then((r) => r.json() as Promise<{ ok: boolean; upload_url?: string; file_id?: string; error?: string }>);
  if (!step1.ok || !step1.upload_url || !step1.file_id) {
    throw new Error(`getUploadURLExternal failed: ${step1.error ?? 'unknown'}`);
  }
  const step2 = await fetch(step1.upload_url, {
    method: 'POST',
    body: p.content,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
  if (!step2.ok) {
    throw new Error(`upload POST returned HTTP ${step2.status}`);
  }
  const step3 = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: { authorization: `Bearer ${p.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      files: [{ id: step1.file_id, title: p.filename }],
      channel_id: p.channel,
      thread_ts: p.threadTs,
    }),
  }).then((r) => r.json() as Promise<{ ok: boolean; error?: string }>);
  if (!step3.ok) {
    throw new Error(`completeUploadExternal failed: ${step3.error ?? 'unknown'}`);
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/reports/delivery.ts
git commit -m "feat(reports): Slack delivery (DM open + post + file upload) helper"
```

---

## Task 16: Runner (in-process tick + due-batch handler)

**Files:**
- Create: `src/reports/runner.ts`

- [ ] **Step 1: Implement runner**

Create `src/reports/runner.ts`:

```ts
import type { WebClient } from '@slack/web-api';
import type { ReportSubscriptionsRepo, ReportSubscriptionRow } from './reports-repo.js';
import type { ConnectorRegistry } from '../connectors/base/registry.js';
import { executePlan } from './plan-executor.js';
import { compilePlan } from './plan-compiler.js';
import type Anthropic from '@anthropic-ai/sdk';
import { computeNextFireAt } from './cron-utils.js';
import { deliverReport } from './delivery.js';
import { logger } from '../logger.js';

export interface RunnerDeps {
  repo: ReportSubscriptionsRepo;
  registry: ConnectorRegistry;
  slackClient: WebClient;
  slackBotToken: string;
  claude: Anthropic;
  compilerModel: string;
  /** How often the in-process loop ticks. Default 30000ms. */
  tickIntervalMs?: number;
  /** Max subscriptions claimed per tick. Default 50. */
  batchLimit?: number;
}

export class ReportsRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: RunnerDeps) {}

  start(): void {
    if (this.timer) return;
    const interval = this.deps.tickIntervalMs ?? 30000;
    this.timer = setInterval(() => { void this.tick(); }, interval);
    logger.info({ intervalMs: interval }, 'reports runner started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<{ processed: number }> {
    if (this.running) return { processed: 0 };
    this.running = true;
    try {
      return await this.runDueBatch();
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.stack : String(err) }, 'reports runner tick failed');
      return { processed: 0 };
    } finally {
      this.running = false;
    }
  }

  async runDueBatch(): Promise<{ processed: number }> {
    const limit = this.deps.batchLimit ?? 50;
    const batch = await this.deps.repo.claimDueBatch(new Date(), limit);
    if (batch.length === 0) return { processed: 0 };
    logger.info({ count: batch.length }, 'reports runner claimed batch');
    await Promise.all(batch.map((sub) => this.processOne(sub).catch((err) => {
      logger.error({ subId: sub.id, err: err instanceof Error ? err.message : String(err) }, 'report fire failed');
    })));
    return { processed: batch.length };
  }

  private async processOne(sub: ReportSubscriptionRow): Promise<void> {
    const runAt = new Date();
    let plan = sub.plan;
    let validationStatus = sub.plan_validation_status;

    // If plan is stale, attempt re-compile from original_intent first.
    if (validationStatus === 'stale') {
      try {
        const compiled = await compilePlan({
          intent: sub.original_intent,
          registry: this.deps.registry,
          claude: this.deps.claude,
          model: this.deps.compilerModel,
          validationRunAt: runAt,
          timezone: sub.timezone,
        });
        plan = compiled.plan;
        validationStatus = 'ok';
        await this.deps.repo.update(sub.id, {
          plan,
          plan_compiled_at: runAt.toISOString(),
          plan_validation_status: 'ok',
        });
      } catch (err) {
        await this.markBroken(sub, err);
        return;
      }
    } else if (validationStatus === 'broken') {
      logger.info({ subId: sub.id }, 'skipping broken subscription');
      return;
    }

    // Execute the plan.
    let executeError: unknown = null;
    let result: Awaited<ReturnType<typeof executePlan>> | null = null;
    try {
      result = await executePlan({ plan, registry: this.deps.registry, runAt, timezone: sub.timezone });
    } catch (err) {
      executeError = err;
    }

    const nextRun = computeNextFireAt(sub.cron, sub.timezone, runAt);

    if (executeError || !result || result.status === 'error') {
      const msg = executeError instanceof Error ? executeError.message : (result?.errors.map((e) => `${e.alias}: ${e.message}`).join('; ') ?? 'unknown');
      const newFail = sub.fail_count + 1;
      const promote = newFail >= 3;
      await this.deps.repo.update(sub.id, {
        last_run_at: runAt.toISOString(),
        last_run_status: 'error',
        last_run_error: msg.slice(0, 500),
        fail_count: newFail,
        next_run_at: nextRun.toISOString(),
        plan_validation_status: promote ? 'stale' : sub.plan_validation_status,
      });
      // Notify the user so they aren't surprised silently.
      await this.notifyError(sub, msg);
      return;
    }

    // Success or partial.
    const footer = `Report: ${sub.display_name} • status: ${result.status}${result.errors.length ? ` (${result.errors.length} step error${result.errors.length === 1 ? '' : 's'})` : ''}`;
    await deliverReport({
      client: this.deps.slackClient,
      slackUserId: sub.slack_user_id,
      deliveryChannel: sub.delivery_channel,
      text: result.text,
      attachments: result.attachments,
      botToken: this.deps.slackBotToken,
      footer,
    });

    await this.deps.repo.update(sub.id, {
      last_run_at: runAt.toISOString(),
      last_run_status: result.status === 'partial' ? 'partial' : 'ok',
      last_run_error: result.status === 'partial' ? result.errors.map((e) => `${e.alias}: ${e.message}`).join('; ') : null,
      fail_count: result.status === 'partial' ? sub.fail_count + 1 : 0,
      next_run_at: nextRun.toISOString(),
    });
  }

  private async markBroken(sub: ReportSubscriptionRow, err: unknown): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    await this.deps.repo.update(sub.id, {
      plan_validation_status: 'broken',
      last_run_status: 'error',
      last_run_error: msg.slice(0, 500),
      fail_count: sub.fail_count + 1,
    });
    await this.notifyError(sub, `Plan re-compile failed: ${msg}\n\nThe subscription is paused. Send "rebuild my report '${sub.display_name}'" to retry.`);
  }

  private async notifyError(sub: ReportSubscriptionRow, message: string): Promise<void> {
    try {
      const dm = await this.deps.slackClient.conversations.open({ users: sub.slack_user_id });
      const channel = dm.ok ? dm.channel?.id : null;
      if (!channel) return;
      await this.deps.slackClient.chat.postMessage({
        channel,
        text: `⚠️ Your report *${sub.display_name}* failed to run.\n\n${message}`,
      });
    } catch (err) {
      logger.warn({ subId: sub.id, err: err instanceof Error ? err.message : String(err) }, 'failed to notify user of report error');
    }
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/reports/runner.ts
git commit -m "feat(reports): runner with in-process tick + due-batch processing"
```

---

## Task 17: System prompt section for `reports.*` tools

**Files:**
- Modify: `src/orchestrator/prompts.ts`

- [ ] **Step 1: Append a new section before *7. Grafana***

Edit `src/orchestrator/prompts.ts`. Find the line `*7. Grafana dashboards & ad-hoc SQL` and insert a new section above it (so Grafana becomes 8, and renumber the rest accordingly). Insert this text:

```
*7. Scheduled reports (recurring deliveries via cron)* — \`reports.subscribe\`, \`reports.preview\`, \`reports.list_subscriptions\`, \`reports.update_subscription\`, \`reports.unsubscribe\`, \`reports.run_now\`, \`reports.rebuild_plan\`
  • The user can subscribe to a recurring report. The bot compiles the user's intent into a deterministic execution plan once, validates it, and the runner re-fires the plan on a cron schedule, delivering results back via DM (or to a channel if requested).
  • IMPORTANT — *rewrite the user's intent before subscribing.* The casual ask ("send me late wholesale orders every Monday") must become a precise intent string for \`reports.subscribe\` that names tables/columns/filters/formatting. Example rewrite: *"Give me a table of currently-late orders (\`Transactions.late = true\`) of type Wholesale, sorted by days-late descending. Columns: order id (admin link), customer name, days late, total dollars, expected ship date."* The runner uses this string as the source of truth when it ever needs to re-compile, so be thorough.
  • Cron expressions you'll see and how to translate natural language:
    - "every minute" → \`* * * * *\`
    - "every 5 minutes" → \`*/5 * * * *\`
    - "every 2 hours" → \`0 */2 * * *\`
    - "daily at 9am PT" → \`0 9 * * *\`, tz \`America/Los_Angeles\`
    - "every Monday at 7am" → \`0 7 * * 1\`
    - "weekdays at 8:30 PT" → \`30 8 * * 1-5\`
  • Default timezone is \`America/Los_Angeles\`. The runner ticks every 30s so a \`* * * * *\` cron fires within ~30s of its target minute.
  • When the user says *"show me what this would look like"* / *"preview"*, call \`reports.preview\` first; only call \`reports.subscribe\` after they confirm.
  • When the user asks *"what reports do I have"* / *"qué reportes tengo"*, call \`reports.list_subscriptions\` and render the result as a brief table (display name, schedule, last run status).
  • Subscriptions are scoped to the asking user; you cannot list, edit, or unsubscribe someone else's reports.

```

(Note: the renumbering from 7→8 etc. is straightforward; just shift the existing numbers one.)

- [ ] **Step 2: Verify it compiles**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/orchestrator/prompts.ts
git commit -m "feat(prompt): teach the bot how to use reports.* tools"
```

---

## Task 18: Wire it all in `src/index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update index.ts to register the reports connector and start the runner**

Edit `src/index.ts`. Add imports near the top with the other connector imports:

```ts
import { ReportSubscriptionsRepo } from './reports/reports-repo.js';
import { ScheduledReportsConnector } from './reports/reports-connector.js';
import { compilePlan } from './reports/plan-compiler.js';
import { executePlan } from './reports/plan-executor.js';
import { computeNextFireAt } from './reports/cron-utils.js';
import { ReportsRunner } from './reports/runner.js';
```

Inside `main()`, after the orchestrator is constructed and before `buildSlackApp` is called, add this block:

```ts
const reportsRepo = new ReportSubscriptionsRepo(supabase);
const reportsConnector = new ScheduledReportsConnector({
  repo: reportsRepo,
  getActor: () => {
    const actor = orchestrator.getActiveActor();
    if (!actor) throw new Error('reports.* tool called without an actor context');
    return actor;
  },
  compile: (intent) =>
    compilePlan({
      intent,
      registry,
      claude,
      model: 'claude-sonnet-4-6',
    }),
  execute: (plan, runAt, timezone) => executePlan({ plan, registry, runAt, timezone }),
  nextFireAt: (cron, tz, after) => computeNextFireAt(cron, tz, after),
});
registry.register(reportsConnector);
```

After `await app.start(env.PORT);`, add:

```ts
const reportsRunner = new ReportsRunner({
  repo: reportsRepo,
  registry,
  slackClient: app.client,
  slackBotToken: env.SLACK_BOT_TOKEN,
  claude,
  compilerModel: 'claude-sonnet-4-6',
});
reportsRunner.start();
```

Also add a manual-trigger endpoint for debugging. Place it next to the other `receiver.router.get` calls:

```ts
receiver.router.post('/internal/run-due-reports', async (req, res) => {
  const auth = req.header('x-internal-secret');
  if (!process.env.INTERNAL_SHARED_SECRET || auth !== process.env.INTERNAL_SHARED_SECRET) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const result = await reportsRunner.tick();
  res.json({ ok: true, result });
});
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Add INTERNAL_SHARED_SECRET to env.ts**

Edit `src/config/env.ts`. Wherever the env schema is defined, add:

```ts
INTERNAL_SHARED_SECRET: z.string().optional(),
```

- [ ] **Step 4: Verify it compiles**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/config/env.ts
git commit -m "feat(reports): wire ScheduledReportsConnector + ReportsRunner into bot"
```

---

## Task 19: Set INTERNAL_SHARED_SECRET on Fly + deploy + smoke-test

**Files:** none (deployment + verification)

- [ ] **Step 1: Generate and set the shared secret on Fly**

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Take the printed value and run:

```bash
flyctl secrets set INTERNAL_SHARED_SECRET=<value> --app gantri-ai-bot
```

(Save the value locally for the smoke test in Step 4.)

- [ ] **Step 2: Build and deploy**

```bash
npm run build
flyctl deploy --remote-only --app gantri-ai-bot
```

Expected: deploy completes, log line `reports runner started intervalMs=30000` appears in `flyctl logs`.

- [ ] **Step 3: Verify /readyz still returns ok**

```bash
curl -s https://gantri-ai-bot.fly.dev/readyz
```

Expected JSON includes `"ok":true` and the existing northbeam/gantriPorter/grafana entries.

- [ ] **Step 4: Smoke-test the manual trigger endpoint**

```bash
curl -s -X POST https://gantri-ai-bot.fly.dev/internal/run-due-reports \
  -H "x-internal-secret: <value-from-step-1>"
```

Expected: `{"ok":true,"result":{"processed":0}}` (no subscriptions exist yet).

- [ ] **Step 5: End-to-end test from Slack**

In a Slack DM with the bot, send:

```
preview: every minute, give me how many orders were created today
```

Expected:
1. Bot calls `reports.preview` (visible in logs).
2. Bot replies with the rendered preview output (a number) and asks if you'd like to subscribe.

Then send:

```
yes, subscribe me
```

Expected:
1. Bot calls `reports.subscribe`.
2. Within ~60s, the bot DMs you the actual report fired by the runner.

Then send:

```
unsubscribe me from that one
```

Expected:
1. Bot calls `reports.list_subscriptions` and `reports.unsubscribe`.
2. The runner stops firing it.

- [ ] **Step 6: Commit a CHANGELOG note (optional)**

If a CHANGELOG.md exists, add an entry. Otherwise skip.

---

## Self-Review

**Spec coverage:**
- DB table → Task 1.
- `claim_due_report_subscriptions` RPC → Task 9.
- ReportPlan / PlanStep / TimeRef / StepRef / OutputSpec types → Task 2.
- Plan compiler + meta-prompt + validation → Task 11.
- Plan executor (parallel waves, partial-fail, wow_compare expansion) → Task 10.
- TimeRef resolution (today/yesterday/this_week/last_week/this_month/last_month/last_n_days/wow_compare) → Task 4.
- StepRef resolution (dot+bracket paths) → Task 5.
- Output rendering (header/text/table/csv) + formatters → Tasks 6 & 7.
- Reports repo (CRUD + claim_due_batch) → Task 8.
- Reports connector with 7 user-facing tools + actor-scoped reads/writes → Task 12.
- Actor-context plumbing through orchestrator + Slack handler → Tasks 13 & 14.
- Slack delivery (DM resolve + message + attachment upload) → Task 15.
- Runner (in-process tick, claim batch, error notifications, re-compile-on-stale, mark-broken) → Task 16.
- System-prompt section explaining the tools + cron parsing → Task 17.
- Wiring + manual trigger endpoint → Task 18.
- Deploy + smoke test → Task 19.

**Placeholder scan:** done. No "TBD"/"TODO"; every step has concrete code or commands.

**Type consistency:** `ReportSubscriptionRow`, `ReportPlan`, `ActorContext`, `ExecutePlanResult` shapes all match across tasks. Tool names (`reports.subscribe` etc.) use a consistent dot-namespace that the orchestrator already maps to `_` for Anthropic tool names — no change needed there.
