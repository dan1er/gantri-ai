# Merge Customer Accounts — Design

**Status:** approved 2026-05-11

## Goal

Let CX resolve duplicate-account scenarios from Slack without filing an engineering ticket. Typical case (real, 2026-05-11): a customer signs up with a typo in their email (`h.h.bnguyen2001@gmail.comb`), places an order, then signs up again with the correct email (`h.bnguyen2001@gmail.com`). CX needs to re-associate the order with the correct account and retire the typo account.

Today: the bot has no tool for this, so the request gets flagged to Danny (commit `165c5ea`). Tomorrow: the bot offers a two-step confirm tool that finishes the job.

## Architecture

```
Slack DM (CX) → bot.orchestrator → gantri.merge_customer_accounts
                                          │
                       resolve oldEmail / newEmail
                                          │
                              preview ──→ Slack (yes/no)
                                          │
                                          ▼
                  POST <porter>/api/admin/users/merge
                                          │
                  ┌───────────────────────┴──────────────────────┐
                  │ Inside one Sequelize transaction:            │
                  │   1. Load both users                         │
                  │   2. UPDATE Transactions.userId old → new    │
                  │   3. Copy firstName/lastName if new is empty │
                  │   4. Soft-delete old (deletedAt = NOW)       │
                  │   5. Return summary { ordersMoved, ... }     │
                  └──────────────────────────────────────────────┘
                                          │
                                          ▼
                            audit row in gantri_writes
                                          │
                                          ▼
                              reply to CX in Slack
```

Two repos:
- **Porter** — new admin endpoint `POST /api/admin/users/merge`. Does the actual DB work atomically. Owns FK consistency and Sequelize hooks.
- **gantri-ai-bot** — new tool `gantri.merge_customer_accounts`. Owns the two-step confirm gate, role check, target switching (staging vs prod), and audit. Calls the Porter endpoint.

## Scope (v1)

**In scope:**
- Re-associate `Transactions` rows. This covers orders, refunds, replacements, etc. — every row keyed by `userId` in the Transactions table.
- Copy `firstName` / `lastName` from old to new if new is empty. Email of the new account is never touched (the customer chose it).
- Soft-delete the old account (`deletedAt = NOW()`). Login with that email is blocked by existing app logic.
- Two-step confirm gate (preview → "yes" → execute).
- Audit row in `gantri_writes` capturing caller, both user ids/emails, order count moved, target (staging vs prod).
- CX or ADMIN role required (same as `gantri.update_customer_email`).

**Out of scope (v1.x followups):**
- Other `userId`-keyed tables: `Addresses`, `Payments`, `StripeSubscriptions`, `Reviews`, `Wishlists`, `Cart`. Rare cases, separate FLC if/when they come up.
- Klaviyo profile merging. If both accounts have linked `klaviyoId`, the tool surfaces a warning in the preview ("two Klaviyo profiles linked, manual reconciliation needed") and the change proceeds anyway. The Klaviyo merge stays a manual step in v1.
- Session token invalidation for the old account. Existing app logic on `deletedAt` should block re-login, but no proactive token revocation.

## API contract — Porter endpoint

**`POST /api/admin/users/merge`**

