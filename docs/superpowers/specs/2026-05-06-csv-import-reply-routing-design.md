# CSV-Import Reply Routing — Design Spec

**Date**: 2026-05-06
**Author**: Danny + Claude
**Status**: Approved — ready for plan
**Document status**: Approved
**Feature status**: Planned
**Owner**: Danny
**Team / Pod**: Functional (gantri-ai-bot)
**Related links**:
- Sibling spec: `2026-05-05-klaviyo-import-design.md` (the original CSV upload + commit_pending flow this spec amends)
- Existing connector: `src/connectors/klaviyo/connector.ts`
- Existing handler: `src/orchestrator/confirmation-handler.ts`
- Process doc: `docs/process/adding-a-connector.md`

---

## Functional Specification

### Overview

When a marketing user uploads a Klaviyo CSV in Slack, the bot's `file_shared` handler stashes the parsed rows into `pending_confirmations` (kind=`klaviyo_csv_pending`) and asks "Which Klaviyo list should I import them to?". Today, the user's reply is intercepted by `ConfirmationHandler.tryHandle()` and treated as a near-literal list name. The handler dispatches `klaviyo.commit_pending_csv_import({ list: <reply text> })`. Inside `runImport`, a 20-element regex array tries to peel "filler prefixes" ("let's use", "subelos a la lista") off the input before substring-matching against existing Klaviyo lists.

This regex-strip approach has two structural problems:

1. **Brittle to phrasing.** Every phrasing the user invents that doesn't match an existing regex is misinterpreted. Production example: `"I want to save them to lista de prueba, crea la lista si no existe"` — no regex matches `^I want to`, so the entire sentence becomes the candidate list name and the bot replies "There's no list called *I want to save them to lista de prueba, crea la lista si no existe* — want me to create it?".
2. **Cannot capture compound intent.** A reply that simultaneously names a list AND directs the bot to create it if missing is reduced to a single string. The "create if missing" instruction is dropped.

The spec replaces the deterministic `klaviyo_csv_pending` reply handler with an **LLM-routed** flow. The orchestrator receives the reply with the pending CSV state injected as a system note; the LLM decides which existing tools to call (`klaviyo.list_lists`, `klaviyo.create_list`, `klaviyo.commit_pending_csv_import`). A small deterministic fast-path remains only for unambiguous cancel verbs.

### Conceptual

**What it does.** Lets a marketing/admin user reply to the bot's "which list?" prompt with any natural-language phrasing — bare list name, full sentence, compound instruction including "create if missing", off-topic question — and have the bot do the right thing. Cancel verbs (`cancel`, `cancelar`, `abort`) take a deterministic fast-path that bypasses the LLM. Everything else is routed through the orchestrator with the pending-CSV state injected as context, letting the LLM call existing Klaviyo tools to satisfy the user's intent.

**Glossary.**

| Term | Definition |
|---|---|
| **CSV-pending state** | A row in `pending_confirmations` with `kind='klaviyo_csv_pending'` holding parsed CSV rows + filename + storage path, waiting for the caller to pick a target list. Created by the `file_shared` handler. Expires after 30 minutes. |
| **Reply routing** | The decision in `ConfirmationHandler.tryHandle()` of what to do with a reply that arrived in a thread holding a pending row: consume deterministically, return false (let it pass to the orchestrator), or ignore. |
| **Pending context note** | A non-cached system block injected into the orchestrator's `system` array describing the pending CSV state so the LLM interprets the next user message as list-selection intent. |
| **Cancel fast-path** | A regex match for `^(cancel\|cancelar\|abort)$` (case-insensitive, trimmed) that consumes the reply, deletes the pending row, and posts "Cancelled. CSV import not submitted." — bypassing the LLM entirely. |

### Goals

