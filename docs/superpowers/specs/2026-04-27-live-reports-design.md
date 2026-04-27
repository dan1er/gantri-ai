# Live Reports — Design Spec

**Status:** Approved (open questions resolved)
**Author:** Danny Estevez
**Date:** 2026-04-27
**Branch:** `feat/live-reports`

---

## Goal

Let an authorized user say "create a live report on weekly NB ROAS by channel" and end up with a **persistent URL** they can share. The URL renders a beautiful, fast, always-fresh dashboard. The bot's LLM is involved **only at creation time** to compile the user's intent into a deterministic spec; subsequent visits to the URL never invoke the LLM.

## Non-goals

- Self-service editing of arbitrary visual layouts (drag-and-drop). Layouts come from the spec.
- Public sharing outside Gantri's allowlist.
- Real-time streaming. "Live" means fresh data each visit, not WebSocket-pushed updates.
- Replacing Grafana dashboards. Live Reports are for ad-hoc / cross-source / personalized views the team wants without dev cycles.

---

## Architecture (one paragraph)

A **Live Report** is a row in `published_reports` with a versioned JSON `spec`. The spec describes (a) which tools to call with which args, and (b) how to compose the results into UI blocks. When someone visits `/r/<slug>`, an HTML shell loads a React SPA. The SPA fetches `/r/<slug>/data.json`, which executes the spec — paralleling the listed tool calls and returning `{dataResults, ui}` — and renders. **No LLM in the request path.** The compile step (intent → spec) lives in a tool `reports.publish_live_report`, only fired when the user explicitly asks for a "live report".

```
                ┌─────────────────────────────┐
   creation ───►│ reports.publish_live_report │  ← LLM compiles ONCE
                └────────┬────────────────────┘
                         │
                         ▼
                ┌─────────────────────────────┐
                │ published_reports (Supabase)│
                │  spec = {data:[…], ui:[…]}  │
                └────────┬────────────────────┘
                         │
                         ▼
   visits ◄────► GET /r/<slug>          (HTML shell, served by Express)
                  └─► loads React SPA (built with Vite, served as static)
                       └─► fetch /r/<slug>/data.json
                              └─► spec runner: parallel tool calls
                                     └─► dataResults
                              └─► returns { dataResults, ui, meta }
                       └─► SPA renders Tremor components
```

---

## Spec format (v1)

A spec is **strictly typed JSON**. It has a `version` field for migrations. The compiler must emit a spec that passes Zod validation; any spec that fails to validate is rejected and the user is told to retry.

```ts
interface LiveReportSpec {
  version: 1;
  title: string;                          // shown as the H1
  subtitle?: string;                      // optional supporting line
  description?: string;                   // longer prose for the report's "About" footer
  data: DataStep[];                       // tool calls to run on each visit
  ui: UiBlock[];                          // ordered layout from top to bottom
  cacheTtlSec?: number;                   // how long /data.json results cache. Default 300 (5 min)
}

interface DataStep {
  id: string;                             // alias used by ui blocks (e.g. "rev_week")
  tool: WhitelistedToolName;              // must be in the allowlist below
  args: Record<string, unknown>;          // validated by the tool's existing Zod schema at compile time
  // Note: NO conditional logic, NO refs to other steps. Each step is
  // independent and can run in parallel.
}

type UiBlock = KpiBlock | ChartBlock | TableBlock | TextBlock | DividerBlock;

interface KpiBlock {
  type: 'kpi';
  label: string;
  value: ValueRef;                        // path into dataResults
  delta?: { from: ValueRef; format?: 'percent' | 'absolute' };
  format?: 'currency' | 'number' | 'percent';
  width?: 1 | 2 | 3 | 4;                  // grid cells out of 4 (default 1 = quarter-width)
}

interface ChartBlock {
  type: 'chart';
  variant: 'line' | 'area' | 'bar' | 'donut' | 'horizontal_bar';
  title: string;
  data: ValueRef;                         // expects an array
  x: string;                              // field name on each row used as x-axis
  y: string | string[];                   // one or more series fields
  yFormat?: 'currency' | 'number' | 'percent';
  height?: 'sm' | 'md' | 'lg';            // default 'md'
}

interface TableBlock {
  type: 'table';
  title?: string;
  data: ValueRef;
  columns: Array<{
    field: string;
    label: string;
    format?: 'currency' | 'number' | 'percent' | 'date_pt' | 'admin_order_link' | 'pct_delta';
    align?: 'left' | 'right' | 'center';
  }>;
  sortBy?: { field: string; direction: 'asc' | 'desc' };
  pageSize?: number;                      // default 25
}

interface TextBlock { type: 'text'; markdown: string; }
interface DividerBlock { type: 'divider'; }

type ValueRef = string;
// Like JSONata-lite: "stepId.path.to.field". Examples:
//   "rev_week.rows[0].rev"      → scalar
//   "by_channel.rows"           → array
//   "totals.fullTotal"          → top-level
// No expressions, no math. Pure read.
```