Permissions: `ADMIN` only on Porter side (the bot's CX-role gate is bot-level; Porter only authenticates the bot).

Request body:
```json
{ "oldEmail": "h.h.bnguyen2001@gmail.comb", "newEmail": "h.bnguyen2001@gmail.com" }
```

Response (200):
```json
{
  "success": true,
  "oldUserId": 65687,
  "newUserId": 65689,
  "ordersMoved": 1,
  "profileCopied": { "firstName": "Han", "lastName": "Nguyen" },
  "oldAccountSoftDeleted": true,
  "klaviyoIds": { "old": null, "new": null }
}
```

Errors:
- `400` `OLD_EMAIL_REQUIRED` / `NEW_EMAIL_REQUIRED` / `EMAILS_IDENTICAL`
- `404` `OLD_USER_NOT_FOUND` / `NEW_USER_NOT_FOUND`
- `422` `OLD_ALREADY_SOFT_DELETED` (idempotency guard — calling twice on the same pair is a no-op error)

Atomicity: everything in one Sequelize transaction (`useRollback: true` middleware). Any failure rolls back; no partial states.

## Tool contract — bot

**`gantri.merge_customer_accounts`**

Args (Zod schema):
```ts
{
  oldEmail: z.string().email(),
  newEmail: z.string().email(),
  confirm: z.boolean().default(false),
}
```

Behavior:
- `confirm: false` (default) → fetch both users via `/api/admin/users/by-email`, compute orders count for old, return `{ kind: 'awaiting_confirmation', message: "<prefixed preview>", oldUserId, newUserId, oldEmail, newEmail, ordersToMove, klaviyoConflict, target }`.
- `confirm: true` → call `POST /api/admin/users/merge` on Porter, write `gantri_writes` audit row, return `{ ok: true, ordersMoved, ... }`.
- Both branches gate on CX/ADMIN role + same `PORTER_WRITE_TARGET` prefix as `update_customer_email` (`(staging mode)` / `(PROD MODE)`).

Trigger phrases (added to the prompt): "merge accounts", "duplicate account", "she has two accounts", "fusionar cuentas", "cuentas duplicadas", "move order X from email A to email B", etc.

## Edge cases

- **Both emails resolve to same user** → `400 EMAILS_IDENTICAL`. Bot says "Those are the same account."
- **Old has zero orders** → still merge (copy profile + soft-delete). Audit `ordersMoved: 0`.
- **Both accounts have orders** → merge appends old's orders to new. New's existing orders are untouched.
- **Old user already soft-deleted** → `422 OLD_ALREADY_SOFT_DELETED`. Bot says "Looks like that account was already merged/retired."
- **Klaviyo: both have klaviyoId** → preview message includes a warning line, change proceeds, audit captures both klaviyoIds for manual reconciliation later.
- **Race: order created on old user between preview and confirm** → not a correctness issue (the second-stage transaction re-reads orders and moves whatever's there). Audit captures the actual count moved, not the previewed count.

## Testing strategy

**Porter:**
- Mocha integration tests in `routes/user/user.test.ts` (or new file). Cover: happy path, both-have-orders, old-no-orders, same-email, missing-old, missing-new, already-soft-deleted, transactional rollback on simulated failure mid-merge.
- Test against staging-equivalent test DB (existing harness).

**Bot:**
- Vitest unit tests in `tests/unit/connectors/gantri-porter/merge-customer-accounts-tool.test.ts`. Cover: same matrix as Porter from the tool's perspective + role check + target prefix.
- Routing test in `tests/unit/orchestrator/`. Cover: trigger phrases route to this tool, NOT to `update_customer_email`.
- Real-API smoke against staging before deploy (mandatory per project rules — "Real-API smoke required for external APIs"). Smoke creates a throwaway pair of duplicate accounts, merges them, verifies via `/api/admin/users/by-email`.

**Forbidden:** writing against production. All testing must use `stage.api.gantri.com`. Reinforced 2026-05-11.

## Risks

1. **Porter migration not needed** — the change is purely runtime (no schema change). The endpoint reads and writes existing tables. Low risk of bad migration.
2. **Sequelize hooks on User.update** — soft-deleting (`deletedAt`) may trigger Klaviyo sync hooks. We accept that; if it misbehaves, fix in followup.
3. **Bot dispatching the wrong tool** — the bot today has `update_customer_email`; the routing test must explicitly exercise "merge accounts" phrasing to ensure it doesn't go to `update_customer_email`.
4. **Audit row schema** — `gantri_writes` is generic enough (`action`, `requestPayload`, `responsePayload`). New action value: `'merge_customer_accounts'`. No schema migration needed.

## Followup work (not v1)

- **v1.1:** extend to `Addresses`, `Payments` if cases come up.
- **v1.2:** Klaviyo profile merge tool (separate from this).
- **v2:** UNDO operation (`gantri.unmerge_customer_accounts` reversing a recent merge by audit-row id). Probably never needed, but the audit row is there if we want it.