1. Any reasonable phrasing the user gives — Spanish, English, mixed, with filler verbs, with explicit "create if missing", with quoted list names — resolves to the right list (or creates it) without the user having to learn the bot's phrase grammar.
2. The fix removes the brittle 20-regex array entirely. No new regex is added in its place.
3. The current happy path (`yes` / `cancel`) for non-CSV pending kinds (`klaviyo_import`, `klaviyo_delete`) is unchanged.
4. Tests cover the six representative reply patterns identified during brainstorming and gate the merge.

### Non-goals

- Replacing yes/cancel handling for `klaviyo_import` or `klaviyo_delete` confirmations. Those remain deterministic; they are binary decisions, not free-form list selections, and the LLM adds no value.
- Adding a `klaviyo.cancel_pending_csv` tool. Cancel is handled deterministically, not via LLM tool call.
- Changing the `file_shared` handler. The first prompt the user sees ("Got 5 rows from … Which Klaviyo list?") stays the same.
- Migrating the `pending_confirmations.payload` JSON shape. The `awaitingCreateForName` field is dropped from new payloads but old in-flight rows that still carry it are tolerated and treated as if it were absent.

### User-visible behavior

| Reply (in thread with a CSV-pending row) | Resulting action | Bot reply |
|---|---|---|
| `cancel` / `cancelar` / `abort` (case-insensitive, exact match after trim) | Cancel fast-path: delete pending row | `Cancelled. CSV import not submitted.` |
| `lista de prueba` (list exists) | LLM → `commit_pending_csv_import({list:"lista de prueba"})` | `Submitted N profile(s) to Klaviyo (list: lista de prueba). They typically appear within ~1 minute.` |
| `prueba` (list "prueba" exists) | Same as above with list "prueba" | Same shape |
| `I want to save them to lista de prueba, crea la lista si no existe` (list does not exist) | LLM → `create_list({name:"lista de prueba"})` then `commit_pending_csv_import({list:"lista de prueba"})` | `Created list "lista de prueba". Submitted N profile(s)…` |
| `lista de prueba` (list does not exist, no instruction to create) | LLM → `commit_pending_csv_import({list:"lista de prueba"})` returns `LIST_NOT_FOUND` → LLM asks user | `There's no list called "lista de prueba". Want me to create it? Reply yes to create, or pick a different list name.` |
| `no list` / `skip` / `sin lista` | LLM → `commit_pending_csv_import({list:"no list"})` (the connector recognizes these tokens and omits list-membership) | `Submitted N profile(s) to Klaviyo. They typically appear within ~1 minute.` |
| `actually wait, ignore that` (or any off-topic) | LLM responds with text only, calls no tool | LLM-generated; pending row stays alive |
| Reply more than 30 minutes after upload | Pending row already expired; orchestrator behaves as if no pending exists; LLM may answer general questions | LLM-generated; user can re-upload |

### Out of scope (non-goals expanded)

- Fuzzy-matching list names typed with typos. If the user types `lsita de prueba`, the LLM may either trust the input verbatim (causing `LIST_NOT_FOUND`) or pick a near-match if the system note's available-lists list contains the right one. We rely on the LLM's substring/levenshtein-equivalent reasoning; no new connector logic is added.
- Multi-list import in one reply. If the user says "add them to A and B", the LLM picks one (it cannot fan out — `commit_pending_csv_import` deletes the pending row on success). This stays a manual second-CSV operation. The bot should clarify rather than guess; tested in §Testing.

---

## Technical Specification

### Architecture