### Tool whitelist (initial set)

A spec can only reference tools we mark `liveReportSafe: true`. To start:
- All `northbeam.*` (read-only, args validated, output stable)
- All `gantri.*` aggregation tools (`order_stats`, `late_orders_report`, `sales_report`, etc.)
- All `ga4.*`
- `grafana.sql` and `grafana.run_dashboard`

Excluded (would need a deliberate audit before whitelisting):
- `reports.*` — meta tools, not data
- `feedback.*` — write-side
- `bot.*` — admin-side

This whitelist is enforced at compile time AND at request time (defense in depth).

---

## Database schema

Migration `0010_published_reports.sql`:

```sql
CREATE TABLE IF NOT EXISTS published_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,                          -- short, URL-safe, ~12 chars
  title           text NOT NULL,
  description     text,
  spec            jsonb NOT NULL,                                -- LiveReportSpec
  spec_version    int NOT NULL DEFAULT 1,
  owner_slack_id  text NOT NULL,                                 -- creator (FK by convention to authorized_users.slack_user_id)
  intent          text NOT NULL,                                 -- the original user phrasing, for dedup search
  intent_keywords text[] NOT NULL DEFAULT '{}',                  -- extracted at compile time, for keyword dedup
  access_token    text NOT NULL,                                 -- 32-char random; URL needs ?t=<token>
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,                                   -- soft delete; archived reports 404
  last_visited_at timestamptz,                                   -- analytics
  visit_count     int NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS published_reports_owner_idx ON published_reports(owner_slack_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS published_reports_keywords_idx ON published_reports USING gin(intent_keywords);

-- Spec history for rollback (last 5 versions per slug).
CREATE TABLE IF NOT EXISTS published_reports_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id       uuid NOT NULL REFERENCES published_reports(id) ON DELETE CASCADE,
  spec            jsonb NOT NULL,
  spec_version    int NOT NULL,
  intent          text NOT NULL,
  replaced_by_slack_id text NOT NULL,
  replaced_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS published_reports_history_report_idx ON published_reports_history(report_id, replaced_at DESC);
```

`access_token` is independent of slug — slug is shareable identifier, token gates access. URLs look like `gantri-ai-bot.fly.dev/r/<slug>?t=<token>`. **Phase 1**: every authorized user shares the same per-report token. **Phase 2**: per-user OAuth so we can audit who-viewed-what.

---

## Shared modules (extracted for reuse)

Architecture principle from the brief: things that repeat must live in a shared place, but evolution must not break existing reports. To enforce both:

| Module | Path | Purpose | Backwards-compat strategy |
|---|---|---|---|
| **Spec types + validator** | `src/reports/live/spec.ts` | Zod schemas for `LiveReportSpec`. Single source of truth. | Versioned. v1 schemas frozen; v2 changes go in `spec-v2.ts`. Runner branches on `spec.version`. |
| **Spec runner** | `src/reports/live/runner.ts` | Takes a spec + registry, returns `{dataResults, ui, meta}`. Parallel tool dispatch. | Pure function. Adding new UI block types doesn't touch this — runner only handles `data`. |
| **Tool whitelist** | `src/reports/live/whitelist.ts` | Set of tools allowed in specs. Used at compile + at runtime. | Adding tools is additive; removing requires migration of impacted reports (or graceful degradation). |
| **ValueRef resolver** | `src/reports/live/value-ref.ts` | Parses `"stepId.path.to.field"` against a `dataResults` map, returns the value. | Frozen at v1. New ref syntaxes go in v2. |
| **Slug + token generators** | `src/reports/live/identifiers.ts` | `nanoid`-based, collision-checked. | Shared with potential future features. |
| **Repo** | `src/storage/repositories/published-reports.ts` | All DB access. `create`, `getBySlug`, `listByOwner`, `searchByKeywords`, `update`, `archive`, `recordVisit`. | RBAC enforced inside the repo, not at endpoint. |
| **Compile-time dedup** | `src/reports/live/dedup.ts` | Given an intent string, returns existing reports with high keyword overlap (or none). | Uses `intent_keywords[]` GIN index, scoring is heuristic (Jaccard). |
| **Frontend chart/KPI/table primitives** | `web/src/blocks/{Kpi,Chart,Table}.tsx` | One component per UI block type, takes resolved data, renders Tremor. | New variants added as new branches inside the same component. Old reports rendering unchanged. |
| **Frontend theme** | `web/src/theme/` | Tailwind preset, Tremor color overrides, font tokens. | Gantri brand colors + Inter/Geist. Reports inherit. |
| **Auth middleware** | `src/server/auth-middleware.ts` | Validates `?t=<token>` against the report's access_token. Logs visit. | Phase 2 swap to Slack OAuth without changing report semantics. |

**The cardinal rule:** anything used by 2+ reports lives in a shared module. Anything report-specific lives in the spec itself. Nothing report-specific gets hardcoded into the runner or the renderer.

---

## Compile flow (the LLM step)

When the user says "create a live report ...", the bot fires `reports.publish_live_report` with their natural-language intent. Inside the tool:

1. **Dedup search**: extract keywords from the user's intent (simple — strip stopwords, lowercase, split). Query `published_reports.searchByKeywords(actor.slackUserId, keywords)`. If any existing reports owned by the user (or shared with them) have ≥3 keyword overlap, return:

   ```json
   {
     "status": "existing_match",
     "matches": [
       { "slug": "weekly-sales", "title": "Weekly Sales", "similarity": 5 },
       ...
     ]
   }
   ```

   The bot's chat reply: *"You already have a report that looks like this: [Weekly Sales](url). Want to use that instead, or create a new one anyway?"*

2. **Clarification phase**: if no match, the bot enters a brief Q&A with the user — same as the existing `reports.subscribe` does for cron reports. Asks for: time range, breakdown dimensions, metrics, layout preference (KPI cards + chart? table-only?). 1–3 turns max.

3. **Spec compilation**: the LLM emits a `LiveReportSpec` JSON. We Zod-validate it. If invalid, retry once with the validation error fed back to the LLM. If still invalid, fail with a clear error to the user.

4. **Spec smoke-execute**: run the spec ONCE end-to-end on the server before persisting. If any tool errors, show the error to the user and abort. **A report that doesn't work on creation will not work on every visit either — fail fast.**

5. **Persist**: insert into `published_reports`. Generate slug + token. Return URL to the user.

The LLM is NOT in the request path of `/r/<slug>/data.json`. Only in step 3.

---

## Modify / archive permissions

```ts
canModify(report: PublishedReport, actor: ActorContext): boolean {
  return report.owner_slack_id === actor.slackUserId
      || actorRole(actor) === 'admin';
}
```

Modify operations: `re-compile spec` (the LLM rebuilds from a new intent), `update title/description`, `regenerate access_token` (invalidate old links), `archive`.

Tools (all admin-or-owner gated):
- `reports.list_my_reports` — list owned + accessible
- `reports.recompile_report` — re-run the LLM on a new intent for an existing slug; old spec replaced atomically
- `reports.update_report_meta` — title/description only
- `reports.archive_report` — soft delete

Read access (the URL itself): anyone with the token can view. **Phase 2**: tighten to "anyone in `authorized_users` who logs in via Slack OAuth".

---

## The data endpoint

```ts
GET /r/:slug/data.json
  → load PublishedReport by slug (404 if not found or archived)
  → validate access token (?t=<token>) — 401 if mismatch
  → check cache: if last computed within spec.cacheTtlSec, return cached
  → run spec via the spec runner
  → record visit (count++, last_visited_at = now)
  → return { dataResults, ui, meta: { generatedAt, cacheTtlSec, sources: [tools used], reportTitle, ... } }
```

