# Merge Customer Accounts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan task-by-task.

**Goal:** Ship the `gantri.merge_customer_accounts` tool (preview → confirm → soft-delete old + move orders), including the Porter admin endpoint it depends on.

**Architecture:** Two-phase rollout — Porter PR first (adds `POST /api/admin/users/merge`), bot PR second (adds the tool that calls it). The bot can be developed in parallel against a mocked endpoint, but must wait for the Porter PR to merge before any real-API smoke or deploy.

**Tech Stack:** TypeScript (Node 20), Sequelize (Porter), Zod + Vitest (bot), Mocha (Porter), Anthropic SDK, Slack Bolt, Supabase.

**Predecessor:** Design doc → `docs/superpowers/specs/2026-05-11-merge-customer-accounts-design.md`.

**Confirmed decisions (2026-05-11):**
1. v1 scope: only `Transactions.userId` migrated (no other FKs).
2. Mechanism: new Porter admin endpoint, NOT direct SQL from the bot.
3. Old account: soft-delete via `deletedAt = NOW()`.
4. Klaviyo: out of scope for v1 (warning in preview only).

**Constraints:**
- **Testing must use staging only.** No prod writes during dev/test. Use `stage.api.gantri.com`. Reinforced by Danny on 2026-05-11.
- All source code (comments, log lines, test fixtures) in English.
- Subagent-driven execution (per memory pin).

---

## Phase 1: Porter — admin endpoint

Repo: `/Users/danierestevez/Documents/work/gantri/porter`. Branch: `feat/admin-users-merge`. New PR.

### Task 1: Service method `mergeUsers`

**Files:**
- Create: `controllers/user.js` already has a `UserController` class — add a new method `mergeUsersForAdmin` there (or a helper in `services/user.js` if cleaner; match the existing pattern of `getUserForAdmin`).

Steps:
- [ ] **Step 1:** Inside one Sequelize transaction, do:
  - `User.findOne({ where: { email: oldEmail }, transaction: t })` — fail with 404 `OLD_USER_NOT_FOUND` if not found.
  - Same for `newEmail` — fail with 404 `NEW_USER_NOT_FOUND`.
  - If `oldUser.id === newUser.id` → throw 400 `EMAILS_IDENTICAL`.
  - If `oldUser.deletedAt != null` → throw 422 `OLD_ALREADY_SOFT_DELETED`.
  - `const [ordersMoved] = await Transaction.update({ userId: newUser.id }, { where: { userId: oldUser.id }, transaction: t })`.
  - If new user's `firstName` is null/empty AND old user has a value → `newUser.firstName = oldUser.firstName; newUser.lastName = oldUser.lastName; await newUser.save({ transaction: t })`. Else skip the copy.
  - `oldUser.deletedAt = new Date(); await oldUser.save({ transaction: t });`
  - Capture `klaviyoIds: { old: oldUser.klaviyoId, new: newUser.klaviyoId }` for the response — no Klaviyo writes.
  - Return `{ success: true, oldUserId, newUserId, ordersMoved, profileCopied: { firstName, lastName } | null, oldAccountSoftDeleted: true, klaviyoIds }`.

- [ ] **Step 2:** Wire up exposure as a class method on `UserController` so `routes/user.js` can pick it up. Match the binding pattern at `routes/user.js:189` (`.bind(userController)`).

- [ ] **Step 3:** Run typecheck (`npm run build` or equivalent — Porter uses `tsc`).

- [ ] **Step 4:** Commit `feat(admin): UserController.mergeUsersForAdmin (Transactions + soft-delete in tx)`.

### Task 2: Express route

**Files:**
- Modify: `routes/user.js`. Add the route **before** `/api/admin/users/:id` (already there at line 207 area) to avoid the by-id parametrized route swallowing `/merge` as `id="merge"` — same gotcha as `by-email` in PR #5114.

Steps:
- [ ] **Step 1:** Add route + middlewares:

```js
// Admin merge endpoint — move all transactions from oldEmail's account to
// newEmail's account, copy profile fields if newEmail is blank, soft-delete
// the old account. Atomic. MUST be registered before the parametrized
// /api/admin/users/:id route (Express first-match).
app.post(
  '/api/admin/users/merge',
  expressJwt(jwtOptions),
  checkPermissions({ requiredRoles: [Roles.ADMIN] }),
  action(userController.mergeUsersForAdmin.bind(userController), { useRollback: true }),
);
```

- [ ] **Step 2:** Verify route order in the file by reading lines 200-220.
- [ ] **Step 3:** Commit `feat(routes): POST /api/admin/users/merge (admin-only, transactional)`.

### Task 3: Mocha integration tests

**Files:**
- Modify: `routes/user/user.test.ts` (add a new `describe` block at the end of the existing positive-testing section).
- Modify: `test/data/user.js` (add `sendAdminMergeUsersRequest` helper, mirroring `sendAdminUserByEmailRequest`).

Steps:
- [ ] **Step 1:** Test helper:

```js
sendAdminMergeUsersRequest: (token, payload) =>
  chai
    .request(app)
    .post('/api/admin/users/merge')
    .set('Authorization', `Bearer ${token}`)
    .send(payload),
```

- [ ] **Step 2:** Test cases in `user.test.ts` (each in a `wrapPgTransaction` to auto-rollback DB state):
  1. Happy path: old user has 2 orders, new user is empty → 200 with `ordersMoved: 2`, old user has `deletedAt != null`, both orders now have `userId = newUser.id`.
  2. Old has 0 orders → still 200 with `ordersMoved: 0`, profile copied, old soft-deleted.
  3. Both have orders → 200 with `ordersMoved: <count>`, new user's old orders untouched.
  4. New user has profile filled → no profile copy happens (assert `profileCopied: null`).
  5. Same email both fields → 400 `EMAILS_IDENTICAL`.
  6. Old email not found → 404 `OLD_USER_NOT_FOUND`.
  7. New email not found → 404 `NEW_USER_NOT_FOUND`.
  8. Old already soft-deleted (set `deletedAt` manually first) → 422 `OLD_ALREADY_SOFT_DELETED`.

- [ ] **Step 3:** Run only this test file:

```
NODE_ENV=test-new mocha ./dist/routes/user/user.test.js --grep "merge" --timeout 200000 --no-config --exit
```

(Adjust if the local test harness needs `db:migrate` first.)

- [ ] **Step 4:** Commit `test(routes): admin users merge — 8 cases`.

### Task 4: Create PR

- [ ] Push branch, open PR against `master` with title `feat(admin): merge customer accounts endpoint`.
- [ ] Body: link to design doc (`docs/superpowers/specs/2026-05-11-merge-customer-accounts-design.md` in gantri-ai-bot repo — yes, cross-repo link).
- [ ] Wait for human review + CI.
- [ ] After merge: cherry-pick to `staging` branch if staging is not auto-deployed from master.

---

## Phase 2: Bot — tool

Repo: `/Users/danierestevez/Documents/work/gantri/gantri-ai-bot`. Branch: `main`. Direct commits (small repo, no PR review process).

**Prerequisite:** Phase 1's Porter PR merged AND deployed to staging Porter. Confirm with:
```
curl -i -H "Authorization: Bearer <token>" https://stage.api.gantri.com/api/admin/users/merge -X POST -H "Content-Type: application/json" -d '{}'
```
Expecting 400 (validation error, not 404 route-not-found).

### Task 5: Tool schema + dispatch

**Files:**
- Modify: `src/connectors/gantri-porter/gantri-porter-connector.ts` (where `update_customer_email` lives — same connector).

Steps:
- [ ] **Step 1:** Define Zod schema:

```ts
const MergeCustomerAccountsArgs = z.object({
  oldEmail: z.string().email(),
  newEmail: z.string().email(),
  confirm: z.boolean().default(false),
});
```