```
Slack message in thread
        │
        ▼
slack/handlers.ts: onMessage
        │
        ▼
ConfirmationHandler.tryHandle()
        │
        ├─ pending kind != klaviyo_csv_pending ──► existing yes/cancel logic (unchanged)
        │
        └─ pending kind = klaviyo_csv_pending
                │
                ├─ /^(cancel|cancelar|abort)$/i ──► delete pending; post "Cancelled."; return true
                │
                └─ anything else ──────────────────► return false  (orchestrator handles it)
                                                             │
                                                             ▼
                                              orchestrator.run({ question, pendingContext })
                                                             │
                                              ┌──────────────┴──────────────┐
                                              │ system blocks:              │
                                              │ [base prompt (cached)]      │
                                              │ [pending CSV note (no       │
                                              │  cache_control — varies     │
                                              │  per turn)]                 │
                                              └──────────────┬──────────────┘
                                                             │
                                                             ▼
                                              LLM tool-loop, may call:
                                                - klaviyo.list_lists
                                                - klaviyo.create_list
                                                - klaviyo.commit_pending_csv_import
                                                or just respond with text
```

### Components affected

#### 1. `src/orchestrator/confirmation-handler.ts`

Drop the entire `klaviyo_csv_pending` arm except for the cancel fast-path. Specifically, delete:

- `executeCsvImport()`, `executeCreateAndImport()` — replaced by orchestrator + existing tools
- `awaitingCreateForName` payload reads/writes
- `isYes` / `isNo` regexes for that kind
- `runTool` dependency injected for CSV dispatch (and the `runTool?` field on `ConfirmationHandlerDeps`)

The kept logic for that kind shrinks to:

```ts
if (pending.kind === 'klaviyo_csv_pending') {
  const text = msg.text.trim();
  if (/^(cancel|cancelar|abort)$/i.test(text)) {
    await this.deps.pendingRepo.deleteById(pending.id);
    await this.deps.slack.postMessage(msg.channelId, 'Cancelled. CSV import not submitted.', safeThreadTs(msg.threadTs));
    logger.info({ pendingId: pending.id, caller: pending.callerSlackId }, 'klaviyo_csv_cancelled');
    return true;
  }
  return false; // Let the orchestrator handle list selection / creation / off-topic.
}
```

The `klaviyo_import` and `klaviyo_delete` arms remain unchanged.

#### 2. `src/orchestrator/orchestrator.ts`

Extend `OrchestratorInput` with an optional `pendingContext` field:

```ts
export interface OrchestratorPendingCsvContext {
  kind: 'klaviyo_csv_pending';
  filename: string;
  rowCount: number;
  channels: ('email' | 'sms')[];
  availableLists: Array<{ id: string; name: string }>;
}

export interface OrchestratorInput {
  // ... existing fields
  pendingContext?: OrchestratorPendingCsvContext;
}
```

