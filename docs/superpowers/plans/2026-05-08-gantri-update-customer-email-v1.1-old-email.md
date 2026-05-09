# gantri.update_customer_email v1.1 — accept oldEmail as alternative to orderId

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Extend `gantri.update_customer_email` so CX can update a customer's email when they only have the old email (no order id).

**Architecture:** The existing tool fetches an order by id, extracts the customer's `authToken` from the order response, and impersonates the customer to PUT `/api/user`. The v1.1 path adds a *resolution step* before that: given `oldEmail`, resolve to `userId` via the new admin endpoint `/api/admin/users/by-email`, then find the customer's most recent order via `/api/admin/paginated-transactions?search=oldEmail` to obtain the same `authToken`. From the preview/confirm/PUT step onwards the flow is identical and unchanged.

**Tech Stack:** TypeScript (Node 20), Zod, Vitest, Anthropic SDK, Slack Bolt, Supabase (audit/users repos).

**Predecessor:** Original v1.0 spec → `docs/superpowers/specs/2026-05-08-gantri-update-customer-email-design.md`. Porter endpoint `/api/admin/users/by-email` shipped in PR #5114 (master) / #5115 (staging) and is already deployed.

**Decisions** (confirmed with Danny 2026-05-08):
1. Exactly one of `orderId` / `oldEmail` required — reject both or neither.
2. If `oldEmail` resolves a user with **no orders** → typed error `USER_HAS_NO_ORDERS` (deferred fix: a Tier 2 admin endpoint that updates email without impersonation).
3. If `oldEmail` matches no user → typed error `USER_NOT_FOUND_BY_EMAIL`.
4. Resolution chain: by-email → userId → search transactions by email → most recent order's `authToken`. Then run the existing flow.

---

## File Structure

- `src/connectors/gantri-porter/gantri-porter-connector.ts` — Zod schema, type, tool description, `runUpdateCustomerEmail` dispatch, two new private resolver helpers.
- `src/orchestrator/prompts.ts` — extend the `gantri.update_customer_email` bullet to mention both modes + trigger phrases.
- `tests/unit/connectors/gantri-porter/update-customer-email-tool.test.ts` — add unit tests for the new resolution branch.
- `tests/unit/orchestrator/gantri-update-email-routing.test.ts` — add a routing test for the oldEmail trigger phrase.
- `scripts/smoke-update-customer-email-staging.mjs` — extend with an oldEmail-mode smoke that stops before confirm.
- `tests/integration/smoke.md` — add the oldEmail path to the manual checklist.

---

## Task 1: Schema + type + tool description

**Files:**
- Modify: `src/connectors/gantri-porter/gantri-porter-connector.ts:770-789`

- [ ] **Step 1: Update Zod schema**

```ts
const UpdateCustomerEmailArgs = z
  .object({
    orderId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Porter order id (the integer in https://admin.gantri.com/orders/<id>). Provide either orderId OR oldEmail, not both.',
      ),
    oldEmail: z
      .string()
      .email()
      .optional()
      .describe(
        "The customer's CURRENT email on Porter. Use this when CX has the customer's email but no order id. Provide either orderId OR oldEmail, not both.",
      ),
    newEmail: z.string().email().describe('The new email to set on the customer.'),
    syncKlaviyo: z
      .boolean()
      .default(true)
      .describe(
        'When true (default), also patch the linked Klaviyo profile. Pass false to update Porter only.',
      ),
    confirm: z
      .boolean()
      .default(false)
      .describe(
        'Pass true ONLY after the user has explicitly confirmed (e.g. replied "yes"). On the first call (confirm=false) the tool returns a preview asking for confirmation; do NOT auto-confirm.',
      ),
  })
  .refine((v) => !!v.orderId !== !!v.oldEmail, {
    message:
      'Provide exactly one of orderId or oldEmail (not both, not neither).',
  });
```

- [ ] **Step 2: Update tool description**

Add a sentence to the description array stating both modes are supported:

```ts
'Two ways to identify the customer: pass `orderId` (when CX has an order URL) OR `oldEmail` (when CX has only the customer email). Provide exactly one. The oldEmail path resolves to userId via /api/admin/users/by-email and then fetches the most recent order to obtain the auth token used for impersonation.',
```

