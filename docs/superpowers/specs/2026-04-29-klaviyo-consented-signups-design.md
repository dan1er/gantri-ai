# Klaviyo Consented Signups — Design Spec

**Date**: 2026-04-29
**Author**: Danny + Claude
**Status**: Draft (pending review)

## Goal

Expose monthly (and weekly/daily) counts of profiles that signed up to Klaviyo
in a window AND that currently have consented to email marketing
(`subscriptions.email.marketing.consent === 'SUBSCRIBED'`). Drives the DTC
marketing dashboard rollout per Lana's feedback (id `912ea6a5-...`).

The bot today claims this isn't possible; in fact it is, via the Profiles API
(`GET /api/profiles?filter=...&additional-fields[profile]=subscriptions`).

Reference numbers Lana validated against (YTD 2026):

| Month | Consented signups |
|------|---|
| Jan 2026 | 593 |
| Feb 2026 | 329 |
| Mar 2026 | 350 |
| Apr 1–24 2026 | 299 |
| **YTD total** | **1,571** |

## Non-goals

- SMS consent counts. Only email marketing consent is in scope.
- Signup attribution by list / segment / source. Out of scope; can be a
  follow-up if Lana asks for "where are signups coming from?".
- Real-time / sub-day freshness. Nightly granularity is sufficient.

## Definition of "consented signup"

A profile is counted as a "consented signup" in month M if **both**:

1. Its `created` timestamp falls within month M (bucketed by Pacific Time).
2. **At rollup time** (when the nightly job runs), its
   `subscriptions.email.marketing.consent === 'SUBSCRIBED'`.

Implication: if a profile signs up in Jan with consent, then unsubscribes in
March, the Jan count drops by 1 the next night. This matches how the upstream
puller Lana referenced works, and what Lana validates against. We accept the
drift.

## Architecture

```
┌─────────────────────────────────────┐
│  Nightly cron (03:00 PT / 10:00 UTC)│
└─────────────────┬───────────────────┘
                  ▼
┌─────────────────────────────────────┐
│   KlaviyoSignupRollupJob            │
│   - paginate /api/profiles by created│
│   - bucket by PT day                │
│   - count total + consented_email   │
│   - upsert all days (drift recompute)│
└─────────────────┬───────────────────┘
                  ▼ upsert
┌─────────────────────────────────────┐
│   klaviyo_signups_daily             │
│   (day PK, total, consented, ts)    │
└─────────────────┬───────────────────┘
                  ▼ read
┌─────────────────────────────────────┐
│   klaviyo.consented_signups (tool)  │
│   args: {dateRange, granularity}    │
│   - reads from rollup repo          │
│   - aggregates day → week/month JS  │
└─────────────────────────────────────┘
                  ▼
       Slack / Canvas / Live Reports
```

Single source of truth: the rollup table. The tool never hits Klaviyo. The
job is the only surface that does.

## Components

| # | File | Type | Responsibility |
|---|---|---|---|
| 1 | `migrations/0XXX_klaviyo_signups_daily.sql` | new | Table + index |
| 2 | `src/storage/repositories/klaviyo-signup-rollup.ts` | new | DB access |
| 3 | `src/connectors/klaviyo/client.ts` | extend | `searchProfilesByCreatedRange()` with unbounded pagination |
| 4 | `src/connectors/klaviyo/signup-rollup-job.ts` | new | Job: paginate, bucket, upsert |
| 5 | `src/connectors/klaviyo/connector.ts` | extend | `klaviyo.consented_signups` tool |
| 6 | `src/index.ts` | extend | Schedule job, wire repo, register tool |
| 7 | `src/reports/live/spec.ts` | extend | Whitelist tool |
| 8 | `src/orchestrator/prompts.ts` | extend | Document tool for LLM |
| 9 | `tests/unit/storage/repositories/klaviyo-signup-rollup.test.ts` | new | Repo tests |
| 10 | `tests/unit/connectors/klaviyo/signup-rollup-job.test.ts` | new | Job tests |
| 11 | `tests/unit/connectors/klaviyo/connector.test.ts` | extend | Tool tests |

### Boundaries

- **Client** owns HTTP + pagination only. Does not know "consented" or PT days.
  Returns raw `Profile` objects.
- **Job** is the only place that knows PT-bucketing and consent semantics. If
  the definition of "consented" changes, fix in one place.