When `pendingContext` is provided, append a second item to the `system` array **without `cache_control`** (so the per-turn pending note doesn't pollute the cached base prompt). The text:

```
The user has a pending Klaviyo CSV import in this thread. Filename: <filename>. Rows ready to import: <rowCount>. Subscription channels chosen at upload: <channels>.

Interpret the user's next message as one of:
- A list selection (e.g., "Trade Show Leads", "the welcome list", "no list") → call klaviyo.commit_pending_csv_import with that exact list name. Pass "no list" / "none" / "skip" / "sin lista" verbatim — the tool recognizes them and omits list-membership.
- An instruction that names a list AND asks you to create it if missing (e.g., "lista de prueba, créala si no existe") → call klaviyo.create_list({name}) FIRST, then klaviyo.commit_pending_csv_import({list:name}).
- A confirmation/decline of a previous question YOU asked (e.g., user replied "yes" after you asked "want me to create it?") → carry out the implied action.
- An off-topic message → answer normally; do NOT touch the pending import.

Available Klaviyo lists in this account (id — name):
<one per line>

Hard rules:
- DO NOT call klaviyo.import_profiles directly. The CSV rows live only in the pending row; only klaviyo.commit_pending_csv_import can access them.
- DO NOT invent list names. If the user named a list, pass that exact string to commit_pending_csv_import.
- The cancel verb (`cancel`/`cancelar`/`abort`) is handled before you see the message; you will not be invoked for it.
```

The `availableLists` array is fetched by the slack handler before calling `orchestrator.run` (one call to `klaviyo.client.listLists()`, max ~150ms). If the call fails the handler omits the lists from the context note and lets the LLM call `klaviyo.list_lists` itself if needed.

#### 3. `src/slack/handlers.ts`

Where the handler currently dispatches to `confirmationHandler.tryHandle` and (on `consumed=false`) to `orchestrator.run`, add a step that — when the original lookup found a `klaviyo_csv_pending` row and the handler returned `false` — fetches the list directory and assembles the `pendingContext` to pass to the orchestrator.

Sketch:

```ts
const pendingForContext = consumed ? null : await deps.pendingRepo.lookupByThread(...);
let pendingContext: OrchestratorPendingCsvContext | undefined;
if (pendingForContext?.kind === 'klaviyo_csv_pending') {
  const payload = pendingForContext.payload as { profiles: any[]; filename: string; channels: string[] };
  const lists = await deps.klaviyoClient.listLists().catch(() => null);
  pendingContext = {
    kind: 'klaviyo_csv_pending',
    filename: payload.filename,
    rowCount: payload.profiles.length,
    channels: (payload.channels ?? ['email']) as ('email'|'sms')[],
    availableLists: lists ?? [],
  };
}
const out = await deps.orchestrator.run({ ..., pendingContext });
```

The double `lookupByThread` (once in `tryHandle`, once here) is fine: pendings are cheap row reads keyed by indexed (caller, channel, thread) and the second call only happens when the first didn't consume the message. To avoid the double-fetch we could have `tryHandle` return the pending row alongside `consumed`, but that's an internal refactor we punt on; documented under Future Work.

#### 4. `src/connectors/klaviyo/connector.ts` — `runImport`

Delete the entire `stripPrefixes` array and the iterative strip loop (lines ~707-762 in current code). Keep:

- Direct id match (`lists.find((l) => l.id === args.list)`)
- Exact-name match (case-insensitive)
- Whole-word substring containment with the longest-name preference (already implemented)
- Trailing-punctuation trim (one-line regex, retained because LLM output occasionally includes a trailing comma)

The fallback when nothing resolves: return `LIST_NOT_FOUND` with `details.suggestions` (top 5 lists whose names appear as a substring of the input) and `details.normalizedName` set to the trimmed input. The LLM uses these to ask the user to confirm or pick.

`runCommitPendingCsv` requires no logical change. The `awaitingCreateForName` field is no longer written; if an old pending row still carries it the field is simply ignored.

#### 5. `src/orchestrator/prompts.ts`

The base system prompt mentions `klaviyo.commit_pending_csv_import` already (line 142). Update that bullet to remove references to the old "ask the user to disambiguate (same flow as the inline-import unknown-list case)" indirection, since now the LLM is invoked WITH pending context. New text emphasizes that when a CSV-pending context is injected, the LLM's job is to call `commit_pending_csv_import` (or precede it with `create_list`); it should not call `klaviyo.import_profiles` for CSV-origin rows.

### Data flow — happy path

User uploads CSV →
`file_shared` handler parses rows, inserts `pending_confirmations` (`kind=klaviyo_csv_pending`), posts "Got N rows… Which list?" →
User replies "lista de prueba, créala si no existe" →
slack handler: `tryHandle` returns false (not cancel) →
slack handler: fetches list directory, builds `pendingContext` →
`orchestrator.run({ question: <reply>, pendingContext })` →
LLM sees system note with available lists, decides "lista de prueba" not in list →
LLM calls `klaviyo.create_list({ name: "lista de prueba" })` → returns `{ ok, id, name: "lista de prueba" }` →
LLM calls `klaviyo.commit_pending_csv_import({ list: "lista de prueba" })` → connector resolves by name, runs `runImport` → bulk-subscribe → `kind: imported_directly` →
`commit_pending_csv_import` deletes the pending row →
LLM composes the success message and returns it →
slack handler posts the message in the thread.

### Data flow — error / edge paths

- **LLM picks a list that doesn't exist and didn't read the system note's `availableLists`.** The first `commit_pending_csv_import` returns `LIST_NOT_FOUND` with suggestions. The LLM uses the suggestions to either retry with the correct name (silent self-correction) or ask the user to disambiguate. The pending row is preserved (it's only deleted when the import advances past list resolution).
- **`klaviyo.client.listLists()` errors when the slack handler tries to populate `availableLists`.** Handler omits the list directory and proceeds. The LLM may call `klaviyo.list_lists` itself; or, if the user gave a clear list name, it goes straight to `commit_pending_csv_import` and recovers via `LIST_NOT_FOUND` if needed.
- **LLM hits its tool-iteration cap or errors.** Standard orchestrator failure path: post a generic "Sorry — something went wrong" message; pending row stays alive; user can retry within the 30-minute window.
- **User replies `cancel` IN THE MIDDLE of a multi-turn LLM exchange.** The fast-path in `tryHandle` runs before the orchestrator. The pending row is deleted; subsequent turns of any in-flight LLM call are still answered by the LLM but find no pending row (`pendingContext` is omitted from a re-entry), so they degrade gracefully to a normal conversation.
- **Pending row expired (>30 min) between upload and reply.** `lookupByThread` returns null; `pendingContext` is `undefined`; orchestrator runs as a normal conversation. The LLM cannot find a CSV to import and will explain that the pending expired.
- **Old pending row still carries `awaitingCreateForName`.** Field is no longer read anywhere; ignored. No migration needed.