- [ ] **Step 2:** Implement `runMergeCustomerAccounts({ oldEmail, newEmail, confirm })`:
  - Role check (same pattern as `runUpdateCustomerEmail`).
  - `confirm:false` branch:
    - Resolve both via `/api/admin/users/by-email`.
    - If either 404 → return `{ error: { code: 'OLD_USER_NOT_FOUND' | 'NEW_USER_NOT_FOUND', message: ... } }`.
    - If both resolve to same userId → `{ error: { code: 'EMAILS_IDENTICAL', ... } }`.
    - Count `oldUser.shop.orders.length` (already in by-email response — we verified during update_customer_email work).
    - Build preview message: target-prefix + "About to merge `<oldEmail>` (`<oldFirstName lastName>`, *N orders*) into `<newEmail>`... Reply **yes** to confirm." Include a Klaviyo warning line if both users have `klaviyoId`.
    - Return `{ kind: 'awaiting_confirmation', target, oldUserId, newUserId, oldEmail, newEmail, ordersToMove: N, klaviyoConflict, message }`.
  - `confirm:true` branch:
    - `POST <writeBaseUrl()>/api/admin/users/merge` with `{ oldEmail, newEmail }` and bot token.
    - On 200: write audit row in `gantri_writes` with `action: 'merge_customer_accounts'`, full request + response payloads, `writeTarget: target`. Reply with success message.
    - On 4xx/5xx: write audit with `status: 'failed'`, return typed error.

- [ ] **Step 3:** Register the tool in the connector's `tools` array. Match the style of `updateCustomerEmailTool` (description, schema, jsonSchema, execute).

- [ ] **Step 4:** `npx tsc --noEmit` — must be clean.

- [ ] **Step 5:** Commit `feat(porter): gantri.merge_customer_accounts tool`.

### Task 6: Unit tests

**Files:**
- Create: `tests/unit/connectors/gantri-porter/merge-customer-accounts-tool.test.ts`.

Steps:
- [ ] **Step 1:** Mirror `update-customer-email-tool.test.ts`'s `makeDeps` helper. Stub `porterFetch` per test.

- [ ] **Step 2:** Test cases:
  1. `cx role + confirm:false` happy path → returns `awaiting_confirmation` with correct counts.
  2. `cx role + confirm:true` happy path → calls POST /merge, writes audit, returns `{ ok:true, ordersMoved: N }`.
  3. `confirm:false` + old user not found → returns `OLD_USER_NOT_FOUND` error.
  4. `confirm:false` + new user not found → returns `NEW_USER_NOT_FOUND`.
  5. `confirm:false` + same userId → returns `EMAILS_IDENTICAL`.
  6. `confirm:true` + Porter returns 422 `OLD_ALREADY_SOFT_DELETED` → returns typed error, audit row with `status: 'failed'`.
  7. `confirm:true` + Porter returns 5xx → returns `PORTER_ERROR`, audit `status: 'failed'`.
  8. Non-CX non-admin role → `FORBIDDEN`, no Porter call.
  9. Both users have `klaviyoId` → preview message contains the warning line.
  10. PORTER_WRITE_TARGET=staging → `target: 'staging'` and `(staging mode)` prefix.

- [ ] **Step 3:** Run:
```
npx vitest run tests/unit/connectors/gantri-porter/merge-customer-accounts-tool.test.ts
```

- [ ] **Step 4:** Commit `test(porter): unit tests for merge_customer_accounts tool`.

### Task 7: Orchestrator routing test

**Files:**
- Create or modify: `tests/unit/orchestrator/merge-accounts-routing.test.ts` (or extend an existing routing test file).

Steps:
- [ ] **Step 1:** LLM-mocked test that "merge accounts for han between h.h.bnguyen2001@gmail.comb and h.bnguyen2001@gmail.com" routes to `gantri.merge_customer_accounts`, NOT `gantri.update_customer_email`.

- [ ] **Step 2:** Run; confirm.