- [ ] **Step 3: Update trigger words in the description**

Append to the trigger-words sentence:
`Also: "modify email on alice@x.com to bob@y.com", "cambia el correo de alice@x.com", "update customer email for alice@x.com" — these are the oldEmail-mode triggers.`

- [ ] **Step 4: Verify type inference**

Make sure `type UpdateCustomerEmailArgs = z.infer<typeof UpdateCustomerEmailArgs>;` still compiles. `runUpdateCustomerEmail` parameter type signature must be updated to match the new optional shape (see Task 3).

- [ ] **Step 5: Commit**

```bash
git add src/connectors/gantri-porter/gantri-porter-connector.ts
git commit -m "feat(porter): accept oldEmail as alternative to orderId in update_customer_email schema"
```

---

## Task 2: Resolver helpers (oldEmail → userId; userId/email → most recent order)

**Files:**
- Modify: `src/connectors/gantri-porter/gantri-porter-connector.ts` (add private methods near `porterFetch`)

- [ ] **Step 1: Add `resolveUserByEmail` helper**

```ts
private async resolveUserByEmail(
  oldEmail: string,
  baseUrl: string,
  target: 'staging' | 'prod',
): Promise<
  | { ok: true; userId: number; currentEmail: string; klaviyoId: string | null; firstName: string; lastName: string }
  | { ok: false; error: { code: string; message: string; status?: number; body?: unknown } }
> {
  try {
    const resp = await this.porterFetch<{ account: any }>({
      method: 'GET',
      path: `/api/admin/users/by-email?email=${encodeURIComponent(oldEmail)}`,
      baseUrl,
    });
    const account = resp?.account ?? {};
    const userId = account.userId;
    if (typeof userId !== 'number') {
      return {
        ok: false,
        error: {
          code: 'PORTER_ERROR',
          message: `Unexpected /api/admin/users/by-email response: missing account.userId. Body keys: ${Object.keys(resp || {}).join(',')}`,
        },
      };
    }
    return {
      ok: true,
      userId,
      currentEmail: account.email ?? oldEmail.toLowerCase().trim(),
      klaviyoId: account.klaviyoId ?? null,
      firstName: account.firstName ?? '',
      lastName: account.lastName ?? '',
    };
  } catch (err: any) {
    if (err?.status === 404) {
      return {
        ok: false,
        error: {
          code: 'USER_NOT_FOUND_BY_EMAIL',
          message: `No user with email ${oldEmail} found in ${target}.`,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'PORTER_ERROR',
        status: err?.status,
        message: err?.message ?? String(err),
        body: err?.body,
      },
    };
  }
}
```

- [ ] **Step 2: Add `findMostRecentOrderByEmail` helper**

```ts
private async findMostRecentOrderByEmail(
  email: string,
  baseUrl: string,
  target: 'staging' | 'prod',
): Promise<
  | { ok: true; orderId: number; authToken: string; orderEmail: string; klaviyoId: string | null; firstName: string; lastName: string; userId: number; totalOrders: number }
  | { ok: false; error: { code: string; message: string; status?: number; body?: unknown } }
> {
  let resp: { transactions?: any[]; allOrders?: number };
  try {
    resp = await this.porterFetch<{ transactions?: any[]; allOrders?: number }>({
      method: 'POST',
      path: '/api/admin/paginated-transactions',
      baseUrl,
      body: { start: 0, count: 50, search: email },
    });
  } catch (err: any) {
    return {
      ok: false,
      error: {
        code: 'PORTER_ERROR',
        status: err?.status,
        message: err?.message ?? String(err),
        body: err?.body,
      },
    };
  }
  const orders = resp.transactions ?? [];
  // Pick the order whose user.email matches `email` and has an authToken.
  // The search param is fuzzy; filter strictly here so we don't pick a different
  // customer with a similar email.
  const lowered = email.toLowerCase().trim();
  const candidates = orders
    .filter((o) => (o?.user?.email ?? '').toLowerCase() === lowered)
    .filter((o) => !!o?.user?.authToken)
    .sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
  if (!candidates.length) {
    return {
      ok: false,
      error: {
        code: 'USER_HAS_NO_ORDERS',
        message: `User ${email} has no orders in ${target} (or none with a usable authToken). Cannot update email via impersonation. Add a Tier-2 admin endpoint to handle email-only users.`,
      },
    };
  }
  const top = candidates[0];
  return {
    ok: true,
    orderId: top.id,
    authToken: top.user.authToken,
    orderEmail: top.user.email,
    klaviyoId: top.user.klaviyoId ?? null,
    firstName: top.user.firstName ?? '',
    lastName: top.user.lastName ?? '',
    userId: top.user.id,
    totalOrders: resp.allOrders ?? candidates.length,
  };
}
```