### Configuration / feature-flag

No feature flag. The change is a behavior fix; the old behavior is broken in production. Rollout = deploy.

### Performance / cost

- **Latency.** Adds ~1–2s for non-cancel CSV-pending replies (one extra LLM round-trip when the LLM does a single tool call; up to ~3s if it chains create_list + commit). Cancel replies stay deterministic (no LLM call).
- **Token cost.** The pending context note adds ~250 input tokens per CSV-pending reply, billed at the non-cached rate. Negligible. The `availableLists` directory adds ~30 tokens per list (Klaviyo accounts have on the order of 50 lists, so ~1.5k tokens once per CSV-pending reply).
- **API call count.** Adds one `klaviyo.client.listLists()` call per CSV-pending reply (cached account-side; rate-limited at 75/m, well within budget).

---

## Testing Specification

### Layer 1 — unit tests (no LLM)

`tests/unit/orchestrator/confirmation-handler.test.ts` — extend with:

- ✅ `cancel` / `cancelar` / `abort` (mixed case, with whitespace) → returns `true`, deletes pending, posts cancellation message.
- ✅ Anything else with `kind=klaviyo_csv_pending` → returns `false`, leaves pending row intact, does NOT call `slack.postMessage`.
- ✅ `kind=klaviyo_import` + `yes` → unchanged behavior (regression test, already exists).
- ✅ `kind=klaviyo_delete` + `cancel` → unchanged behavior.
- ✅ Caller mismatch on a `klaviyo_csv_pending` → returns `false` (logged, not consumed).

`tests/unit/connectors/klaviyo/connector.test.ts` — extend with:

- ✅ `runImport` with `list: "Trade Show Leads"` and exact match → resolves to that list id; no regex strip path involved.
- ✅ `runImport` with `list: "lista de prueba"` containing a list name as a whole-word substring of the input → resolves to the contained list (existing behavior, must still pass).
- ✅ `runImport` with `list: "let's use lista de prueba"` (the string the regex-strip used to handle) — verifies whole-word substring matching still finds "lista de prueba" without the stripper. **If this test fails, our deletion of `stripPrefixes` is unsafe; we must adjust the substring-matching to handle this case before merging.**
- ✅ `runImport` with `list: "totally novel name"` → returns `LIST_NOT_FOUND` with `details.suggestions=[]` and `details.normalizedName="totally novel name"`.
- ✅ `runCommitPendingCsv` with `list: "no list"` → calls `runImport` with `list: undefined`; pending row is deleted on success.

