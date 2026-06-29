# Design: `/review-flc` Slack Command (v1)

> Spec for the `/review-flc` bot feature. Adapted from the source FLC at
> `features/flc-review-flc-slack-command.md` (the full functional + technical
> spec). This is the connector-process Phase A spec.

## Goal

Let any Slack workspace member, from any conversation/DM, point the bot at an
FLC's Notion link and get back a structured review graded against Gantri's
canonical FLC review standard. The member selects which areas to review, sees
findings grouped by severity, and can post any subset of findings back onto the
FLC as comments — under the bot identity. The bot never edits FLC content.

## Non-goals (v1)

- Editing / rewriting FLC content (review-only; the only write is comments).
- A "copy fix-prompt for your AI" action (deferred — FLC exclusion E2).
- A separate `/fix-flc` command.
- Persisting reviews to a DB (in-memory only; see Phase B skip below).
- Live Reports integration, orchestrator LLM-tool registration (see F/G skips).
- Text-range / inline comment anchoring (the public Notion API does not support
  it — block-level is the finest granularity available).

## Definitions

- **Area**: one of Functional, Technical, Testing, Operational, Security.
- **Finding**: `{ id, severity, area, section, anchor, message }`. Severity is
  one of Must Fix / Should Fix / Suggestion.
- **Anchor**: a short snippet copied verbatim from the FLC, used to locate the
  Notion **block** a comment attaches to.
- **Review standard**: the canonical checklist, duplicated into the repo at
  `src/prompts/flc-review-standard.md` and loaded as the LLM system prompt.

## Architecture

```
/review-flc (slash) ──▶ ack ──▶ open modal (URL + 5 area checkboxes, all preset)
        modal submit ──▶ validate (URL parseable, ≥1 area) ──▶ ack
                     ──▶ post "🔍 reviewing…" in the invoking channel
                     ──▶ Notion.getPageMarkdown(pageId)         [read]
                     ──▶ reviewFlc(markdown, areas) via resilient Claude  [LLM]
                     ──▶ edit message: findings grouped by severity,
                          one Block Kit checkbox per finding + a post button
   "Post selected"  ──▶ for each checked finding:
                          anchor→block ? createBlockComment : createPageComment
                     ──▶ edit message summarizing posted / page-fallback / failed
```

Components (all net-new unless noted):

- `src/connectors/notion/client.ts` — `NotionApiClient` over `@notionhq/client`
  with injectable `fetch`. `resolvePageId`, `getPageMarkdown` (recursive,
  paginated; returns markdown **and** `{ blockId, text }[]` anchors),
  `createPageComment`, `createBlockComment`. Typed `NotionApiError(message,
  status, body)`.
- `src/flc/flc-review-service.ts` — builds the messages (system = review
  standard + JSON-only contract scoped to selected areas; user = page markdown),
  calls `callClaudeWithResilience`, validates with a zod schema, retries the
  parse once. `loadReviewStandard()` resolves the prompt relative to the
  compiled module (works in `tsx` dev and `node dist` prod).
- `src/slack/review-flc/review-flc-command.ts` — `registerReviewFlcCommand(app,
  deps)`. Slash → modal → submit → review → render; `app.action` posts comments.
  In-memory `Map` keyed by message `ts`, capped at 100 entries.
- Wire-up in `src/index.ts` — reads `NOTION_API_TOKEN` (env or vault), builds the
  client + loads the standard only when the token exists (else `logger.warn` and
  skip), registers in `buildSlackApp(...).registerExtra`. No `decideCommandChannel`
  gating (usable anywhere).

## Data flow

FLC body is read per request, fed to the LLM, and discarded (only the findings +
anchor block list are held in memory, keyed by the result message `ts`, until the
process restarts or the cap evicts them). Comments persist in Notion until a
human deletes them.

## Error handling

| Failure | Behavior |
|---------|----------|
| Invalid / unparseable URL | Modal validation error; no review runs. |
| Zero areas selected | Modal validation error. |
| Page not shared / not found (Notion 401/403/404) | Friendly access error; nothing posted. |
| Review engine exhausted (`AnthropicCapacityExhausted`) | Friendly error + retry hint; nothing posted. |
| Malformed model JSON after one retry (`FlcReviewParseError`) | Generic failure; nothing rendered. |
| Comment anchor not matched | Post at page level and report it; never silently drop. |
| Comment create throws | Report the finding as failed in the result message. |

## Testing strategy

- Notion client: URL→pageId parsing (slug/bare/dashed/`/p/`/invalid), block
  pagination + recursion + markdown/anchor extraction, table_row cells,
  page/block comment bodies, 404→`NotionApiError` mapping. `fetchImpl` stubbed.
- Review service: valid JSON, fenced JSON, area-filtering reflected in the
  prompt, malformed→one retry→success, malformed twice→`FlcReviewParseError`.
- Command: modal shape, submission parsing, selected-id collection, anchor
  matching, findings rendering, modal validation (missing URL / zero areas),
  full submit→review→render, post-selected (block + page fallback), expired state.

## Risks

- **Block-comment API behavior is version-sensitive.** `@notionhq/client` v5
  types accept `parent.block_id`; this must be confirmed with the live smoke
  test (`scripts/smoke-notion*.{sh,mjs}`) once a real token exists.
- **Anchor matching is heuristic.** Page-level fallback + an explicit
  "couldn't anchor" note in the result keep it honest.
- **Prompt injection from FLC content.** The system prompt instructs the model to
  treat the FLC strictly as data under review.