Cache key: `live-report:<slug>:v<spec_version_hash>`. Stored in the existing `tool_result_cache` table — namespacing by prefix avoids collisions with regular tool caches.

Errors: if any tool fails inside the runner, we return partial results with an `errors[]` array — the frontend shows a yellow "X data section couldn't load" notice instead of a hard failure. **Reports degrade gracefully**.

---

## Brand: logo + favicon

Every report shows the Gantri logo. Location:
- **Top-left of `ReportHeader`** — the wordmark (`logo-name.png` from `gantri/mantle/public/`), height ~28px, links back to `/r` (a small "your reports" landing page in phase 1, just a list of the user's reports).
- **Browser favicon** — `favicon.png` from the same source.
- **Open Graph image** for link unfurls in Slack — uses `logo-bg.png` (1800×1800).

Assets are copied into `web/public/` at build time so they ship with the SPA bundle.

## Spec drawer ("View spec")

Every report has a small button in the header (icon: `</>` or `ⓘ`, label: *View spec*) that opens a **slide-over drawer from the left** showing the report's full provenance. This is the trust + debug + curiosity surface.

**Drawer contents (top to bottom):**
- **Intent** — the natural-language ask, exactly as the user typed it. Rendered as a quote block.
- **Owner + timestamps** — `Created by @user` · `Apr 27, 2026` · `Last refreshed 3 minutes ago` · `Spec version 1`
- **Data sources** — the distinct tool names referenced by the spec, with the count of calls each (e.g. `northbeam.metrics_explorer × 3`, `gantri.order_stats × 1`).
- **Spec JSON** — the full validated spec, pretty-printed and syntax-highlighted (Shiki `github-light` theme to match Tremor). Collapsible by section (`data`, `ui`, top-level meta).
- **Actions** (admin or owner only — checked client-side via the response payload):
  - *Copy spec JSON* (clipboard)
  - *Regenerate with new intent…* — opens an inline textarea, on submit fires `reports.recompile_report` and reloads the page.
  - *View history* — opens a sub-panel listing the last 5 spec versions from `published_reports_history` with timestamps; can preview an old spec or restore.
  - *Archive report*

**Behavior:**
- Slides in from the left, ~40% viewport width on desktop, full-width sheet on mobile.
- Backdrop click or Escape closes.
- URL hash updates to `#spec` so the drawer state is shareable / linkable (someone can paste `gantri-ai-bot.fly.dev/r/weekly-sales?t=…#spec` and the drawer opens on load).
- Keyboard shortcut `?` to toggle (Slack-style).

**Why slide-over and not a modal:** modals interrupt the page; a slide-over preserves the report behind the backdrop so the reader can cross-reference. Left-side because the right side is reserved for tooltips and Tremor chart hover cards.

**API impact:** `/r/<slug>/data.json` includes the full `spec` in `meta` (size is sub-5KB — no separate round-trip). Action endpoints (regenerate / archive) are existing tools the drawer calls via `/api/tools/<name>` (already gated by the actor — the drawer reads the actor from a Slack-OAuth cookie or, in phase 1, from a query param tied to the access token).

**Component:** `web/src/components/SpecDrawer.tsx` — shared across all reports. Receives `{intent, spec, meta, canModify}` as props. No report-specific code.

## The HTML shell

```ts
GET /r/:slug
  → 200 with the static React SPA (built with Vite into web/dist)
  → SPA reads slug from URL, fetches /r/:slug/data.json
  → renders blocks
```

The SPA bundle is built once at deploy time and served from `web/dist`. Express serves it via `express.static`. Tremor handles charts. Tailwind handles styling. One bundle for ALL reports.

Routing in the SPA:
- `/r/:slug` — the report
- `/r/:slug/raw` — debug view (logged-in admins see the raw spec + dataResults JSON)

---

## Frontend structure

```
web/
├── package.json
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── index.html                           ← single shell
├── src/
│   ├── main.tsx                         ← entry
│   ├── App.tsx                          ← reads slug, fetches data, dispatches blocks
│   ├── theme/
│   │   ├── tokens.ts                    ← Gantri palette
│   │   └── tremor-config.ts
│   ├── blocks/
│   │   ├── KpiBlock.tsx
│   │   ├── ChartBlock.tsx               ← line / area / bar / donut / horizontal_bar
│   │   ├── TableBlock.tsx
│   │   ├── TextBlock.tsx
│   │   └── DividerBlock.tsx
│   ├── components/
│   │   ├── ReportHeader.tsx             ← title, subtitle, refresh button, last-updated, "View spec" button
│   │   ├── ReportFooter.tsx             ← sources, "About this report"
│   │   ├── SpecDrawer.tsx               ← left slide-over: intent, spec JSON (Shiki), actions
│   │   ├── ErrorState.tsx               ← graceful per-block errors
│   │   └── LoadingShimmer.tsx
│   ├── lib/
│   │   ├── valueRef.ts                  ← MUST mirror the server-side resolver exactly
│   │   ├── format.ts                    ← currency/number/percent/date_pt formatters (canonical)
│   │   └── api.ts                       ← fetch + retry
│   └── styles/
│       └── globals.css
└── dist/                                ← built output, gitignored
```

**Why a separate `web/` dir, not `src/`?** Build separation. The bot bundle (Node) and the SPA bundle (browser) have different `tsconfig`, different deps. Keeping them apart prevents accidental Node imports in the frontend.

---

## Trigger phrase rules (in the system prompt)

A new section in the prompt, parallel to the existing `reports.subscribe` rules:

> 🚨 **`reports.publish_live_report` is ONLY for explicit live-report requests.** Trigger words: "create a live report", "live dashboard", "shareable URL", "publish a live page", "make this a live report", "reporte en vivo", "dashboard en vivo", "publica un reporte". DO NOT fire for one-off questions, scheduled DM reports (use `reports.subscribe`), or canvas requests (`reports.create_canvas`). Live reports cost more (compile + persist), so they're for things the user wants to revisit.
>
> Before compiling a new spec, ALWAYS call `reports.find_similar_reports` first with the user's intent. If existing reports overlap heavily, recommend those URLs instead of building a new one.

---

## Phased rollout

### Phase 1 — MVP (≈ 6–8 days)

- DB migration
- Spec types + Zod validator
- Spec runner (parallel tool dispatch + valueRef resolver)
- Repo (CRUD + dedup search)
- Tools: `reports.publish_live_report`, `reports.list_my_reports`, `reports.archive_report`, `reports.find_similar_reports`
- Endpoints: `GET /r/:slug` (HTML), `GET /r/:slug/data.json`
- Token-based auth (no OAuth yet)
- Frontend: `kpi`, `chart` (line + bar), `table`, `text`, `divider` block types
- **`SpecDrawer.tsx`** — left slide-over with intent, spec JSON, owner/timestamps, copy + (owner-gated) regenerate/archive
- Theming: Inter font, Tailwind, Tremor's default palette tweaked to Gantri colors
- Deploy
- Smoke test with 2-3 real reports

### Phase 2 — Polish (≈ 3–5 days)

- Slack OAuth for `/r/:slug` access (replaces token)
- Dark mode toggle
- Framer Motion entrance animations + animated KPI counter
- Mobile responsive pass
- Print-friendly mode (`?print=1` adds print CSS)
- Hero illustration / favicon / brand polish
- More chart variants (area, donut, horizontal bar)

### Phase 3 — Power features (deferred)

- `reports.recompile_report` — full re-LLM
- `reports.update_report_meta` — title/desc edit
- Report-level filters (date-range picker on the page itself)
- Export to PNG / share to Slack

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| LLM emits invalid spec | Zod-validate at compile time; retry once with error feedback; fail fast if still bad. |
| Tool args change underneath an old report | At request time, if a tool returns a Zod schema error, surface it as a per-block error in the UI and notify the owner via DM. Owner can `recompile_report`. |
| Every visit re-runs expensive tools | Cache layer with `cacheTtlSec` (default 5 min). "Refresh" button bypasses. |
| URL/token leaks to non-employees | Phase 2 OAuth is the durable answer. For phase 1, tokens rotate when the owner regenerates them via `reports.regenerate_token`. |
| Visual quality drift over time | Theme is centralized; new components added go through the same `web/src/blocks/` lane. PR review enforces. |
| Reports getting stale (silent breakage) | Background ticker runs every report once a day; if a report 5xxs for 3 consecutive days, DM the owner with a "your report is broken" notice. |
| LLM keeps making redundant new reports | The dedup-first gate. Bot is forced to recommend existing matches before compiling. Logged so we can tune the matcher. |
| Performance on large data tables | `pageSize` cap on TableBlock. Server-side pagination is phase 3 — for now, runners hard-cap arrays at 5000 rows with a warning. |

---

## Resolved decisions

1. **Slug format — title-derived, English-only.**
   - The LLM ALWAYS emits `title` in English (regardless of the user's input language), aligned with the codebase-language convention.
   - Slugify deterministically: lowercase, strip diacritics → ASCII, replace non-alphanumerics with `-`, collapse repeats, trim leading/trailing `-`. Cap at 60 chars.
   - Example: `"Weekly Sales Report"` → `weekly-sales-report`. `"ROAS por canal"` (Spanish input) → LLM normalizes title to `"ROAS by Channel"` → `roas-by-channel`.
   - On collision, append `-2`, `-3`, etc. (`weekly-sales-report-2`).
   - Why: shareable verbally, predictable URLs, meaningful in browser history, English keeps the indexes/admin tools consistent.

2. **Dedup — cross-org.** `reports.find_similar_reports` searches ALL non-archived reports (any owner). The recommendation surfaces the owner so the user knows who built it. Phase 1 is text/keyword matching; semantic embedding is out of scope (small corpus, allowlist of 5–10 means this stays cheap).

3. **Spec versioning — semver-flavored backwards-compat rule.**
   - **v1 specs render forever.** Non-negotiable contract.
   - Additive changes (new optional fields, new UI block types, new whitelisted tools) do NOT bump version. They land in v1.
   - Breaking changes (renaming a field, removing a block type, changing the meaning of an existing field) bump to v2 in a new module (`spec-v2.ts`) with a migration helper for v1 → v2. The runner branches on `spec.version` and dispatches to the right handler.
   - Every breaking change documented in `docs/superpowers/specs/changelog-live-report-spec.md` with date + rationale + migration note.

4. **Footer ("About this report").** Renders below the last UI block. Contains:
   - **Owner** — `Created by <@SLACK_USER>` (with link to their Slack profile)
   - **Created** — ISO date (e.g. `Apr 27, 2026`)
   - **Last refreshed** — relative time (`2 minutes ago`) + absolute on hover
   - **Generated from** — the original natural-language intent in italics. Lets readers understand the question that produced the report. Trustworthy + introspectable.
   - **Data sources** — list of distinct tool prefixes used (e.g. *Northbeam · Porter · Google Analytics 4*) — derived from `spec.data`.
   - **Refresh button** — calls `/r/<slug>/data.json?refresh=1` (bypasses cache).
   - **"Report a wrong number"** — DMs the bot in the user's name with `feedback: this report has a wrong number — <intent>`. Reuses the existing `feedback.*` connector.

5. **Editing — phase 1 is full re-LLM via `reports.recompile_report(slug, newIntent)`.**
   - The slug + URL stay stable (key property: bookmarks don't break).
   - The spec is replaced atomically. The previous spec is preserved in a `published_reports_history` table for rollback (~last 5 versions retained).
   - Access token can optionally rotate (arg `regenerateToken: true`).
   - Phase 3 introduces partial edits ("swap this chart to bar", "add a column for AOV") via per-block tool. Out of MVP — the format already supports it because each block is independent.

---

## Self-review

- ✅ LLM only at creation. Runtime is config-driven, no LLM, no eval.
- ✅ Shared modules (runner, valueRef, blocks, theme) — reuse maximized.
- ✅ Spec versioning + Zod validation — old reports survive evolution.
- ✅ RBAC: author + admin can modify; everyone with token can view.
- ✅ Dedup gate before creation — recommends existing reports.
- ✅ Trigger phrase rule — won't fire on every "show me a report" ask.
- ✅ Graceful degradation when a single tool errors.
- ✅ Phased rollout — MVP first, polish second, power features later.
- ✅ Test coverage plan: spec runner unit-tested, valueRef resolver unit-tested, dedup unit-tested, frontend components Storybook + Vitest.

---

**Next step:** Danny reviews. Once approved, the implementation plan (TDD task-by-task) follows.