### Layer 2 — orchestrator integration tests with mocked Anthropic client

New file: `tests/unit/orchestrator/csv-pending-routing.test.ts`.

The mock Anthropic client returns scripted responses keyed by `messages` content. Each test asserts the sequence of `tool_use` blocks the LLM emits and the final text response.

Test cases (all with `pendingContext` populated and a `runToolDirect` spy on the connector registry):

1. **Bare list name, list exists.** Reply = `"lista de prueba"`; available lists include `"lista de prueba"`. Expected tool calls: `[klaviyo.commit_pending_csv_import({list:"lista de prueba"})]`. Final response includes "Submitted".
2. **Compound intent — name + create-if-missing, list missing.** Reply = `"I want to save them to lista de prueba, crea la lista si no existe"`; available lists do NOT include it. Expected: `[klaviyo.create_list({name:"lista de prueba"}), klaviyo.commit_pending_csv_import({list:"lista de prueba"})]`. Final response includes both "Created" and "Submitted".
3. **Skip list.** Reply = `"no list"`. Expected: `[klaviyo.commit_pending_csv_import({list:"no list"})]`. (The connector's `skipList` regex turns this into `list: undefined` in `runImport`.)
4. **Short ambiguous token, list exists with that exact name.** Reply = `"prueba"`; available lists include `"prueba"`. Expected: `[klaviyo.commit_pending_csv_import({list:"prueba"})]`. Verifies the LLM does not interpret the bare word as a help request when the system note frames it as list-selection intent.
5. **Off-topic mid-flow.** Reply = `"actually wait, how many rows did you say?"`. Expected: zero tool calls; final response is text including the row count from the system note. Pending row not touched.
6. **Bare list name, list missing.** Reply = `"prueba nueva"`; available lists do not include it. Expected: `[klaviyo.commit_pending_csv_import({list:"prueba nueva"})]` returns `LIST_NOT_FOUND`; LLM follows up with text like "There's no list called 'prueba nueva' — want me to create it?" (no second tool call until user confirms).
7. **Multi-list ambiguity.** Reply = `"add them to A and B"` where both A and B exist. Expected: zero `commit_pending_csv_import` calls; final response asks the user to pick one. Pending row not touched.

Each test uses the existing `tests/fixtures/connector-registry-mock` (or extends it) so `runToolDirect` resolves with shape-compatible results without hitting Klaviyo. The mocked Anthropic responses are written as plain JSON fixtures (`tests/fixtures/anthropic-responses/csv-pending-*.json`) — one fixture per test — so the prompt can change without breaking the test as long as the assertions on tool-call args still hold.

### Layer 3 — E2E smoke checklist (manual, before deploy)

Run with the real bot in staging slack channel against a real Klaviyo account using a throwaway list `"e2e-test-throwaway"`:

1. Upload a 5-row CSV → bot prompts.
2. Reply `cancel` → bot cancels; no Klaviyo write.
3. Re-upload → reply `e2e-test-throwaway` → list exists → import succeeds.
4. Re-upload → reply `e2e-throwaway-2, créala si no existe` → list created + import succeeds; verify both calls land via `klaviyo_imports` audit row + the new list's `Created at` timestamp in Klaviyo.
5. Re-upload → reply `lista que no existe` → bot replies asking whether to create; reply `yes` → list created + import succeeds.
6. Re-upload → reply `no list` → import succeeds, no list-membership in Klaviyo.
7. Re-upload → wait 31 minutes → reply with anything → bot says the pending expired (or just answers conversationally without committing).

All audit rows in `klaviyo_imports` should reference the correct caller and the right list. Cleanup: archive `e2e-test-throwaway*` lists; delete imported test profiles via `klaviyo.delete_profiles`.

### Coverage gate

Layers 1+2 must pass in CI. Layer 3 is a pre-deploy manual checklist; failure on any item blocks the deploy.

---

## Operational Specification

### Deploy

`fly deploy` to `gantri-ai-bot`. No DB migration. No vault secret changes. No feature flag.

### Rollback

Revert the merge commit + redeploy. The dropped `awaitingCreateForName` field re-enters the payload schema; pending rows created during the new-code window won't carry that field but the old code tolerates its absence (the existing `payload.awaitingCreateForName ?? null` already handles it).

### Observability

- Existing `klaviyo_csv_cancelled` log line (kept).
- New: `klaviyo_csv_routed_to_orchestrator` log line at `info` with `{ pendingId, caller }` whenever `tryHandle` returns false on a `klaviyo_csv_pending`. Lets us count how often the LLM path is used vs. the cancel fast-path in production.
- The orchestrator's existing `tool_call` / `tool_finish` logging captures the LLM's behavior; no new instrumentation needed there.

### Alerting

No new alerts. The existing import-failure paths (Klaviyo 4xx, schema invalid, etc.) still surface via `klaviyo_csv_exec_failed` / `klaviyo_import_submitted`.

---

## Security Specification

- The `klaviyo.commit_pending_csv_import` and `klaviyo.create_list` tools both check `role IN ('admin','marketing')` via `usersRepo.getRole(actor.slackUserId)` before executing. The orchestrator's tool dispatcher passes through the same actor context that the deterministic handler used; no privilege escalation is introduced.
- The cancel fast-path performs a write (delete pending row) but only against the caller's own pending row (the `tryHandle` caller-mismatch guard remains).
- Pending CSV state injected into the LLM context contains: filename, row count, channels, list directory. No row contents (emails, phone numbers, names) cross the LLM boundary. CSV PII stays in the database.
- The `availableLists` directory is account-wide metadata (list ids + names), not customer PII.

---

## Related Work

- `2026-05-05-klaviyo-import-design.md` — the original CSV upload design. This spec amends the "reply routing" portion of that flow without changing the upload, validation, or audit behavior.
- The `pending_confirmations` table and TTL behavior (30 min, soft-deleted on consume) are inherited unchanged.
- The `klaviyo.create_list` tool was added as part of `2026-05-05`. This spec leans on it without modification.

---

## Open Questions

1. **Should the cancel fast-path also accept `cancela`, `nope`, `stop`?** Current scope: only `cancel|cancelar|abort` (matches existing behavior). Anything else routes through the LLM, which can interpret it. Decision: leave narrow; widen if production usage shows users typing other cancel verbs and getting frustrated by LLM latency.
2. **Should we add a unit-level helper that `tryHandle` can return both `consumed` and the looked-up `pending` row, to avoid the double-fetch in the slack handler?** Decision: punt. The double-fetch is one indexed read on a small table (`pending_confirmations`), and only on non-cancel CSV-pending replies (a low-traffic path). Refactor as a follow-up if a profiler flags it.
3. **Should we pre-fetch `availableLists` only when the orchestrator is invoked WITH a `klaviyo_csv_pending` context, or also for any DM with the bot?** Decision: only on CSV-pending. Other paths don't need it; the LLM can call `klaviyo.list_lists` if it wants.

---

## Future Work

- Apply the same "LLM-routed reply" pattern to the `klaviyo_import` and `klaviyo_delete` confirmation kinds if production shows users replying with anything other than `yes`/`cancel` (e.g., "yes but skip the first row"). Not currently observed.
- Consolidate the slack handler's pending-row lookup into a single helper that returns `{ consumed, pendingForContext }` so the orchestrator path doesn't pay the double-fetch.
- Telemetry dashboard panel: % of CSV-pending replies that resolved via cancel fast-path vs. LLM single-call vs. LLM multi-call vs. LLM-asked-followup. Useful for tuning the system note over time.