- [ ] **Step 3: Commit**

```bash
git add src/connectors/gantri-porter/gantri-porter-connector.ts
git commit -m "feat(porter): add resolveUserByEmail + findMostRecentOrderByEmail helpers"
```

---

## Task 3: Refactor `runUpdateCustomerEmail` to dispatch on oldEmail vs orderId

**Files:**
- Modify: `src/connectors/gantri-porter/gantri-porter-connector.ts:166-340` (the existing method)

- [ ] **Step 1: Update method signature and arg defaults**

```ts
async runUpdateCustomerEmail(rawArgs: {
  orderId?: number;
  oldEmail?: string;
  newEmail: string;
  syncKlaviyo?: boolean;
  confirm?: boolean;
}): Promise<unknown> {
  const args = {
    orderId: rawArgs.orderId,
    oldEmail: rawArgs.oldEmail,
    newEmail: rawArgs.newEmail,
    syncKlaviyo: rawArgs.syncKlaviyo ?? true,
    confirm: rawArgs.confirm ?? false,
  };
  // ... existing dep + actor + role checks unchanged
}
```

- [ ] **Step 2: Reject invalid arg combinations early**

Right after the role check:

```ts
if (!!args.orderId === !!args.oldEmail) {
  return {
    error: {
      code: 'INVALID_ARGS',
      message:
        'Provide exactly one of orderId or oldEmail (not both, not neither).',
    },
  };
}
```

- [ ] **Step 3: Replace the order-fetch block (currently lines 192-213) with a dispatch**

Both branches must produce the same locals: `orderId, userId, currentEmail, customerToken, klaviyoId, firstName, lastName`.

```ts
let orderId: number;
let userId: number;
let currentEmail: string;
let customerToken: string | undefined;
let klaviyoId: string | null;
let firstName: string;
let lastName: string;

if (args.orderId) {
  // Existing path: fetch order by id, extract user fields.
  let orderResp: { order: any } | null = null;
  try {
    orderResp = await this.porterFetch<{ order: any }>({
      method: 'GET',
      path: `/api/admin/transactions/${args.orderId}`,
      baseUrl,
    });
  } catch (err: any) {
    if (err?.status === 404) {
      return {
        error: {
          code: 'ORDER_NOT_FOUND',
          message: `Order ${args.orderId} not found in ${target}.`,
        },
      };
    }
    return {
      error: {
        code: 'PORTER_ERROR',
        status: err?.status,
        message: err?.message ?? String(err),
        body: err?.body,
      },
    };
  }
  const order = orderResp.order;
  orderId = args.orderId;
  customerToken = order?.user?.authToken;
  userId = order?.user?.id;
  klaviyoId = order?.user?.klaviyoId ?? null;
  currentEmail = order?.email ?? '';
  firstName = order?.firstName ?? '';
  lastName = order?.lastName ?? '';
} else {
  // New path: resolve oldEmail → user → most recent order.
  const userRes = await this.resolveUserByEmail(args.oldEmail!, baseUrl, target);
  if (!userRes.ok) return { error: userRes.error };

  const orderRes = await this.findMostRecentOrderByEmail(
    userRes.currentEmail,
    baseUrl,
    target,
  );
  if (!orderRes.ok) return { error: orderRes.error };

  orderId = orderRes.orderId;
  userId = orderRes.userId;
  currentEmail = userRes.currentEmail;
  customerToken = orderRes.authToken;
  klaviyoId = userRes.klaviyoId ?? orderRes.klaviyoId ?? null;
  firstName = orderRes.firstName || userRes.firstName;
  lastName = orderRes.lastName || userRes.lastName;
}
```

