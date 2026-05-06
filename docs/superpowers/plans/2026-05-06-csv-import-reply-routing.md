# CSV-Import Reply Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the brittle 20-regex `stripPrefixes` array + the deterministic `klaviyo_csv_pending` reply handler with an LLM-routed flow that injects pending CSV state into the orchestrator's system prompt and lets the LLM call existing Klaviyo tools to satisfy any reasonable user phrasing.

**Architecture:**
- `ConfirmationHandler` keeps a *cancel-only* fast-path for `klaviyo_csv_pending` and returns `false` (let-it-pass) for everything else.
- `Orchestrator` accepts a new optional `pendingContext` input. When set, it appends a non-cached system block describing the pending CSV + available Klaviyo lists and tells the LLM how to interpret the next reply.
- `slack/handlers.ts` looks up the pending row + Klaviyo list directory after `tryHandle` returns `false`, builds the `pendingContext`, and passes it to `orchestrator.run`.
- `klaviyo` connector loses the entire `stripPrefixes` regex array. Whole-word substring matching + trailing-punctuation trim remain.

**Tech Stack:** TypeScript, Node 20, Vitest, Anthropic SDK (mocked in tests), Supabase (untouched), Slack Bolt (untouched).

**Spec:** `docs/superpowers/specs/2026-05-06-csv-import-reply-routing-design.md`

---

## File Map

**Modify:**
- `src/connectors/klaviyo/connector.ts` — drop `stripPrefixes`; keep substring match
- `src/orchestrator/confirmation-handler.ts` — collapse `klaviyo_csv_pending` arm to cancel fast-path
- `src/orchestrator/orchestrator.ts` — add `pendingContext` input + non-cached system block
- `src/orchestrator/prompts.ts` — update the `commit_pending_csv_import` bullet
- `src/slack/handlers.ts` — fetch pending state + list directory; pass to orchestrator
- `src/index.ts` — pass `klaviyoClient` + `pendingRepo` into `createDmHandler` deps; remove `runTool` from `ConfirmationHandler` construction
- `tests/unit/orchestrator/confirmation-handler.test.ts` — drop deleted-arm tests; add cancel-only tests
- `tests/unit/orchestrator/orchestrator.test.ts` — add `pendingContext` system block tests
- `tests/unit/connectors/klaviyo/import-tool.test.ts` — delete `it.each` strip-prefixes block; keep substring tests
- `tests/unit/slack/handlers.test.ts` — add pending-context wiring tests

**Create:**
- `tests/unit/orchestrator/csv-pending-routing.test.ts` — 7 LLM-mocked end-to-end scenarios

**Delete:** Nothing (only file content removed inside existing files).

---

## Conventions for this plan

- All commands assume CWD `/Users/danierestevez/Documents/work/gantri/gantri-ai-bot`.
- Tests run via `npx vitest run <path>` for a single file; `npx vitest run` for the whole suite.
- Each task ends with a commit. Commit messages follow this repo's style (`fix(area):`, `refactor(area):`, `test(area):` lowercase prefix). Use the `Co-Authored-By: Claude Opus 4.7 (1M context)` trailer per project default.
- Do NOT change the `pending_confirmations` schema. The `awaitingCreateForName` field stays in the JSONB payload type informally; we just stop writing it.

---

### Task 1: Drop `stripPrefixes` from connector + update connector tests

**Files:**
- Modify: `src/connectors/klaviyo/connector.ts:687-764`
- Modify: `tests/unit/connectors/klaviyo/import-tool.test.ts:180-219` (delete `it.each` block)
- Modify: `tests/unit/connectors/klaviyo/import-tool.test.ts:146-160` (test stays — still passes via substring match)

**Why this first:** Removing the regex array changes the resolution semantics in `runImport`. The connector tests are the smallest blast radius and prove substring matching still works.

- [ ] **Step 1: Update `import-tool.test.ts` — delete strip-prefix tests**

Open `tests/unit/connectors/klaviyo/import-tool.test.ts`. Delete the entire `it.each([...])` block at lines 180-219 (the one whose title starts with `'strips filler prefix from %j'`). Keep the test at lines 146-160 ("extracts list name from natural-language phrases") because it relies on whole-word substring matching, which is preserved.

Add a new test directly after the kept "natural-language phrases" test:

```ts
it('returns LIST_NOT_FOUND with the raw input when no whole-word match (no prefix stripping)', async () => {
  const deps = makeDeps({ listLists: [{ id: 'L_OTHER', name: 'Some Other List' }] });
  const tool = getTool(deps);
  const r = await tool.execute({
    profiles: [{ email: 'a@x.com' }],
    channels: ['email'],
    list: "let's use lista de prueba", // no list named "lista de prueba" exists
  });
  expect((r as any).error?.code).toBe('LIST_NOT_FOUND');
  // After dropping stripPrefixes, normalizedName is the trimmed raw input
  // (we still strip wrapping quotes + trailing punctuation, nothing else).
  expect((r as any).error.details.normalizedName).toBe("let's use lista de prueba");
});

it('strips wrapping quotes and trailing punctuation only', async () => {
  const deps = makeDeps({ listLists: [{ id: 'L_OTHER', name: 'Some Other List' }] });
  const tool = getTool(deps);
  const r = await tool.execute({
    profiles: [{ email: 'a@x.com' }],
    channels: ['email'],
    list: '"lista de prueba".',
  });
  expect((r as any).error?.code).toBe('LIST_NOT_FOUND');
  expect((r as any).error.details.normalizedName).toBe('lista de prueba');
});
```

- [ ] **Step 2: Run the updated test — expect failures on the two new cases**

Run: `npx vitest run tests/unit/connectors/klaviyo/import-tool.test.ts`

Expected: the two new tests FAIL because `stripPrefixes` currently rewrites `"let's use lista de prueba"` to `"lista de prueba"`, so the assertion `normalizedName === "let's use lista de prueba"` fails. The other tests still pass.

- [ ] **Step 3: Drop `stripPrefixes` from `connector.ts`**

In `src/connectors/klaviyo/connector.ts`, replace the block from `// Strip leading "verb + preposition" filler ...` (around line 692) through the end of the iteration loop (around line 762) with the simpler version below. Keep the trailing-punctuation strip and the substring-matching that follows.

Specifically, REPLACE these lines (from the `const VERBS_EN = ...` declaration through the closing `for (let i = 0; i < 3 && changed; i++) { ... }` loop) with just:

```ts
let normalizedRaw = args.list.trim();
// Strip wrapping quotes + trailing punctuation only. The LLM is responsible
// for extracting the list name from natural-language phrases before calling
// this tool — we no longer try to peel filler prefixes here. (The pending-CSV
// reply path injects a system note instructing the LLM to do the extraction.)
normalizedRaw = normalizedRaw.replace(/^["'`«»“”‘’]+|["'`«»“”‘’]+$/g, '').replace(/[.,;:!?]+$/g, '').trim();
```

Leave the `const needle = (normalizedRaw || rawNeedle).toLowerCase();` line and everything after it unchanged.

- [ ] **Step 4: Run the connector tests — expect green**

Run: `npx vitest run tests/unit/connectors/klaviyo/import-tool.test.ts`

Expected: all tests PASS, including:
- "returns LIST_NOT_FOUND with the raw input when no whole-word match" (new)
- "strips wrapping quotes and trailing punctuation only" (new)
- "extracts list name from natural-language phrases" (kept; passes via substring match)
- "does NOT false-match a short list name (PR) inside a longer word" (kept regression guard)
- "multiple natural-language matches → LIST_NOT_FOUND with both as suggestions" (kept)

If the substring-match test fails, the substring logic at `connector.ts:776-808` may have depended on a `normalizedRaw` that the regex array produced. Re-read that block — it operates on `needle` (lowercased `normalizedRaw`), so it should still work: "subelos a lista de prueba" still contains "lista de prueba" as a whole-word substring. Don't add new logic; investigate before changing anything.

- [ ] **Step 5: Run the broader klaviyo test suite to catch regressions**

Run: `npx vitest run tests/unit/connectors/klaviyo/`

Expected: all PASS. If `connector.test.ts` or another file has assertions that depended on `stripPrefixes`, treat those as additional cleanup — read the failing test, decide whether the test was validating now-removed behavior, and either delete it or rewrite to test the substring-match behavior.

- [ ] **Step 6: Commit**

```bash
git add src/connectors/klaviyo/connector.ts tests/unit/connectors/klaviyo/import-tool.test.ts
git commit -m "$(cat <<'EOF'
refactor(klaviyo): drop stripPrefixes regex array from runImport

The 20-regex prefix stripper is replaced by LLM-driven extraction at the
orchestrator layer (next commits). Whole-word substring matching against
existing list names is retained — that's robust on its own. New tests
prove the trailing-punctuation/quote strip + substring match still
resolve "subelos a lista de prueba" → "lista de prueba" without the
regex prefix array.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Collapse `ConfirmationHandler` CSV-pending arm to cancel-only

**Files:**
- Modify: `src/orchestrator/confirmation-handler.ts:74-124` (the `klaviyo_csv_pending` arm)
- Modify: `src/orchestrator/confirmation-handler.ts:14-21` (drop `runTool` from `ConfirmationHandlerDeps`)
- Modify: `src/orchestrator/confirmation-handler.ts:156-244` (delete `executeCreateAndImport` + `executeCsvImport`)
- Modify: `tests/unit/orchestrator/confirmation-handler.test.ts` — drop CSV-execution tests, add cancel-only + return-false tests

**Why now:** With the regex stripper gone in Task 1, the only user-facing failure mode for non-cancel CSV-pending replies is the broken bot reply ("There's no list called I want to save them to..."). We replace that path with `return false` so the orchestrator can take over (wired in Task 4). The cancel path stays deterministic.

- [ ] **Step 1: Read the existing test file to see what asserts CSV-pending flow**

Run: `grep -n "klaviyo_csv_pending\|executeCsvImport\|executeCreateAndImport\|awaitingCreateForName" tests/unit/orchestrator/confirmation-handler.test.ts`

Note the tests that will need to be deleted or rewritten. Tests that assert `klaviyo_import` or `klaviyo_delete` (the yes/cancel flows) MUST remain unchanged.

- [ ] **Step 2: Update `tests/unit/orchestrator/confirmation-handler.test.ts` — replace CSV tests**

Delete every test inside the existing CSV-pending describe block (or every `it(...)` whose `pending.kind === 'klaviyo_csv_pending'` exercises non-cancel behavior). Replace with the following tests. Preserve the `makeDeps()` factory and any `klaviyo_import` / `klaviyo_delete` tests as-is.

```ts
describe('klaviyo_csv_pending — cancel fast-path only', () => {
  it('returns true and deletes the pending row on "cancel"', async () => {
    const { handler, pendingRepo, slack } = makeDeps({
      pending: {
        id: 'pid_1',
        callerSlackId: 'U1',
        channelId: 'C1',
        threadTs: 'C1',
        kind: 'klaviyo_csv_pending',
        payload: { profiles: [], filename: 'test.csv', storagePath: null, channels: ['email'] },
      },
    });
    const consumed = await handler.tryHandle({ slackUserId: 'U1', channelId: 'C1', threadTs: 'C1', text: 'cancel' });
    expect(consumed).toBe(true);
    expect(pendingRepo.deleteById).toHaveBeenCalledWith('pid_1');
    expect(slack.postMessage).toHaveBeenCalledWith('C1', expect.stringMatching(/Cancelled/i), undefined);
  });

  it.each(['cancelar', 'abort', 'CANCEL', '  cancel  '])(
    'returns true on "%s" (case-insensitive, trimmed)',
    async (text) => {
      const { handler, pendingRepo } = makeDeps({
        pending: {
          id: 'pid_1', callerSlackId: 'U1', channelId: 'C1', threadTs: 'C1',
          kind: 'klaviyo_csv_pending',
          payload: { profiles: [], filename: 'x.csv', storagePath: null, channels: ['email'] },
        },
      });
      const consumed = await handler.tryHandle({ slackUserId: 'U1', channelId: 'C1', threadTs: 'C1', text });
      expect(consumed).toBe(true);
      expect(pendingRepo.deleteById).toHaveBeenCalledWith('pid_1');
    },
  );

  it.each([
    'lista de prueba',
    'I want to save them to lista de prueba, crea la lista si no existe',
    'no list',
    'yes',
    'prueba',
    'how many rows did you say?',
  ])('returns false (defers to orchestrator) on "%s"', async (text) => {
    const { handler, pendingRepo, slack } = makeDeps({
      pending: {
        id: 'pid_1', callerSlackId: 'U1', channelId: 'C1', threadTs: 'C1',
        kind: 'klaviyo_csv_pending',
        payload: { profiles: [], filename: 'x.csv', storagePath: null, channels: ['email'] },
      },
    });
    const consumed = await handler.tryHandle({ slackUserId: 'U1', channelId: 'C1', threadTs: 'C1', text });
    expect(consumed).toBe(false);
    expect(pendingRepo.deleteById).not.toHaveBeenCalled();
    expect(slack.postMessage).not.toHaveBeenCalled();
  });

  it('returns false (caller mismatch) when the reply is from a different Slack user', async () => {
    const { handler } = makeDeps({
      pending: {
        id: 'pid_1', callerSlackId: 'U_OWNER', channelId: 'C1', threadTs: 'C1',
        kind: 'klaviyo_csv_pending',
        payload: { profiles: [], filename: 'x.csv', storagePath: null, channels: ['email'] },
      },
    });
    const consumed = await handler.tryHandle({ slackUserId: 'U_OTHER', channelId: 'C1', threadTs: 'C1', text: 'cancel' });
    expect(consumed).toBe(false);
  });
});
```

If the existing `makeDeps()` factory does not yet support a `pending` parameter, extend it minimally (return `pendingRepo.lookupByThread = vi.fn(async () => opts.pending ?? null)`). If extending is non-trivial, prefer creating a small local `makeDeps2()` helper inline for these tests.

- [ ] **Step 3: Run tests — expect failures**

Run: `npx vitest run tests/unit/orchestrator/confirmation-handler.test.ts`

Expected: cancel-only tests PASS (current code already cancels), but the "returns false on …" tests FAIL because the current code consumes those messages and tries to import via `executeCsvImport`.

- [ ] **Step 4: Replace the CSV-pending arm in `confirmation-handler.ts`**

In `src/orchestrator/confirmation-handler.ts`, replace the entire `if (pending.kind === 'klaviyo_csv_pending') { ... }` block (currently lines 74-124) with this minimal version:

```ts
if (pending.kind === 'klaviyo_csv_pending') {
  const text = msg.text.trim();
  if (/^(cancel|cancelar|abort)$/i.test(text)) {
    await this.deps.pendingRepo.deleteById(pending.id);
    await this.deps.slack.postMessage(msg.channelId, 'Cancelled. CSV import not submitted.', safeThreadTs(msg.threadTs));
    logger.info({ pendingId: pending.id, caller: pending.callerSlackId }, 'klaviyo_csv_cancelled');
    return true;
  }
  // Anything other than cancel: let the orchestrator interpret the reply
  // with pending CSV state injected as a system note. The slack handler
  // re-fetches the pending row and builds OrchestratorPendingCsvContext.
  logger.info({ pendingId: pending.id, caller: pending.callerSlackId }, 'klaviyo_csv_routed_to_orchestrator');
  return false;
}
```

Then delete the now-unused private methods at the bottom of the file:
- `executeCreateAndImport` (entire method)
- `executeCsvImport` (entire method)

In `ConfirmationHandlerDeps`, remove the `runTool?` field (lines 14-21 of the interface). The dispatcher is no longer needed because no CSV tool is dispatched from this handler anymore.

- [ ] **Step 5: Update `src/index.ts` — drop the `runTool` argument**

In `src/index.ts` around line 218, remove the `runTool: async (...) => orchestrator.runToolDirect(...)` block from the `new ConfirmationHandler({ ... })` construction. The other deps stay.

- [ ] **Step 6: Run tests — expect green**

Run: `npx vitest run tests/unit/orchestrator/confirmation-handler.test.ts`

Expected: all tests PASS. Then run the full suite to confirm no other consumer of `ConfirmationHandlerDeps.runTool` exists:

Run: `npx vitest run`

If TypeScript or vitest complains about a missing `runTool` property somewhere, search for the offending reference and remove it (no consumer should remain — we deleted the only one in `index.ts`).

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/confirmation-handler.ts src/index.ts tests/unit/orchestrator/confirmation-handler.test.ts
git commit -m "$(cat <<'EOF'
refactor(confirmation-handler): csv-pending arm = cancel-only fast-path

Non-cancel replies now return false so the slack handler can route them
to the orchestrator (next commit) with pending CSV state injected as a
system note. Deletes executeCsvImport / executeCreateAndImport / the
runTool dispatcher dependency. The yes/cancel arms for klaviyo_import
and klaviyo_delete are unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Add `OrchestratorPendingCsvContext` + non-cached system block

**Files:**
- Modify: `src/orchestrator/orchestrator.ts` — add type, extend `OrchestratorInput`, append system block
- Modify: `tests/unit/orchestrator/orchestrator.test.ts` — add tests for the new behavior

- [ ] **Step 1: Write the orchestrator pending-context tests**

Append to `tests/unit/orchestrator/orchestrator.test.ts` (inside the existing `describe('Orchestrator', ...)`):

```ts
it('appends a non-cached pending CSV system block when pendingContext is provided', async () => {
  const { registry } = buildRegistry();
  const create = vi.fn(async () => ({
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
    model: 'claude-sonnet-4-6',
  }));
  const orch = new Orchestrator({
    registry,
    claude: { messages: { create } } as any,
    model: 'claude-sonnet-4-6',
    maxIterations: 3,
  });
  await orch.run({
    question: 'lista de prueba',
    threadHistory: [],
    pendingContext: {
      kind: 'klaviyo_csv_pending',
      filename: 'leads.csv',
      rowCount: 5,
      channels: ['email'],
      availableLists: [
        { id: 'L1', name: 'Trade Show Leads' },
        { id: 'L2', name: 'lista de prueba' },
      ],
    },
  });
  const callArgs = create.mock.calls[0][0];
  expect(Array.isArray(callArgs.system)).toBe(true);
  expect(callArgs.system).toHaveLength(2);
  // Block 0: base system prompt, cached.
  expect(callArgs.system[0].cache_control).toEqual({ type: 'ephemeral' });
  // Block 1: pending CSV note, NOT cached (varies per turn).
  expect(callArgs.system[1].cache_control).toBeUndefined();
  const note = callArgs.system[1].text as string;
  expect(note).toMatch(/leads\.csv/);
  expect(note).toMatch(/Rows ready to import: 5/);
  expect(note).toMatch(/Trade Show Leads/);
  expect(note).toMatch(/lista de prueba/);
  expect(note).toMatch(/klaviyo\.commit_pending_csv_import/);
  expect(note).toMatch(/klaviyo\.create_list/);
  expect(note).toMatch(/DO NOT call klaviyo\.import_profiles/);
});

it('does not append a pending CSV system block when pendingContext is omitted', async () => {
  const { registry } = buildRegistry();
  const create = vi.fn(async () => ({
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
    model: 'claude-sonnet-4-6',
  }));
  const orch = new Orchestrator({
    registry,
    claude: { messages: { create } } as any,
    model: 'claude-sonnet-4-6',
    maxIterations: 3,
  });
  await orch.run({ question: 'hi', threadHistory: [] });
  const callArgs = create.mock.calls[0][0];
  expect(callArgs.system).toHaveLength(1);
});

it('handles availableLists empty (e.g., listLists() failed) without crashing', async () => {
  const { registry } = buildRegistry();
  const create = vi.fn(async () => ({
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
    model: 'claude-sonnet-4-6',
  }));
  const orch = new Orchestrator({
    registry,
    claude: { messages: { create } } as any,
    model: 'claude-sonnet-4-6',
    maxIterations: 3,
  });
  await orch.run({
    question: 'lista de prueba',
    threadHistory: [],
    pendingContext: {
      kind: 'klaviyo_csv_pending',
      filename: 'leads.csv',
      rowCount: 5,
      channels: ['email'],
      availableLists: [],
    },
  });
  const note = (create.mock.calls[0][0].system as any[])[1].text as string;
  // Should still produce a coherent note even without list directory.
  expect(note).toMatch(/leads\.csv/);
  expect(note).toMatch(/list directory unavailable/i);
});
```

- [ ] **Step 2: Run the new tests — expect failures**

Run: `npx vitest run tests/unit/orchestrator/orchestrator.test.ts`

Expected: the three new tests FAIL with errors like "callArgs.system has length 1, expected 2" or TypeScript complaints about `pendingContext` not being a valid input field.

- [ ] **Step 3: Implement `OrchestratorPendingCsvContext` + system block injection**

In `src/orchestrator/orchestrator.ts`:

1. Add the new type and extend `OrchestratorInput`. Place near the existing `OrchestratorInput` declaration (around line 55):

```ts
export interface OrchestratorPendingCsvContext {
  kind: 'klaviyo_csv_pending';
  filename: string;
  rowCount: number;
  channels: ('email' | 'sms')[];
  availableLists: Array<{ id: string; name: string }>;
}

// extend OrchestratorInput with a new optional field
export interface OrchestratorInput {
  question: string;
  threadHistory: Array<{ question: string; response: string | null }>;
  actor?: ActorContext;
  thread?: ThreadContext;
  onToolCall?: (toolName: string) => void | Promise<void>;
  onToolFinish?: (toolName: string, ok: boolean, elapsedMs: number) => void | Promise<void>;
  /** When the user's reply arrives in a thread holding a klaviyo_csv_pending row,
   *  the slack handler builds this and passes it through. The orchestrator appends
   *  a non-cached system block describing the pending state + available lists so
   *  the LLM can interpret the reply as list-selection / creation intent. */
  pendingContext?: OrchestratorPendingCsvContext;
}
```

2. Add a helper function (top-level, near other helpers in the file) to render the system note:

```ts
function buildPendingCsvSystemNote(ctx: OrchestratorPendingCsvContext): string {
  const listsBlock = ctx.availableLists.length > 0
    ? ctx.availableLists.map((l) => `  - ${l.id} — ${l.name}`).join('\n')
    : '  (list directory unavailable — call klaviyo.list_lists if you need it)';
  return [
    `The user has a pending Klaviyo CSV import in this thread. Filename: ${ctx.filename}. Rows ready to import: ${ctx.rowCount}. Subscription channels chosen at upload: ${ctx.channels.join(', ')}.`,
    '',
    'Interpret the user\'s next message as one of:',
    '  - A list selection (e.g., "Trade Show Leads", "the welcome list", "no list") → call klaviyo.commit_pending_csv_import with that exact list name. Pass "no list" / "none" / "skip" / "sin lista" verbatim — the tool recognizes them and omits list-membership.',
    '  - An instruction that names a list AND asks you to create it if missing (e.g., "lista de prueba, créala si no existe") → call klaviyo.create_list({name}) FIRST, then klaviyo.commit_pending_csv_import({list:name}).',
    '  - A confirmation/decline of a previous question YOU asked (e.g., user replied "yes" after you asked "want me to create it?") → carry out the implied action.',
    '  - An off-topic message → answer normally; do NOT touch the pending import.',
    '',
    'Available Klaviyo lists in this account (id — name):',
    listsBlock,
    '',
    'Hard rules:',
    '  - DO NOT call klaviyo.import_profiles directly. The CSV rows live only in the pending row; only klaviyo.commit_pending_csv_import can access them.',
    '  - DO NOT invent list names. If the user named a list, pass that exact string to commit_pending_csv_import.',
    '  - The cancel verb ("cancel"/"cancelar"/"abort") is handled before you see the message; you will not be invoked for it.',
  ].join('\n');
}
```

3. In `Orchestrator.run`, where the `system` array is built (around line 169), append the pending block when present. Replace:

```ts
const system = [
  { type: 'text' as const, text: systemText, cache_control: { type: 'ephemeral' as const } },
];
```

with:

```ts
const system: any[] = [
  { type: 'text' as const, text: systemText, cache_control: { type: 'ephemeral' as const } },
];
if (input.pendingContext) {
  // No cache_control — pending state varies every turn; caching it would
  // poison the cache for the next conversation.
  system.push({ type: 'text' as const, text: buildPendingCsvSystemNote(input.pendingContext) });
}
```

- [ ] **Step 4: Run the orchestrator tests — expect green**

Run: `npx vitest run tests/unit/orchestrator/orchestrator.test.ts`

Expected: all tests PASS, including the three new ones. Existing tests are unaffected because they don't pass `pendingContext`.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/orchestrator.ts tests/unit/orchestrator/orchestrator.test.ts
git commit -m "$(cat <<'EOF'
feat(orchestrator): inject klaviyo_csv_pending state as non-cached system block

When the slack handler detects a CSV pending row in the user's thread,
it can now pass an OrchestratorPendingCsvContext to orchestrator.run.
The orchestrator appends a second (non-cached) system block describing
the pending state, available Klaviyo lists, and explicit instructions
for the LLM on which existing tools to call. The note is non-cached
because pending state varies every turn.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Wire pending context through the slack handler

**Files:**
- Modify: `src/slack/handlers.ts` — extend `HandlerDeps`, fetch pending+lists, pass to orchestrator
- Modify: `src/index.ts` — pass `klaviyoPendingRepo` + `klaviyoClient` into `createDmHandler`
- Modify: `tests/unit/slack/handlers.test.ts` — add a wiring test

- [ ] **Step 1: Read the existing handlers test to understand the mock pattern**

Run: `head -120 tests/unit/slack/handlers.test.ts` and skim. Note what `HandlerDeps` shape the existing tests build, and whether there's already a way to inject a fake `pendingRepo` or `orchestrator.run` spy.

- [ ] **Step 2: Add a wiring test that proves `pendingContext` is passed to `orchestrator.run`**

Append to `tests/unit/slack/handlers.test.ts` (inside the appropriate `describe`):

```ts
it('passes pendingContext to orchestrator.run when a klaviyo_csv_pending row exists in the thread', async () => {
  const orchestratorRun = vi.fn(async () => ({
    response: 'ok',
    model: 'claude-sonnet-4-6',
    toolCalls: [],
    tokensInput: 0,
    tokensOutput: 0,
    iterations: 1,
    attachments: [],
  }));
  const lookupByThread = vi.fn(async () => ({
    id: 'pid_1',
    callerSlackId: 'U1',
    channelId: 'C1',
    threadTs: 'C1',
    kind: 'klaviyo_csv_pending',
    payload: { profiles: [{ email: 'a@x.com' }, { email: 'b@x.com' }], filename: 'leads.csv', storagePath: null, channels: ['email'] },
  }));
  const listLists = vi.fn(async () => [
    { id: 'L_TRADE', name: 'Trade Show Leads' },
    { id: 'L_PRUEBA', name: 'lista de prueba' },
  ]);
  const tryHandle = vi.fn(async () => false); // not a cancel, defer to orchestrator

  const handler = createDmHandler({
    orchestrator: { run: orchestratorRun } as any,
    usersRepo: { isAuthorized: async () => true } as any,
    conversationsRepo: { loadRecentByThread: async () => [] } as any,
    confirmationHandler: { tryHandle } as any,
    pendingRepo: { lookupByThread } as any,
    klaviyoClient: { listLists } as any,
  });

  const fakeClient = {
    chat: {
      postMessage: vi.fn(async () => ({ ts: '1.000' })),
      update: vi.fn(async () => ({})),
    },
  };
  await handler({
    event: { channel_type: 'im', user: 'U1', channel: 'C1', text: 'lista de prueba', ts: '1.000' },
    client: fakeClient,
  });

  expect(orchestratorRun).toHaveBeenCalled();
  const runArgs = orchestratorRun.mock.calls[0][0] as any;
  expect(runArgs.pendingContext).toMatchObject({
    kind: 'klaviyo_csv_pending',
    filename: 'leads.csv',
    rowCount: 2,
    channels: ['email'],
    availableLists: expect.arrayContaining([
      expect.objectContaining({ id: 'L_PRUEBA', name: 'lista de prueba' }),
    ]),
  });
});

it('omits pendingContext when no pending row exists', async () => {
  const orchestratorRun = vi.fn(async () => ({
    response: 'ok', model: 'claude-sonnet-4-6', toolCalls: [],
    tokensInput: 0, tokensOutput: 0, iterations: 1, attachments: [],
  }));
  const handler = createDmHandler({
    orchestrator: { run: orchestratorRun } as any,
    usersRepo: { isAuthorized: async () => true } as any,
    conversationsRepo: { loadRecentByThread: async () => [] } as any,
    confirmationHandler: { tryHandle: async () => false } as any,
    pendingRepo: { lookupByThread: async () => null } as any,
    klaviyoClient: { listLists: vi.fn() } as any,
  });
  const fakeClient = {
    chat: { postMessage: vi.fn(async () => ({ ts: '1.000' })), update: vi.fn(async () => ({})) },
  };
  await handler({ event: { channel_type: 'im', user: 'U1', channel: 'C1', text: 'hi', ts: '1.000' }, client: fakeClient });
  const runArgs = orchestratorRun.mock.calls[0][0] as any;
  expect(runArgs.pendingContext).toBeUndefined();
});

it('falls back to empty availableLists when klaviyoClient.listLists() throws', async () => {
  const orchestratorRun = vi.fn(async () => ({
    response: 'ok', model: 'claude-sonnet-4-6', toolCalls: [],
    tokensInput: 0, tokensOutput: 0, iterations: 1, attachments: [],
  }));
  const lookupByThread = vi.fn(async () => ({
    id: 'pid_1', callerSlackId: 'U1', channelId: 'C1', threadTs: 'C1',
    kind: 'klaviyo_csv_pending',
    payload: { profiles: [{ email: 'a@x.com' }], filename: 'leads.csv', storagePath: null, channels: ['email'] },
  }));
  const listLists = vi.fn(async () => { throw new Error('Klaviyo down'); });
  const handler = createDmHandler({
    orchestrator: { run: orchestratorRun } as any,
    usersRepo: { isAuthorized: async () => true } as any,
    conversationsRepo: { loadRecentByThread: async () => [] } as any,
    confirmationHandler: { tryHandle: async () => false } as any,
    pendingRepo: { lookupByThread } as any,
    klaviyoClient: { listLists } as any,
  });
  const fakeClient = {
    chat: { postMessage: vi.fn(async () => ({ ts: '1.000' })), update: vi.fn(async () => ({})) },
  };
  await handler({ event: { channel_type: 'im', user: 'U1', channel: 'C1', text: 'lista de prueba', ts: '1.000' }, client: fakeClient });
  const runArgs = orchestratorRun.mock.calls[0][0] as any;
  expect(runArgs.pendingContext.availableLists).toEqual([]);
});
```

Note: the existing `createDmHandler` test fixture may not currently inject `pendingRepo` / `klaviyoClient`. Update the existing tests' `HandlerDeps` mock to include those two as `null`-tolerant (e.g. `pendingRepo: { lookupByThread: async () => null }, klaviyoClient: { listLists: async () => [] }`) so the test setup remains compatible after the type change.

- [ ] **Step 3: Run tests — expect failures**

Run: `npx vitest run tests/unit/slack/handlers.test.ts`

Expected: the three new tests FAIL because `HandlerDeps` doesn't yet have `pendingRepo` or `klaviyoClient`, and the handler doesn't yet build `pendingContext`. The existing tests may also fail due to missing required deps once we tighten the type.

- [ ] **Step 4: Extend `HandlerDeps` and the handler logic**

In `src/slack/handlers.ts`:

1. Add imports near the top (alongside existing connector type imports):

```ts
import type { PendingConfirmationsRepo } from '../storage/repositories/pending-confirmations.js';
import type { KlaviyoApiClient } from '../connectors/klaviyo/client.js';
import type { OrchestratorPendingCsvContext } from '../orchestrator/orchestrator.js';
```

2. Extend `HandlerDeps`:

```ts
export interface HandlerDeps {
  orchestrator: Orchestrator;
  usersRepo: AuthorizedUsersRepo;
  conversationsRepo: ConversationsRepo;
  confirmationHandler: ConfirmationHandler;
  /** Used to detect klaviyo_csv_pending rows after `confirmationHandler.tryHandle`
   *  returned false, so we can build OrchestratorPendingCsvContext for the LLM. */
  pendingRepo: Pick<PendingConfirmationsRepo, 'lookupByThread'>;
  /** Used to fetch the Klaviyo list directory once when assembling
   *  pendingContext. Optional: if the call fails, the handler proceeds with
   *  availableLists=[] and lets the LLM call klaviyo.list_lists itself. */
  klaviyoClient: Pick<KlaviyoApiClient, 'listLists'>;
}
```

3. After the `if (consumed) return;` line (around line 139), and BEFORE the `if (!(await deps.usersRepo.isAuthorized(...)))` line, insert:

```ts
let pendingContext: OrchestratorPendingCsvContext | undefined;
{
  const pending = await deps.pendingRepo.lookupByThread(event.user, event.channel, pendingThreadKey);
  if (pending && pending.kind === 'klaviyo_csv_pending' && pending.callerSlackId === event.user) {
    const payload = pending.payload as { profiles: Array<unknown>; filename: string; channels?: string[] };
    let availableLists: Array<{ id: string; name: string }> = [];
    try {
      const lists = await deps.klaviyoClient.listLists();
      availableLists = lists.map((l) => ({ id: l.id, name: l.name }));
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'klaviyo_listLists_failed_for_pending_context',
      );
    }
    pendingContext = {
      kind: 'klaviyo_csv_pending',
      filename: payload.filename,
      rowCount: payload.profiles.length,
      channels: ((payload.channels as ('email' | 'sms')[] | undefined) ?? ['email']),
      availableLists,
    };
  }
}
```

4. In the `await deps.orchestrator.run({ ... })` call (around line 259), add the new field:

```ts
const out = await deps.orchestrator.run({
  question: event.text,
  threadHistory,
  actor: { slackUserId: event.user, slackChannelId: event.channel },
  thread: { channelId: event.channel, threadTs },
  onToolCall,
  onToolFinish,
  pendingContext,
});
```

- [ ] **Step 5: Update `src/index.ts` to pass the new deps**

In `src/index.ts`, find the `createDmHandler({ ... })` call (around line 360-380) and add the two fields:

```ts
createDmHandler({
  orchestrator,
  usersRepo: ...,
  conversationsRepo: ...,
  confirmationHandler: klaviyoConfirmationHandler ?? noopConfirmationHandler,
  pendingRepo: klaviyoPendingRepo,
  klaviyoClient,
})
```

If `klaviyoClient` and `klaviyoPendingRepo` are conditionally created (they're inside a conditional block in current code), make sure the wiring still compiles when Klaviyo is disabled. A safe fallback for the disabled case:

```ts
pendingRepo: klaviyoPendingRepo ?? { lookupByThread: async () => null },
klaviyoClient: klaviyoClient ?? { listLists: async () => [] },
```

- [ ] **Step 6: Run tests — expect green**

Run: `npx vitest run tests/unit/slack/handlers.test.ts`

Expected: all tests PASS, including the three new ones.

- [ ] **Step 7: Run the full unit suite to catch type/wiring regressions**

Run: `npx vitest run`

Expected: every test passes. If TypeScript compile errors surface, address them (most likely: tests that previously built `HandlerDeps` without `pendingRepo`/`klaviyoClient` need null-tolerant mocks).

- [ ] **Step 8: Commit**

```bash
git add src/slack/handlers.ts src/index.ts tests/unit/slack/handlers.test.ts
git commit -m "$(cat <<'EOF'
feat(slack): build OrchestratorPendingCsvContext for csv-pending replies

After ConfirmationHandler.tryHandle returns false on a klaviyo_csv_pending
thread, the slack handler re-fetches the pending row, fetches the Klaviyo
list directory (best-effort), and passes pendingContext to orchestrator.run.
listLists failures degrade gracefully to availableLists=[].

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Layer-2 integration tests — LLM-mocked CSV-pending routing

**Files:**
- Create: `tests/unit/orchestrator/csv-pending-routing.test.ts`

These tests use a mocked Anthropic client (same pattern as `orchestrator.test.ts:fakeClaude`) to script LLM responses and assert what tool calls happen end-to-end. They're the regression net for the spec's user-visible behavior table.

- [ ] **Step 1: Skim `orchestrator.test.ts` to copy the fakeClaude + buildRegistry patterns**

Run: `head -110 tests/unit/orchestrator/orchestrator.test.ts`

Note: tool names use `.` internally but Anthropic wire format uses `_`, so `klaviyo.commit_pending_csv_import` becomes `klaviyo_commit_pending_csv_import` in `tool_use.name`. The orchestrator translates back via `nameMap`.

- [ ] **Step 2: Create the new test file with all 7 scenarios**

Create `tests/unit/orchestrator/csv-pending-routing.test.ts` with this content:

```ts
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { Orchestrator } from '../../../src/orchestrator/orchestrator.js';
import { ConnectorRegistry } from '../../../src/connectors/base/registry.js';
import type { Connector, ToolDef } from '../../../src/connectors/base/connector.js';

/**
 * Builds a registry pre-loaded with stub klaviyo tools that return canned
 * responses. The stubs let us assert the LLM's tool-call sequence without
 * touching real Klaviyo. Each test passes overrides for the tools whose
 * response shape it wants to control.
 */
function buildKlaviyoRegistry(overrides: {
  commitImport?: (args: any) => any;
  createList?: (args: any) => any;
  listLists?: () => any;
} = {}) {
  const commitImport: ToolDef = {
    name: 'klaviyo.commit_pending_csv_import',
    description: 'commit',
    schema: z.object({ list: z.string() }).passthrough(),
    jsonSchema: { type: 'object' },
    execute: vi.fn(async (args) =>
      overrides.commitImport
        ? overrides.commitImport(args)
        : { kind: 'imported_directly', total_imported: 5, list: { id: 'L1', name: (args as any).list }, message: `Submitted 5 profiles to Klaviyo (list: ${(args as any).list}).` },
    ),
  };
  const createList: ToolDef = {
    name: 'klaviyo.create_list',
    description: 'create',
    schema: z.object({ name: z.string() }).passthrough(),
    jsonSchema: { type: 'object' },
    execute: vi.fn(async (args) =>
      overrides.createList
        ? overrides.createList(args)
        : { ok: true, id: 'L_NEW', name: (args as any).name, message: `Created Klaviyo list "${(args as any).name}".` },
    ),
  };
  const listListsTool: ToolDef = {
    name: 'klaviyo.list_lists',
    description: 'list',
    schema: z.object({}).passthrough(),
    jsonSchema: { type: 'object' },
    execute: vi.fn(async () =>
      overrides.listLists ? overrides.listLists() : { count: 0, lists: [] },
    ),
  };
  const conn: Connector = {
    name: 'klaviyo',
    tools: [commitImport, createList, listListsTool],
    async healthCheck() { return { ok: true }; },
  };
  const r = new ConnectorRegistry();
  r.register(conn);
  return { registry: r, commitImport, createList, listListsTool };
}

function fakeClaude(responses: any[]) {
  let i = 0;
  return {
    messages: {
      create: vi.fn(async () => {
        if (i >= responses.length) throw new Error(`fakeClaude exhausted at call ${i + 1}`);
        return responses[i++];
      }),
    },
  };
}

const PENDING_CTX = {
  kind: 'klaviyo_csv_pending' as const,
  filename: 'leads.csv',
  rowCount: 5,
  channels: ['email'] as ('email' | 'sms')[],
  availableLists: [
    { id: 'L_TRADE', name: 'Trade Show Leads' },
    { id: 'L_PRUEBA', name: 'lista de prueba' },
    { id: 'L_PRUEBA2', name: 'prueba' },
    { id: 'L_BDNY', name: 'BDNY 2026' },
  ],
};

const STD_USAGE = { input_tokens: 100, output_tokens: 20 };

describe('csv-pending reply routing — orchestrator + LLM mock', () => {
  it('1. bare list name, list exists → single commit_pending_csv_import call', async () => {
    const { registry, commitImport } = buildKlaviyoRegistry();
    const claude: any = fakeClaude([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'klaviyo_commit_pending_csv_import', input: { list: 'lista de prueba' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: 'Submitted 5 profiles to Klaviyo (list: lista de prueba).' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({ question: 'lista de prueba', threadHistory: [], pendingContext: PENDING_CTX });
    expect(out.toolCalls.map((c) => c.name)).toEqual(['klaviyo.commit_pending_csv_import']);
    expect((commitImport.execute as any).mock.calls[0][0]).toEqual({ list: 'lista de prueba' });
    expect(out.response).toMatch(/Submitted/);
  });

  it('2. compound intent (name + create-if-missing) → create_list THEN commit', async () => {
    const { registry, createList, commitImport } = buildKlaviyoRegistry();
    const claude: any = fakeClaude([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'klaviyo_create_list', input: { name: 'lista nueva' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'tool_use', id: 't2', name: 'klaviyo_commit_pending_csv_import', input: { list: 'lista nueva' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: 'Created list "lista nueva". Submitted 5 profiles.' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({
      question: 'I want to save them to lista nueva, crea la lista si no existe',
      threadHistory: [],
      pendingContext: PENDING_CTX,
    });
    expect(out.toolCalls.map((c) => c.name)).toEqual([
      'klaviyo.create_list',
      'klaviyo.commit_pending_csv_import',
    ]);
    expect((createList.execute as any).mock.calls[0][0]).toEqual({ name: 'lista nueva' });
    expect((commitImport.execute as any).mock.calls[0][0]).toEqual({ list: 'lista nueva' });
  });

  it('3. "no list" → commit with that exact string (connector handles skip token)', async () => {
    const { registry, commitImport } = buildKlaviyoRegistry({
      commitImport: () => ({ kind: 'imported_directly', total_imported: 5, list: null, message: 'Submitted 5 profiles to Klaviyo. They typically appear within ~1 minute.' }),
    });
    const claude: any = fakeClaude([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'klaviyo_commit_pending_csv_import', input: { list: 'no list' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: 'Submitted 5 profiles to Klaviyo. They typically appear within ~1 minute.' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({ question: 'no list', threadHistory: [], pendingContext: PENDING_CTX });
    expect((commitImport.execute as any).mock.calls[0][0]).toEqual({ list: 'no list' });
    expect(out.response).toMatch(/Submitted/);
  });

  it('4. short ambiguous "prueba" → treated as list-selection (not help request)', async () => {
    const { registry, commitImport } = buildKlaviyoRegistry();
    const claude: any = fakeClaude([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'klaviyo_commit_pending_csv_import', input: { list: 'prueba' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: 'Submitted 5 profiles to Klaviyo (list: prueba).' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({ question: 'prueba', threadHistory: [], pendingContext: PENDING_CTX });
    expect(out.toolCalls.map((c) => c.name)).toEqual(['klaviyo.commit_pending_csv_import']);
    expect((commitImport.execute as any).mock.calls[0][0]).toEqual({ list: 'prueba' });
  });

  it('5. off-topic mid-flow ("how many rows did you say?") → text reply, no tool calls', async () => {
    const { registry, commitImport } = buildKlaviyoRegistry();
    const claude: any = fakeClaude([
      {
        content: [{ type: 'text', text: 'It was 5 rows from leads.csv. Reply with a list name when ready.' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({ question: 'how many rows did you say?', threadHistory: [], pendingContext: PENDING_CTX });
    expect(out.toolCalls).toEqual([]);
    expect((commitImport.execute as any)).not.toHaveBeenCalled();
    expect(out.response).toMatch(/5 rows/);
  });

  it('6. bare list name, list missing → commit returns LIST_NOT_FOUND → LLM asks user (no second tool call)', async () => {
    const { registry, commitImport, createList } = buildKlaviyoRegistry({
      commitImport: () => ({ error: { code: 'LIST_NOT_FOUND', message: 'No list matched "lista nueva"', details: { suggestions: [], normalizedName: 'lista nueva' } } }),
    });
    const claude: any = fakeClaude([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'klaviyo_commit_pending_csv_import', input: { list: 'lista nueva' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: 'There\'s no list called "lista nueva". Want me to create it? Reply yes to create, or pick a different list name.' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({ question: 'lista nueva', threadHistory: [], pendingContext: PENDING_CTX });
    expect(out.toolCalls.map((c) => c.name)).toEqual(['klaviyo.commit_pending_csv_import']);
    expect((createList.execute as any)).not.toHaveBeenCalled();
    expect(out.response).toMatch(/Want me to create/i);
    expect((commitImport.execute as any)).toHaveBeenCalledTimes(1);
  });

  it('7. multi-list ambiguity ("add to A and B") → LLM asks user, no commit', async () => {
    const { registry, commitImport } = buildKlaviyoRegistry();
    const claude: any = fakeClaude([
      {
        content: [{ type: 'text', text: 'I can only import to one list at a time. Pick "Trade Show Leads" or "BDNY 2026"?' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({
      question: 'add them to Trade Show Leads and BDNY 2026',
      threadHistory: [],
      pendingContext: PENDING_CTX,
    });
    expect(out.toolCalls).toEqual([]);
    expect((commitImport.execute as any)).not.toHaveBeenCalled();
    expect(out.response).toMatch(/one list at a time/i);
  });
});
```

- [ ] **Step 3: Run the new test file**

Run: `npx vitest run tests/unit/orchestrator/csv-pending-routing.test.ts`

Expected: all 7 PASS. The mocked Anthropic client controls the LLM's tool-call sequence; the test asserts the orchestrator dispatches each tool with the expected arguments and produces the expected final text.

If a test fails, common causes:
- Tool name mismatch — Anthropic wire format uses `_`, not `.`. Check: `klaviyo_commit_pending_csv_import`, not `klaviyo.commit_pending_csv_import` in the `tool_use.name` field.
- The orchestrator's `nameMap` translation requires the `.` form to be REGISTERED first. Verify `buildKlaviyoRegistry` registers tools with the `.` name.
- Iteration cap — the orchestrator's `maxIterations: 5` is enough for the longest scenario (test 2: 3 iterations).

- [ ] **Step 4: Commit**

```bash
git add tests/unit/orchestrator/csv-pending-routing.test.ts
git commit -m "$(cat <<'EOF'
test(orchestrator): csv-pending routing — 7 LLM-mocked scenarios

Covers the spec's user-visible behavior table: bare list name (existing
+ missing), compound intent (create + commit), "no list" skip token,
short ambiguous token, off-topic mid-flow, multi-list ambiguity. Each
scenario scripts the LLM's tool_use sequence and asserts which tools
the orchestrator dispatched with what args.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Tighten the prompts.ts bullet for `commit_pending_csv_import`

**Files:**
- Modify: `src/orchestrator/prompts.ts:142` (the `klaviyo.commit_pending_csv_import` bullet)

The current bullet is written for the deterministic-handler era ("when the user replies with a list name … call `klaviyo.commit_pending_csv_import`"). Now that the orchestrator gets a dedicated pending-CSV system note, the base prompt's bullet can be terser and shouldn't conflict with the per-turn note.

- [ ] **Step 1: Update the bullet text**

Open `src/orchestrator/prompts.ts`. Find the bullet starting `• **\`klaviyo.commit_pending_csv_import\`**` (around line 142). Replace its body with:

```
• **`klaviyo.commit_pending_csv_import`** — finalize a CSV upload that's waiting for a list selection. ADMIN/MARKETING only. When a klaviyo_csv_pending state is active in the thread, you'll receive a separate system note describing the pending file + available lists; follow that note's instructions for which list to pass. Pass "no list" / "none" / "skip" / "sin lista" verbatim to import without list-membership. The cached profiles live ONLY in the pending row — do NOT call `klaviyo.import_profiles` directly for CSV-origin work.
```

- [ ] **Step 2: Run prompts test**

Run: `npx vitest run tests/unit/orchestrator/prompts.test.ts`

Expected: PASS. If a snapshot or substring assertion in `prompts.test.ts` matched specific old wording (e.g. "pending import token", "Got 5 rows from"), update the test assertion to match the new bullet (or, if the test is checking the bullet's *presence*, no change needed).

- [ ] **Step 3: Commit**

```bash
git add src/orchestrator/prompts.ts tests/unit/orchestrator/prompts.test.ts
git commit -m "$(cat <<'EOF'
docs(prompts): tighten commit_pending_csv_import bullet

The base prompt no longer needs to spell out the full csv-pending flow
because a per-turn system note now describes the active pending state
and the LLM's options. Bullet keeps the role gate, the skip token list,
and the do-not-call-import_profiles guardrail.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Final regression sweep + smoke run

- [ ] **Step 1: Run the full unit suite**

Run: `npx vitest run`

Expected: 100% green. Pay attention to any test that imports from `src/orchestrator/confirmation-handler.ts` or `src/connectors/klaviyo/connector.ts` — those are the files most likely to surface a stale assertion.

If a test fails for a reason unrelated to this change (flake), retry once. If it still fails, treat as a regression and fix.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`

Expected: zero errors. Most likely surface for issues: the new `OrchestratorPendingCsvContext` import in `slack/handlers.ts`, or stale code in `index.ts` referencing `runTool`.

- [ ] **Step 3: Verify manual smoke checklist (read-only verification)**

Read: `tests/integration/smoke.md`. Cross-check whether any documented smoke step references the old reply-routing behavior. If so, append the new pre-deploy checklist from the spec's "E2E smoke checklist" section to `smoke.md` so the deploy gate is current.

- [ ] **Step 4: Commit any smoke.md updates (if they exist)**

```bash
# Only if smoke.md was modified:
git add tests/integration/smoke.md
git commit -m "$(cat <<'EOF'
docs(smoke): add csv-pending reply routing pre-deploy checklist

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Print the summary log line set so we know what to grep for in production**

After deploy, expect to see in production logs:
- `klaviyo_csv_cancelled` — the deterministic cancel fast-path fired
- `klaviyo_csv_routed_to_orchestrator` — the new path fired (LLM took over)
- `klaviyo_listLists_failed_for_pending_context` — list directory fetch failed (degraded path)
- `klaviyo_import_submitted` — import succeeded (existing log, unchanged)

These are the four signals that prove the new architecture is exercising correctly.

---

## Self-Review Checklist (run before handoff)

- [x] **Spec coverage:**
  - Cancel fast-path → Task 2
  - Drop stripPrefixes → Task 1
  - OrchestratorPendingCsvContext type + system note → Task 3
  - Slack handler wires pendingContext → Task 4
  - Layer 1 unit tests (handler + connector) → Tasks 1, 2
  - Layer 2 LLM-mocked integration tests (7 scenarios) → Task 5
  - Layer 3 manual E2E smoke → Task 7 (smoke.md update)
  - Prompt bullet tightened → Task 6
  - `klaviyo_csv_routed_to_orchestrator` log → Task 2
  - Tolerate old payloads with `awaitingCreateForName` → not written anymore; reads were already null-tolerant via `?? null`

- [x] **No placeholders:** every step shows the exact code or command. No "implement validation here" or "similar to above".

- [x] **Type consistency:** `OrchestratorPendingCsvContext` is defined in Task 3 and reused by name in Task 4 (slack handler). `pendingContext` field name is consistent across handler, orchestrator, and tests.

- [x] **Decomposition:** seven tasks, each producing a green-tested commit. Order respects dependencies (connector cleanup → handler simplification → orchestrator extension → slack wiring → integration tests → prompt → sweep).