- **Tool** never touches Klaviyo. Reads from rollup, aggregates daily → weekly
  /monthly in JS. Constant latency.
- **Repo** stores daily rows, not pre-aggregated. Aggregation lives in the
  tool, so granularity changes don't need migrations.

## Migration

```sql
CREATE TABLE klaviyo_signups_daily (
  day DATE PRIMARY KEY,
  signups_total INTEGER NOT NULL DEFAULT 0,
  signups_consented_email INTEGER NOT NULL DEFAULT 0,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_klaviyo_signups_daily_day ON klaviyo_signups_daily(day);
```

Rationale for single-day rows: matches `sales_daily_rollup` pattern. Weekly
and monthly are computed at query time so we can change granularity without
re-ingesting.

## Client extension

New method on `KlaviyoApiClient`:

```ts
async searchProfilesByCreatedRange(opts: {
  startDate: string; // YYYY-MM-DD inclusive
  endDate: string;   // YYYY-MM-DD inclusive
}): Promise<KlaviyoResource<KlaviyoProfileAttrs>[]>
```

- Endpoint: `GET /api/profiles`
- Filter param: `and(greater-or-equal(created,YYYY-MM-DD'T'00:00:00.000Z),less-than(created,(endDate+1day)'T'00:00:00.000Z))`
- Additional fields: `additional-fields[profile]=subscriptions`
- Pagination: walks `links.next` until exhausted (no 50-page cap — explicit
  opt-in via internal `_paginateUnbounded()` helper)
- Hard sanity cap: 10,000 pages (1M profiles) → throws if exceeded

Type for return:

```ts
interface KlaviyoProfileAttrs {
  email?: string;
  created: string; // ISO 8601
  subscriptions?: {
    email?: { marketing?: { consent?: 'SUBSCRIBED' | 'UNSUBSCRIBED' | 'NEVER_SUBSCRIBED' | string } };
    sms?: unknown;
  };
}
```

The existing client uses TS interfaces (not Zod), so this matches the pattern.

## Job

`KlaviyoSignupRollupJob.run()`:

1. `start = '2020-01-01'` (since-beginning history; full recompute every run)
2. `end = ptDay(now() - 1 day)` (yesterday in PT — today's incomplete bucket excluded)
3. `profiles = await client.searchProfilesByCreatedRange({startDate: start, endDate: end})`
4. Bucket by PT day:
   ```ts
   const counts = new Map<string, {total: number; consented: number}>();
   for (const p of profiles) {
     const day = ptDay(p.attributes.created);
     const consent = p.attributes.subscriptions?.email?.marketing?.consent === 'SUBSCRIBED';
     const cur = counts.get(day) ?? { total: 0, consented: 0 };
     cur.total++;
     if (consent) cur.consented++;
     counts.set(day, cur);
   }
   ```
5. `await repo.upsertManyDays([...rows])` — single batch INSERT...ON CONFLICT
6. Log `{ profiles_seen, days_upserted, duration_ms }`

Idempotent: re-running same night produces the same final state. If it crashes
mid-run, the table holds the previous night's state until next run completes.

## Tool

`klaviyo.consented_signups`:

```ts
schema: {
  dateRange: DateRangeArg, // shared canonical schema
  granularity: z.enum(['daily', 'weekly', 'monthly']).default('monthly'),
}

execute(args) {
  const { startDate, endDate } = normalizeDateRange(args.dateRange);
  const days = await repo.getRange(startDate, endDate);
  const rows = aggregate(days, args.granularity);
  return {
    period: { startDate, endDate },
    granularity: args.granularity,
    rows,
    rollup_freshness: {
      latest_computed_day: max(days, 'day'),
      computed_at: max(days, 'computed_at'),
    },
    note: 'Consent reflects current state. Counts may decrease over time as profiles unsubscribe.',
  };
}
```

Aggregation rules:

- `daily`: pass through
- `weekly`: ISO week (Mon–Sun), key `week_start: 'YYYY-MM-DD'`
- `monthly`: calendar month PT, key `month: 'YYYY-MM'`

Tool is whitelisted in `WHITELISTED_TOOLS` so Live Reports can call it with
`$REPORT_RANGE`.

## Wiring

`src/index.ts`:

- Instantiate `KlaviyoSignupRollupRepo(supabase)`
- Instantiate `KlaviyoSignupRollupJob({ client: klaviyoClient, repo, logger })`
- Schedule with existing scheduler at cron `0 10 * * *` (10:00 UTC = 03:00 PT
  during PST; one hour off during PDT — acceptable, this is a daily job)
- Pass repo into `KlaviyoConnector` so the tool can read it

`src/orchestrator/prompts.ts`: add tool documentation under the Klaviyo section,
explaining when to use it ("How many people signed up with email consent in...?")
and what the output looks like.

## Error handling

| Failure | Detection | Action |
|---|---|---|
| Klaviyo 429 | response status | Exponential backoff (1s, 2s, 4s, 8s), then abort |
| Klaviyo 4xx (401, 400) | response status | Log + abort; alertable |
| Klaviyo 5xx | response status | Single retry with backoff, then abort |
| >10K pages (sanity) | counter | Abort + log warning |
| Supabase write fail | thrown | Abort job; next night retries |
| Profile `created` malformed | parse fail | Skip + log warn, continue |
| `subscriptions` null/missing | property check | Total++ but consented stays |
| Tool: rollup never ran | `rows.length === 0 && repo.count() === 0` | Return empty + note "rollup runs nightly at 03:00 PT" |
| Tool: rollup partially behind | `latest_computed_day < endDate` | Return what we have + `rollup_freshness` |

Structured logs match existing `RollupRefreshJob` pattern:

```
INFO klaviyo_signup_rollup_started { backfill_window: '2020-01-01..2026-04-28' }
INFO klaviyo_signup_rollup_progress { pages_done: 100, profiles_seen: 10000 }
INFO klaviyo_signup_rollup_completed { profiles_seen, days_upserted, duration_ms }
ERROR klaviyo_signup_rollup_failed { error, pages_done }
```

## Testing strategy

| Test | Coverage |
|---|---|
| `repo.upsertManyDays() + getRange()` | Batch upsert + range query roundtrip |
| `repo.upsertManyDays()` conflict | Idempotency: re-run updates `computed_at`, doesn't duplicate |
| `job.run()` happy path | Stubbed client returns 3 profiles → repo gets correct dual counts |
| `job.run()` PT-bucketing | UTC `2026-01-01T05:00:00Z` (Dec 31 PT) → Dec 31 bucket |
| `job.run()` no subscriptions | Total++ but consented stays |
| `job.run()` drift recompute | Run 1 consent → run 2 same profile no consent → final consented = 0 |
| `job.run()` mid-paginate error | Abort, no partial upsert, idempotent next run |
| `tool.execute()` granularity=daily | Pass-through |
| `tool.execute()` granularity=monthly | Correct calendar-month buckets, partial months handled |
| `tool.execute()` granularity=weekly | Correct ISO week buckets |
| `tool.execute()` preset `last_30_days` | Accepts (matches the invariant test) |
| `tool.execute()` empty rollup | Returns empty + correct note |
| Live Reports compile with tool | Spec with `field: 'signups_consented_email'` passes HARD `column_field_not_scalar` gate |

Manual smoke (post-deploy):

1. Trigger job manually via `/run-klaviyo-rollup` admin endpoint or CLI
2. Verify table populated, log shows reasonable counts
3. Call tool with `last_90_days` granularity=monthly → compare with Lana's
   reference (Jan 593 / Feb 329 / Mar 350). If mismatch, debug bucketing/
   consent semantics before merge.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Job exceeds Fly machine memory paginating full history (~50K profiles) | Low | Streaming aggregation: bucket as we go, don't accumulate full profiles array. ~50K Maps = OK |
| Klaviyo `additional-fields[profile]=subscriptions` is removed in next API revision | Medium | Pin revision header (already pinned to `2026-04-15`); revisit if Klaviyo bumps |
| `subscriptions.email.marketing.consent` field shape changes | Medium | Single check site in job → fix once |
| Drift confuses users ("why did Jan 2026 go from 593 to 587?") | Medium | `note` in tool output explains; if Lana finds it confusing, switch to "consented at signup" semantics later |
| Backfill takes >10 min and times out scheduler | Low | First run is ~50K profiles ≈ 500 pages ≈ 1-2 min; scheduler tolerates 5 min |
| Two job instances run concurrently (e.g., manual trigger + cron) | Low | Idempotent: both produce same final state. Slight wasted work, no correctness risk |

## Out of scope (explicit)

- SMS consent
- Signup source attribution (list, campaign, segment)
- Sub-daily freshness
- "Consented at signup" frozen semantics (drift-tolerant matches the puller)