- [ ] **Step 3:** Commit `test(orchestrator): merge_customer_accounts routing`.

### Task 8: Prompt update

**Files:**
- Modify: `src/orchestrator/prompts.ts`.

Steps:
- [ ] **Step 1:** Add a new section (or extend the `update_customer_email` bullet) documenting `gantri.merge_customer_accounts`:
  - Args: `oldEmail`, `newEmail`, `confirm`.
  - Triggers: "merge accounts", "duplicate account", "she has 2 accounts", "fusionar cuentas", "cuentas duplicadas", etc.
  - Two-step confirm — same pattern as `update_customer_email`.

- [ ] **Step 2:** Remove the corresponding scenario from the auto-flag list in the `feedback.flag_response` section (no longer "can't do this" — now the bot CAN). Leave the other auto-flag scenarios intact (GDPR, weird refunds, etc.).

- [ ] **Step 3:** Run prompt tests:
```
npx vitest run tests/unit/orchestrator/prompts.test.ts
```

- [ ] **Step 4:** Commit `feat(prompt): document merge_customer_accounts; drop from auto-flag list`.

### Task 9: Real-API smoke against staging

**Files:**
- Create: `scripts/smoke-merge-customer-accounts-staging.mjs`.

Steps:
- [ ] **Step 1:** Script logic:
  1. Connect to staging Porter via bot creds.
  2. Create two throwaway test users on staging (`POST /api/users`) with unique emails `smoke-merge-old-<ts>@gantri-test.invalid` and `smoke-merge-new-<ts>@gantri-test.invalid`.
  3. Verify the `from` user has zero orders (we're not creating a real order; we only smoke the merge mechanics, not the orders count side).
  4. Call `runMergeCustomerAccounts({ oldEmail, newEmail, confirm: false })` → expect `awaiting_confirmation`.
  5. Call again with `confirm: true` → expect `{ ok: true, ordersMoved: 0 }`.
  6. Re-fetch `/api/admin/users/by-email?email=<oldEmail>` → expect 404 (soft-deleted).
  7. Verify the new user's profile has `firstName` copied (we set firstName on the old user during creation).
  8. Verify a row landed in `gantri_writes`.
  - Do NOT clean up the test users from staging — they're throwaway. **Do NOT** run this against prod.

- [ ] **Step 2:** Run:
```
fly ssh sftp shell -a gantri-ai-bot
# put scripts/smoke-merge-customer-accounts-staging.mjs /app/scripts/
fly ssh console -a gantri-ai-bot -C 'cd /app && STAGING_OLD_EMAIL_PROFILE_FIRSTNAME=Smoke node scripts/smoke-merge-customer-accounts-staging.mjs'
```

- [ ] **Step 3:** If everything passes, commit `test(smoke): real-API merge_customer_accounts smoke against staging`.

### Task 10: Deploy + verify

- [ ] Push + `fly deploy`.
- [ ] Healthz/readyz check.
- [ ] End-to-end from Slack: `@gantri-ai merge accounts: old smoke-merge-old-<ts>@gantri-test.invalid → new smoke-merge-new-<ts>@gantri-test.invalid` (preview), reply `yes` (execute), verify success message + audit row.
- [ ] **Do not run on a real customer until Danny explicitly approves a prod test.**

---

## Self-review checklist

- [x] Spec coverage: all decisions from the design doc are reflected in tasks (Transactions only, Porter endpoint, soft-delete, Klaviyo out-of-scope).
- [x] No placeholders — every step has either code or a concrete command.
- [x] Type consistency: `mergeUsersForAdmin` (Porter) ↔ `runMergeCustomerAccounts` (bot) ↔ `/api/admin/users/merge` URL path — all consistent.
- [x] Testing must use staging (constraint pinned in plan header).

## Execution handoff

Phase 1 (Porter PR) blocks Phase 2 (bot integration). Phase 2 tasks 5-8 can start in parallel with mocked endpoint responses; tasks 9-10 must wait for Phase 1 to be merged + deployed to staging.
