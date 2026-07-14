# Delivery Tier Auto-Classifier — Design (v1 + v2)

Date: 2026-07-14 · Owner: Danny · Status: approved (brainstorm 2026-07-14)

## Goal

Automate the QA/Dev Risk-Based Delivery Framework on the Asana Software Board:

1. **v1 — Auto-assign**: new tickets get the `Delivery Tier` custom field set (T0/T1/T2) plus an Asana comment explaining exactly which rubric question fired, with evidence quoted from the ticket.
2. **v1 — Monday report**: every Monday, Danny gets a Slack DM with deterministic recommendations on which domains/tickets should move up/down tiers, bot-vs-human disagreements, and where the rubric is producing `unclear`.
3. **v2 — PR re-check**: when a PR linked to a classified ticket appears, re-run the rubric against the real diff (the authoritative source per the framework) and raise the tier if the code contradicts the ticket's description. Never lower automatically.

Non-negotiables from Danny:
- The rubric prompt is **public** (versioned file in-repo, mirrored in Notion, cited in every comment).
- The tier computation is **deterministic**: the LLM only extracts facts; a pure function computes the tier. Same facts → same tier, always.
- **Cheap**: one small Haiku call per ticket, temperature 0, cached by content hash. Comments and reports are templates, not LLM prose.
- **QA is UI-only**: if a change cannot be tested through the UI → T0 (engineering validation), regardless of risk (backend risk routes to the Non-UI Lane note, which is engineering's binding gate). If the facts are inconclusive → T1.

## Where it lives

`gantri-ai-bot` (this repo). Rationale: the Asana webhook receiver lives in the separate `asana-automations` service, which is code-complete but **not deployed** (blocked on a service-account PAT for ~45 days). The bot is live, deploys on push to `main`, and already has: an Asana read client + vault PAT, a report scheduler, resilient LLM calls, and the versioned-prompt pattern (`src/prompts/flc-review-standard.md`).

**Trigger = polling, not webhooks.** Every 5 minutes, scan the Software Board for tasks that need classification (`Delivery Tier` empty). This is idempotent by construction (field set = done), never misses events, and needs no new infrastructure. If `asana-automations` ever deploys, the poller can be replaced by its webhook inbox without touching the classifier core.

Known tradeoff: writes use Danny's PAT (`ASANA_ACCESS_TOKEN` vault key), so field changes and comments appear as Danny. Comments are prefixed with 🤖 to make bot authorship obvious. A service account can replace the PAT later with zero code change.

## The rubric (authoritative sources)

- Public framework: "QA / Dev Risk-Based Delivery Framework" (Notion `397db572aef4804a91f6f301739c7152`) — lane names, functional domains, domain movement rules.
- Practical guide: "Pre-Production Test Tiering — A Risk-Based Framework" (Notion `38ddb572aef4810d95d9fdd36fa3bda1`) — the definitive decision tree with Fires / Does-NOT-fire boundaries and the Common cases table.
- Danny's automation rules (2026-07-14): not UI-testable → T0; inconclusive → T1.

### Extraction facts (what the LLM answers — nothing else)

Each fact is `yes | no | unclear` plus a short verbatim evidence quote from the ticket:

| Fact | Boundary (from the rubric) |
|---|---|
| `ui_testable` | Can QA meaningfully validate this through the product UI? Backend-only/infra/CI/logging/analytics/internal tooling → no. |
| `irreversible_external` | Changes whether/to whom/how much/what fires for a REAL external customer: charge/refund/payout · committed order · customer email/SMS/push · hard-delete of customer record. NOT: internal-only systems (Factory OS/Porter admin/jobs/drafts/caches), refactors, logs, reads, soft-deletes, internal messages. |
| `money_visible` | Renders on cart/checkout/payment, or changes a price/total/tax/shipping/discount the customer sees or is charged. NOT: copy/styling on those pages; backend-only numbers. |
| `visual_blast_radius` | New/removed screen (route added/deleted) · shared component (design-system dir or used on 2+ screens) · layout restructure (elements added/removed/reordered/shown-hidden, grid/flex columns change). NOT: padding/color/font tweak · copy/text/image change · new self-contained element on one existing screen. |
| `brand_critical` | Surface is on the named list ONLY: homepage · active campaign/launch landing · global header/nav/footer. Not on the list = no. |
| `backend_data` | Migration (always) · backend module a customer flow depends on (orders/checkout/payments/pricing/inventory/auth) · authz change · integration contract. |
| `coordinated_launch` | Tied to a press date / high-brand-impact scheduled launch. |
| `domain` | One of the framework's functional domains (enum below) or `unknown`. |

Domain enum (from the public framework): Marketplace — `auth_accounts`, `product_discovery`, `product_configuration`, `shopping_checkout`, `orders_notifications`, `content_marketing`; Factory OS — `production_workflow`, `scheduling_fulfillment`, `inventory_materials`, `production_monitoring`, `factory_administration`; MadeOS — `made_order_management`, `design_workflow`, `customer_operations`, `reporting_analytics`, `made_administration`; plus `unknown`.

### Decision function (pure TypeScript — `decideTier(facts)`)

Treating `unclear` as `no`, compute the base tier in strict order, stop at first yes:

1. `ui_testable === 'no'` → **T0** (QA cannot gate it; if `backend_data` or money/irreversible facts are yes, the comment carries the **Non-UI Lane** note: binding engineering verification — extra reviewer + E2E + staging).
2. `irreversible_external === 'yes'` OR `money_visible === 'yes'` → **T2**.
3. `visual_blast_radius === 'yes'` → **T1**.
4. Otherwise → **T0**.

Then the inconclusive lift (Danny's rule): if any decision-relevant fact is `unclear` AND the base tier is below T1 or the unclear fact could have raised it → final tier = `max(baseTier, T1)`. A definite T2 stays T2. Exception: `ui_testable === 'no'` is terminal (T0) — QA tiers are moot for non-UI work; only `ui_testable === 'unclear'` lifts to T1.

Flags never change the tier, they append to the comment: `brand_critical` → author self-check vs approved design + QA looks first post-release; `backend_data` → Non-UI Lane; `coordinated_launch` → verify ahead of the date on preview, binding pass upfront.

### Which tasks get classified

- On the Software Board (`1210754051061529`), incomplete, `created_at >= ROLLOUT_DATE` (constant set at deploy; no backfill spam).
- `Delivery Tier` field is **empty**, description (`notes`) has ≥ 40 chars, name is not a template (existing `Feature template` exclusion pattern).
- `Type` not in the excluded set: `Not a Bug`, `Qa Work`, `Research` (everything else classifies; infra work lands T0 naturally via `ui_testable=no`).
- Re-classification: if the bot classified it and the `notes` hash changed materially, re-run; update field + new comment only if there is no human override.
- **Human override is sacred**: the bot records what it set; if the current field value differs from the bot's record, a human changed it → mark `human_override`, never touch that task again, feed the Monday report.

## Components (all in `gantri-ai-bot`)

```
src/connectors/asana/tier/
  extract.ts        — one Haiku call (temp 0, forced JSON + zod, prompt-cached system), returns Facts
  decide.ts         — pure decideTier(facts) → {tier, liftedByUnclear, flags[]}
  comment.ts        — template renderer (no LLM): tier, fired question, evidence, flags, domain, rubric version+link, dispute line
  poller.ts         — 5-min interval from index.ts; scan → classify → write field + comment → persist record
  weekly-report.ts  — Monday aggregation + Slack DM (template)
  pr-recheck.ts     — v2: poll open PRs, match Asana link, diff-based re-extraction, raise-only
src/prompts/delivery-tier-standard.md   — THE public rubric prompt, versioned (Version: 1 header line parsed by code)
```

- **Asana client additions** (`src/connectors/asana/client.ts` is read-only today): `setEnumCustomField(taskGid, fieldGid, optionGid)` (PUT /tasks/{gid}), `createStory(taskGid, text)` (POST /tasks/{gid}/stories), `getTask(gid)` with the needed opt_fields.
- **GIDs** (add to `board-config.ts`): `DELIVERY_TIER_FIELD_GID = 1216565279651993`; options T0 `1216565279651994`, T1 `1216565279651995`, T2 `1216565279651996`. Already there: board gid, `TYPE_FIELD_GID`, section gids, QA roster. Type options of interest for reports: `QA Escape` `1216003613864064`, `Escapes` `1216455780657179`.
- **LLM**: `callClaudeWithResilience` with primary `claude-haiku-4-5-20251001`, fallback `claude-sonnet-4-6`, temperature 0, max_tokens ≤ 1024, forced-JSON + zod (imitate `qa-classifier.ts`). System prompt = the rubric file, with `cache_control: ephemeral`.
- **Cache**: `input_hash = sha256(promptVersion + name + notes + typeName)`; identical hash → reuse stored classification (free, identical).
- **Internal trigger**: `POST /internal/run-tier-poll` (gated by `x-internal-secret`, same as run-due-reports) — used by smoke tests and manual runs.

### Comment template (English, like the board)

```
🤖 Delivery Tier: T2 — QA before production
Why: changes the money the customer pays (rubric Q3).
Evidence: "…refunds will now be issued automatically for cancelled orders…"
Flags: Non-UI Lane — backend change to orders/payments: engineering verification is the binding gate (extra reviewer + E2E + staging).
Domain: Shopping & Checkout
Rubric v1 · https://www.notion.so/38ddb572aef4810d95d9fdd36fa3bda1 · Disagree? You can raise a tier yourself; lowering is never a solo call — Engineering Manager is the tie-break.
```

`unclear` version: `Why: couldn't determine X from the ticket → defaulting to T1 (inconclusive rule). Add detail to the description and the bot will re-classify.`

## Data model (new migration, next number in `migrations/`)

```sql
create table tier_classifications (
  task_gid text primary key,
  input_hash text not null,
  prompt_version int not null,
  facts jsonb not null,
  tier text not null check (tier in ('T0','T1','T2')),
  lifted_by_unclear boolean not null default false,
  flags jsonb not null default '[]',
  domain text,
  decided_by text not null default 'bot' check (decided_by in ('bot','human_override')),
  human_tier text,
  comment_gid text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table tier_pr_checks (          -- v2
  repo text not null,
  pr_number int not null,
  head_sha text not null,
  task_gid text,
  verdict text not null,               -- 'consistent' | 'raise' | 'no_ticket' | 'not_classified'
  suggested_tier text,
  commented boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (repo, pr_number, head_sha)
);

create table tier_weekly_reports (
  week_start date primary key,
  sent_at timestamptz not null default now(),
  payload jsonb not null
);
```

## Monday report (deterministic aggregation; template output; LLM optional and off by default)

Runs from the poller tick: if now ≥ Monday 09:00 America/New_York and no `tier_weekly_reports` row for this week → compute + DM Danny (Slack user resolved from `authorized_users`) → insert row (idempotent).

Sections (all computed from `tier_classifications` + Asana reads):
1. **Move up** — domains with an escape in the last 30d (Software Board tasks with Type `QA Escape`/`Escapes` created in-window, mapped to domain via their own classification or LLM-free heuristic: the linked/duplicated feature's domain; unknown → listed separately) where recent tickets classified below T2.
2. **Move down** — domains whose last ≥3 completed T2 tickets in 30d had zero QA-found defects (no bounce per the `feature_qa_stats` bounce detection reused as a library call, if cheap; otherwise zero escape-typed tasks) → recommend T2→T1 default. Same shape for T1→T0.
3. **Disagreements** — `human_override` rows from the last 7d: ticket, bot tier + fired question, human tier. Calibration gold.
4. **Inconclusive rate** — % of `lifted_by_unclear` per domain over 7d; domains > 30% flagged as "rubric needs sharpening here".
5. Volume + cost line (tickets classified, tokens ≈).

These are recommendations only; nothing auto-moves. Danny decides and edits fields by hand.

## v2 — PR re-check (raise-only)

- Every 10 min, `GithubDispatcher.listOpenPRs` over configured repos (`mantle`, `core`, `porter`, `made`, `gantri-components`); new method `prDiff(repo, number)` (Accept: `application/vnd.github.diff`, truncate to ~50k chars, note truncation).
- Skip if `(repo, pr_number, head_sha)` already in `tier_pr_checks`. Extract the Asana task gid from the PR body (`app.asana.com` link — every Gantri PR carries one by policy).
- If the task has a classification: re-run extraction **from the diff** (same facts, same prompt file, a diff-specific instruction block) → `decideTier`.
- If diff tier > current field tier → if bot-set and no override: update field + comment (`🤖 Tier raised T0 → T2 after PR #NNNN diff review: the diff touches the charge amount calculation. Evidence: …`); if human-set: comment only, never touch the field. If diff tier ≤ current: record `consistent`, stay silent (no noise).
- Never lowers a tier (framework rule: lowering is never a solo call).

## Testing

- **`decide.test.ts` — the Notion "Common cases" table verbatim as fixtures** (the code is provably aligned with the public doc): checkout copy change → T0 · styling tweak → T0 · new self-contained element on one screen → T0 · shared component edit → T1 · new screen → T1 (+brand flag when on the list) · backend orders/payments change → T0 + Non-UI Lane note · migration → T0 + Non-UI Lane · change that alters whether/how much a charge fires → T2 · refactor/log/read in payments code → T0 + Non-UI Lane. Plus: ui_testable=no with money=yes → T0 + binding Non-UI note · ui_testable=unclear → T1 · money=unclear (rest no) → T1 · irreversible=yes + others unclear → T2.
- `extract.test.ts` — mocked LLM: JSON parsing, zod rejection → retry/fallback, evidence passthrough, hash caching.
- `poller.test.ts` — mocked Asana: skips human-set fields, records overrides, re-runs on notes-hash change, respects ROLLOUT_DATE/type exclusions, idempotent on rerun.
- `weekly-report.test.ts` — seeded classifications → exact recommendation output; idempotency via `tier_weekly_reports`.
- `pr-recheck.test.ts` — raise-only semantics, head_sha dedupe, missing-ticket verdicts.
- Real-API smoke (scripted, not vitest): create a throwaway task on the board (`[TIER-BOT SMOKE] — ignore`), run `/internal/run-tier-poll`, assert field+comment, **delete the task** (cleanup mandatory).

## Rollout

1. PR → review → merge to `main` (auto-deploys to Fly).
2. Smoke on live app (create/verify/delete smoke task). Verify Monday-report idempotency by forcing a dry run to Danny only.
3. Announce in the framework Notion page: link the prompt file + add "the bot assigns the initial tier" to the "Record it" section (Danny does this part).

Out of scope (explicitly): per-domain default-lane table (YAGNI until Monday-report data justifies it) · the standalone webpage (Slack + Asana comments cover it) · auto-moving domain lanes · webhook migration to `asana-automations`.

## Cost envelope

~1 Haiku call/ticket (≈4k in / 300 out, system prompt cached) ≈ half a cent per ticket; PR re-checks similar with diff truncation. Weekly report: zero LLM. Everything else is templates and SQL.
