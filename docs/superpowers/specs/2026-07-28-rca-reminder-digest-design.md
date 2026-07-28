# RCA Reminder Digest — Design

Date: 2026-07-28 · Owner: Danny · Status: shipped

## Goal

Every bug that reaches Done on the Asana Software Board owes a root cause
analysis. The board records that as subtasks — the current template creates
`Engineering Escape RCA` and `QA Escape RCA` — and nobody notices when they stay
unchecked. A scan on 2026-07-28 found 12 bugs closed in the previous 30 days
whose RCA subtasks were still open, the oldest 22 days cold.

The bot posts **one message, twice a day** (08:00 and 16:00 America/New_York) to
the software channel listing every closed bug with an outstanding RCA.

Explicitly **not** a per-ticket alert. Danny's framing: "not every ticket — a
bulk update at 8am EST and 4PM EST". The output is a standing worklist, not a
notification stream.

## Where it lives

`src/connectors/asana/rca/` in this repo, alongside the delivery-tier
classifier, which already owns the Software Board scan pattern and the Asana
read client.

Independent of the tier classifier at runtime: no prompt, no LLM, no GitHub
token. It needs Asana plus a channel, so it stays up even when the classifier is
disabled.

## Trigger

Polling, same as the tier classifier. `RcaDigestRunner` ticks every 5 minutes and
asks `RcaDigestReporter.maybeSend()` whether a slot is due.

- `dueSlotKey(now)` returns the **most recent elapsed** send hour for the current
  New York day (`2026-07-28:08`), or null before 08:00.
- `rca_digests` is the idempotency ledger — one row per delivered slot. A row for
  the current slot → no-op, and the board is never even read.
- Only the most recent slot is ever due, so a bot that was down all morning sends
  the afternoon digest when it returns instead of replaying the morning one.

The board scan happens **only on the tick that delivers** (~7s, ~130 board pages
plus one subtask read per candidate). Every other tick is one indexed row read.

## Selection rules

A ticket is listed when **all** of these hold:

1. **Done** — `completed = true`, or it sits in the board's Done section
   (`1210754051061538`). Tickets get parked in Done without the checkbox often
   enough that the section membership has to count.
2. **A bug** — the `Type` custom field is one of P0 / Hotfix / Bug / Regression /
   QA Escape / Escapes. `Hotfix (not really)` and `Hotfix-Feature` are excluded:
   both label fast-tracked feature work.
   When `Type` is **empty** — ~40% of recently-closed board tickets — the title
   convention decides (`Bug:`, `Hot-Fix:`, `Regression:`, `P0`), with
   `Not A Bug:` excluded. A set `Type` always beats the title.
3. **Has an open RCA subtask** — at least one incomplete subtask whose name
   matches `/\brca\b|root\s*cause/i`. The board has accumulated several
   spellings (`Engineering Escape RCA`, `QA Escape RCA`, `Root cause analysis`,
   `Root Cause`), so the match is on the concept, not one exact string.
4. **Closed within the lookback window** — 30 days by default
   (`RCA_LOOKBACK_DAYS`). Without a statute of limitations the digest would nag
   about tickets from 2022 forever.

A bug closed with **no** RCA subtask at all is *not* listed. That is a different
gap (the template was never applied) and would need a different fix — creating
the subtasks rather than reminding about them.

`completed_at` dates the closure; tickets parked in Done without the checkbox
fall back to `modified_at`, and the rendered age hedges accordingly ("in Done
3d" rather than "closed 3d ago").

## Output

```
🔍 *RCA follow-ups* — 12 closed bugs still owe a root cause analysis

• <asana link|Hotfix - Multiple refunds applied on Stripe> — Hotfix · closed 22d ago · assignee: @matt
    ↳ open: Root cause analysis
• <asana link|Hot-Fix: Unable to process a return…> — Hotfix · closed 4d ago · assignee: @matt
    ↳ open: Engineering Escape RCA, QA Escape RCA
```

Oldest closure first — the ticket that has gone unanalysed longest is the one
most likely to be forgotten. Capped at 20 rendered tickets with a `+N more` tail.

The assignee is @-mentioned when their Asana email matches an `authorized_users`
row, and rendered as a plain Asana name otherwise. It is labelled `assignee:`
because on a bug ticket that is frequently whoever filed or verified it rather
than whoever owes the engineering half of the analysis.

**Nothing outstanding → nothing posted.** An all-clear ping twice a day is noise.
The slot is still recorded as delivered, otherwise the runner would rescan the
whole board on every tick for the rest of the slot.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `RCA_DIGEST_CHANNEL_ID` | `SOFTWARE_CHANNEL_ID` | Where the digest posts |
| `RCA_LOOKBACK_DAYS` | 30 | How far back closed bugs are chased |

`POST /internal/run-rca-digest` (guarded by `x-internal-secret`) forces an
attempt for smoke tests. It honours the ledger, so an already-delivered slot
stays delivered.

## Tradeoffs

- **Repeats until resolved.** A ticket stays on the list every digest until its
  RCA is checked off. That is the enforcement mechanism, and the lookback window
  bounds how long it can nag.
- **Polling, not webhooks.** Same reasoning as the tier classifier: the
  `asana-automations` webhook receiver is still undeployed, and polling is
  idempotent by construction.
- **The digest cannot tell "RCA not needed" from "RCA not done".** If a bug
  legitimately does not need an analysis, the subtask has to be checked off (or
  deleted) to clear it. There is no separate opt-out.
