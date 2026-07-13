# Asana `feature_qa_stats` — Design

**Date:** 2026-07-13
**Status:** Approved (via the interactive analysis session of 2026-07-13, where the
methodology below was validated by hand against all 129 Feature tickets on the
board).
**Connector:** `asana` (new) · **Tool:** `asana.feature_qa_stats`

## Goal

Compute, for a date range, QA-issue statistics for Type=Feature tasks on the
Gantri Asana "Software Board":

- how many features QA found issues on (vs. passed clean),
- how many of those issues were REAL functional bugs vs. process/environment
  noise,
- who found them — QA reviewers (Matthew "Matt" Fite / Joshua "Josh" Nie) vs.
  developers / others.

The output feeds automated Live Reports ("Live Report: QA quality this month")
and answers ad-hoc Slack questions ("how many features had bugs found in QA in
June?", "escape rate last quarter", "who caught the most bugs?").

## Non-goals

- Not a live board snapshot — it reads task *history* (section-move + reopen
  stories) over a window.
- Not marketing/sales/revenue data. Engineering-process only.
- No writes to Asana. Read-only PAT.
- No per-Bug/Hotfix analysis — Feature tickets only (the QA-quality question is
  about features shipping clean).
- No persistence/rollup job — computed on demand, cached by the existing
  cache-policy layer.

## Definitions

- **QA reviewer**: Matthew Fite ("Matt") or Joshua Nie ("Josh"). Everyone else
  who bounces a ticket is a developer / other.
- **QA-stage event**: a Software-Board section move whose `from` OR `to` is
  "QA Review" or "Post Release QA", plus a reopen out of "Done"/"Ready To
  Deploy" back into a review section (or a `marked_incomplete` of a
  previously-completed task).
- **In scope / denominator (`featuresWithQaActivity`)**: a feature with ≥1
  QA-stage event inside the window.
- **QA bounce**: a backward move out of "QA Review"/"Post Release QA" (to
  Rework / Code Review / In Progress / Blocked / Backlog), or a reopen from
  Done/Ready To Deploy back to a review section — with the story timestamp
  inside the window. The finder is the section-move story's `created_by.name`.
- **Real bug vs process**: deterministic bounce detection above, then ONE
  batched LLM call classifies each bounced feature. `isRealBug=true` only for a
  genuine functional defect in the feature under test. `false` for merge
  conflicts, preview/staging env issues, unclear/outdated acceptance criteria,
  missing/unclear QA notes, process/ownership disputes, "expected behavior"
  reclassifications, stakeholder change requests, waiting-on-dependency pauses.

## Methodology (validated by hand on all 129 features)

1. Fetch all project tasks via
   `GET /projects/{gid}/tasks?limit=100&opt_fields=name,completed,created_at,modified_at,permalink_url,custom_fields.gid,custom_fields.enum_value.gid`
   (raw Asana API supports offset pagination via `next_page.offset`). Filter
   client-side to Type=Feature.
2. Prune candidates that cannot have a story inside the window
   (`created_at > windowEnd` or `modified_at < windowStart`).
3. For each candidate, fetch stories via
   `GET /tasks/{gid}/stories?opt_fields=created_at,created_by.name,resource_subtype,text`.
   Concurrency-limit story fetches to 5 parallel; retry once with backoff on
   429/5xx.
4. Parse `section_changed` stories whose text matches
   `moved this task from "A" to "B" in Software Board` (ignore moves in other
   projects). Also capture `marked_complete` / `marked_incomplete` and
   `comment_added`.
5. QA-stage events, QA bounces, and finder attribution per the Definitions
   above.
6. **Window semantics**: interpret `{startDate,endDate}` as
   `[start 00:00, end 23:59:59.999]` America/Los_Angeles, converted to UTC for
   timestamp comparison (DST-aware).
7. Evidence: for each bounce, collect `comment_added` stories by the same person
   within ±36h, or any comment within ±2h; truncate each to 600 chars.
8. Classification: ONE batched Haiku call (fallback Sonnet) via
   `callClaudeWithResilience`, site tag `asana_qa_classifier`, with defensive
   JSON extraction. On total failure → features are `unclassified` (counted in
   `anyBounce`, NOT `realBug`) and `degraded:true`.

## Architecture

```
AsanaApiClient (client.ts)          — HTTP + offset pagination + retry
        │  tasks + stories
        ▼
story-analyzer.ts (PURE)            — isFeatureTask, parseSectionMove,
        │  FeatureAnalysis[]          analyzeFeature, pacificWindowToUtcMs
        ▼
qa-classifier.ts (LLM, batched)     — classifyBouncedFeatures → {isRealBug,reason}
        │                             degrades to {} + degraded:true
        ▼
connector.ts                        — orchestrates, aggregates totals + finders,
                                      builds flat output (D1 style)
board-config.ts                     — validated gids + section-name sets + QA roster
```

The split keeps all bounce/window logic in a pure, HTTP-free module that is
exhaustively unit-tested; the client and the LLM step are thin and stubbed in
tests.

## Output shape (flat, D1)

```
{
  period: { startDate, endDate },
  board: 'Software Board',
  degraded: false,
  totals: {
    featuresWithQaActivity, featuresBouncedAny, featuresRealBugByQa,
    featuresProcessBounceOnly, featuresBouncedByNonQaOnly, featuresUnclassified,
    realBugRatePct, anyBounceRatePct
  },
  finders: [ { name, shortName, isQa, featuresWithRealBugs, featuresWithAnyBounce } ],
  features: [ { gid, name, url, outcome, finders, reason, bounceCountInWindow } ]
}
```

`realBugRatePct = featuresRealBugByQa / featuresWithQaActivity * 100` (1 dp, 0
when denom 0). `outcome ∈ real_bug | process_bounce | clean_pass | unclassified`.
`features` is `[]` when the tool is called with `includeFeatures:false`.

## Error handling

- API errors bubble as `AsanaApiError` → the registry wraps into
  `{ok:false, error}`.
- LLM classifier failure is caught inside the tool → `degraded:true`, features
  `unclassified`. The stats still return.

## Testing strategy

- `client.test.ts`: auth header, pagination (next_page.offset), 401/429/5xx,
  retry-once.
- `story-analyzer.test.ts` (core): straight pass, QA→Rework, Done reopen, Post
  Release QA bounce, non-Software-Board moves ignored, window edge
  inclusion/exclusion, marked_incomplete reopen + dedup, multi-bounce, evidence,
  PT→UTC (PDT + PST).
- `qa-classifier.test.ts`: empty input skips LLM, clean parse, prose-wrapped
  JSON, throw/unparseable/schema-violation → degraded.
- `connector.test.ts`: happy path totals+finders+outcomes, includeFeatures=false,
  degraded path, preset dateRange accepted.
- Live-API smoke: `scripts/smoke-asana.sh` (reachability) +
  `scripts/smoke-asana-tools.mjs` (real tool execution).

## Risks

- **Section renames**: the parser keys off section *names* in story text. If the
  team renames "QA Review" etc., the name sets in `board-config.ts` must be
  updated. Documented there.
- **Story-text format drift**: Asana's `section_changed` text is stable
  (verified live) but not contractual. The smoke script + a parser unit test
  guard it.
- **LLM cost**: one batched call per invocation (Haiku, a few hundred tokens per
  bounced feature). Negligible; cached by policy (settle 14d).
- **DST edges**: day-boundary conversions are far from the 2am transition; a
  single offset resolution is exact.