- [ ] **Step 4: Update preview / confirm / execute / audit blocks to use the new locals**

Find every reference to `args.orderId` in the rest of the method and replace with the local `orderId`. Specifically: log lines (`order_id: ...`), audit `porterOrderId`, the `awaiting_confirmation` payload's `orderId` field. The `currentEmail`/`userId`/etc. locals are already used; just confirm they reference the new names not the inlined destructuring.

For the preview's "totalOrders" lookup (currently a separate paginated-transactions search): in the oldEmail path we already have `orderRes.totalOrders` — use that to skip the redundant call. Pseudocode:

```ts
let totalOrders: number;
if (args.oldEmail) {
  totalOrders = orderRes.totalOrders; // already fetched
} else {
  // existing fallback for orderId path
  totalOrders = 1;
  try {
    const tx = await this.porterFetch<{ allOrders?: number; transactions?: unknown[] }>({
      method: 'POST',
      path: '/api/admin/paginated-transactions',
      baseUrl,
      body: { start: 0, count: 100, search: currentEmail },
    });
    totalOrders = tx.allOrders ?? tx.transactions?.length ?? 1;
  } catch { /* fall back to 1 */ }
}
```

- [ ] **Step 5: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/connectors/gantri-porter/gantri-porter-connector.ts
git commit -m "feat(porter): dispatch update_customer_email on orderId vs oldEmail"
```

---

## Task 4: Unit tests for the new resolution path

**Files:**
- Modify: `tests/unit/connectors/gantri-porter/update-customer-email-tool.test.ts`

- [ ] **Step 1: Inspect the existing fetch-mock pattern in this file**

Run:
```bash
grep -n "porterFetch\|fetch.*mock\|stub.*porter\|http.*intercept" tests/unit/connectors/gantri-porter/update-customer-email-tool.test.ts | head
```

Use whatever stubbing pattern is already in the file (likely `vi.spyOn` on the connector or `nock`/`msw`). Add new test cases following the same style.

- [ ] **Step 2: Add the following tests**

Names (exact `it(...)` strings):

1. `oldEmail-mode: happy path resolves user and returns awaiting_confirmation`
2. `oldEmail-mode: returns USER_NOT_FOUND_BY_EMAIL when /api/admin/users/by-email is 404`
3. `oldEmail-mode: returns USER_HAS_NO_ORDERS when paginated-transactions returns no matching order`
4. `arg validation: returns INVALID_ARGS when both orderId and oldEmail provided`
5. `arg validation: returns INVALID_ARGS when neither orderId nor oldEmail provided`
6. `oldEmail-mode: confirm:true path completes the email change end-to-end (mock PUT /api/user, mock Klaviyo)`

For each test, mock the Porter responses appropriate to the scenario and assert on the returned object's `error.code` or its `kind === 'awaiting_confirmation'` shape. Reuse the `actor`/`role`/`writesRepo` mocks already established in the file.

- [ ] **Step 3: Run the file**

```bash
npx vitest run tests/unit/connectors/gantri-porter/update-customer-email-tool.test.ts
```

Expected: 6 new tests pass, existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/connectors/gantri-porter/update-customer-email-tool.test.ts
git commit -m "test(porter): unit tests for oldEmail-mode update_customer_email"
```

---

## Task 5: Orchestrator routing test

**Files:**
- Modify: `tests/unit/orchestrator/gantri-update-email-routing.test.ts`

- [ ] **Step 1: Add an LLM-mocked test that verifies the prompt routes oldEmail-only phrasing to the tool**

Follow the pattern of the existing 5 routing tests in this file. New test name:

`'cambia el correo de alice@example.com a bob@example.com' routes to gantri.update_customer_email with oldEmail+newEmail (no orderId)`

Assert that the resulting tool call has `oldEmail === 'alice@example.com'`, `newEmail === 'bob@example.com'`, and `orderId === undefined`.

- [ ] **Step 2: Run**

```bash
npx vitest run tests/unit/orchestrator/gantri-update-email-routing.test.ts
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/orchestrator/gantri-update-email-routing.test.ts
git commit -m "test(orchestrator): routing for oldEmail-mode update_customer_email"
```

