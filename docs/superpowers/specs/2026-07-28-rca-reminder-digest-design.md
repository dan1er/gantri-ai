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
3. **Has an RCA subtask nobody has filled in** — see the next section. Subtask
   names are matched on the concept (`/\brca\b|root\s*cause/i`) because the board
   carries several spellings (`Engineering Escape RCA`, `QA Escape RCA`,
   `Root cause analysis`, `Root Cause`).
4. **Reached Done at or after the cutoff.** The cutoff is the LATER of two
   bounds:
   - a **hard floor** (`RCA_START_AT`, default 2026-07-28 08:00 America/New_York
     — the rollout instant). Danny's call: the digest starts from the day it
     shipped rather than opening with a wall of historical backlog. The first
     live scan found 12 qualifying bugs going back 22 days; with the floor it
     found 2.
   - a **rolling window** (`RCA_LOOKBACK_DAYS`, default 30). Once the floor ages
     past the window the window takes over, so nothing is nagged about forever.

A bug closed with **no** RCA subtask at all is *not* listed. That is a different
gap (the template was never applied) and would need a different fix — creating
the subtasks rather than reminding about them.

### What counts as "filled in"

Measured against the live board on 2026-07-28, both obvious answers are wrong:

- **Not the Asana completion checkbox.** Of 21 RCA subtasks on bugs closed in the
  previous 60 days, **zero** were ticked. This team does not use the checkbox. A
  checkbox rule flags every finished analysis as missing.
- **Not "has a description" either.** The `Engineering Escape RCA` / `QA Escape
  RCA` subtasks arrive carrying 1,300–1,900 characters of template — headings,
  instruction sentences, and a list of `[ ]` options. A length rule clears every
  pristine one. "Has prose" is no better: the instructions *are* prose.

So the RCA counts as worked when **any** of these hold:

| Signal | Why |
|---|---|
| Asana completion checkbox ticked | Still honoured when someone does use it |
| A marked checklist box — `[x]`, `[X]`, `[+]`, `[✓]` | The template ships every box blank, so one tick is proof of work |
| A line that is not template boilerplate | Someone typed an answer into the blanks; this is how the legacy free-form `Root Cause` subtask gets filled |
| An attachment | Two real RCAs are literally "See PDF below" plus the PDF |
| A comment | The analysis written as a comment instead — costs a request, so it is only checked for subtasks that already look empty |

Boilerplate is recognised against a captured copy of the two templates in
`rca-template.ts`. Asana's template API cannot supply it — `GET
/task_templates/<gid>` for the Bug Template returns `subtasks: []`.

**Template drift is handled two ways**, because "the capture goes stale" is a
when-not-if:
1. The ticked-box signal does not depend on the capture at all — it survives a
   complete rewording.
2. A line that is only a label (`Target date:`) never counts as written content,
   captured or not. This is not theoretical: during validation a single
   `Target date:` heading present in the live template but missing from the
   capture silently cleared two pristine RCAs.

No quality bar is applied. Grading an RCA by length would nag people who did the
work — the exact failure this feature exists to avoid.

### Dating the closure

`completed_at` is exact and free. Tickets **parked in the Done section without
the completion checkbox** have no such stamp, and `modified_at` alone is wrong
for a tight cutoff: it dates the ticket by its last EDIT, so a ticket parked in
Done last week would clear a same-day floor just because someone touched it this
morning.

Those tickets get a stories read, and the timestamp of the most recent
`moved … to "Done" in Software Board` story is used instead. `modified_at`
survives only as the last resort when no such story exists, and the rendered age
hedges when it does ("in Done 3d" rather than "closed 3d ago").

`modified_at` is still a valid *upper bound* on the move, which is what makes it
safe to pre-filter the board scan with before spending a stories read.

## Output

```
🔍 *RCA follow-ups* — 1 bug was closed without a root cause analysis
*Please fill in the missing RCA as soon as you can* — each one below links straight to the subtask.

• <asana|Bug: Regression: Regular Products Incorrectly Displayed as Preorders…> — Regression · in Done today · assignee: @matt
    ↳ missing: <asana|Engineering RCA> and <asana|QA RCA>
       ✅ already done: Root Cause
```

Each missing half is **named** (`Engineering RCA` / `QA RCA`) rather than shown
as its raw subtask name, and **links directly to the subtask** so nobody has to
hunt for it inside the ticket. Whatever is already written gets credited, so a
half-done ticket does not read as if nobody wrote anything. The legacy
undifferentiated subtask keeps its own board name, since it names no discipline.

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
| `RCA_LOOKBACK_DAYS` | 30 | Rolling window: how far back closed bugs are chased |
| `RCA_START_AT` | `2026-07-28T08:00:00-04:00` | Hard floor; nothing that reached Done earlier is ever listed |

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