---

## Task 6: Update prompt

**Files:**
- Modify: `src/orchestrator/prompts.ts:216` (the `gantri.update_customer_email` bullet)

- [ ] **Step 1: Update the bullet to mention both modes**

Change:
```
Args: `orderId`, `newEmail`, `syncKlaviyo` (default true), `confirm` (default false).
```

To:
```
Args: EXACTLY ONE of `orderId` (Porter order id) or `oldEmail` (the customer's current email — use this when CX has only the email, e.g. "modify email on alice@x.com to bob@y.com"); plus `newEmail`, `syncKlaviyo` (default true), `confirm` (default false). NEVER pass both orderId and oldEmail.
```

Add new trigger phrases inline with the existing list: `"modify email on alice@x.com to bob@y.com"`, `"cambia el correo de alice@x.com a bob@y.com"`, `"update customer email for alice@x.com"`.

- [ ] **Step 2: Run prompt tests**

```bash
npx vitest run tests/unit/orchestrator/prompts.test.ts
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/orchestrator/prompts.ts
git commit -m "feat(prompt): document oldEmail mode for update_customer_email"
```

---

## Task 7: Real-API smoke against staging

**Files:**
- Modify: `scripts/smoke-update-customer-email-staging.mjs`

- [ ] **Step 1: Add an oldEmail-mode smoke that stops at the preview step**

After the existing orderId smoke, add a second pass that:
1. Calls the tool with `{ oldEmail: <known-staging-customer-email>, newEmail: <some-fresh-email>, confirm: false }`.
2. Asserts the response has `kind === 'awaiting_confirmation'` and that `userId` / `currentEmail` / `totalOrders` are populated.
3. Does NOT call confirm — the goal is to validate the resolution chain end-to-end without actually mutating the staging customer.

Get the staging customer's email from Danny if not already in the smoke harness.

- [ ] **Step 2: Run smoke against staging**

```bash
PORTER_WRITE_TARGET=staging node scripts/smoke-update-customer-email-staging.mjs
```

Expected: both the orderId pass (existing) and the oldEmail pass (new) succeed. No staging data is written.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-update-customer-email-staging.mjs
git commit -m "test(smoke): real-API oldEmail-mode smoke for update_customer_email"
```

---

## Task 8: Update smoke checklist

**Files:**
- Modify: `tests/integration/smoke.md`

- [ ] **Step 1: Add an "oldEmail mode" subsection to the existing CX flow checklist**

Document the manual Slack steps:
1. In Slack: `@gantri-ai modify email on <staging-test-customer> to <some-fresh-email>`
2. Bot replies with preview that includes: target prefix, userId, customerName, currentEmail, totalOrders, klaviyoLinked.
3. Reply `yes`.
4. Bot reports success + audit row written.
5. Verify in `gantri_writes` that the row has `porterOrderId` populated (from the resolved most recent order) AND a note that the trigger was oldEmail mode (if we add a column for this; otherwise skip).
6. Reset by changing the email back via the same flow.

- [ ] **Step 2: Commit**

```bash
git add tests/integration/smoke.md
git commit -m "docs(smoke): oldEmail-mode checklist for update_customer_email"
```

---

## Task 9: Deploy + post-deploy verification

- [ ] **Step 1: Push**

```bash
git push origin main
```

- [ ] **Step 2: Deploy**

```bash
fly deploy
```

- [ ] **Step 3: Verify deployment**

```bash
curl -fsS https://gantri-ai-bot.fly.dev/healthz
curl -fsS https://gantri-ai-bot.fly.dev/readyz
```

- [ ] **Step 4: End-to-end Slack smoke**

In the Slack DM with the bot:
1. Type: `modify email on <staging-customer-email> to <fresh-email>`
2. Verify preview includes `(staging mode)` prefix, userId, currentEmail, totalOrders.
3. Reply `yes`.
4. Verify success message + that the customer's email is updated in `stage.api.gantri.com`.
5. Verify a row exists in `gantri_writes` with the correct caller/old/new email.
6. Reset by changing back.

- [ ] **Step 5: Done**

Update memory if any new constraint was learned.
