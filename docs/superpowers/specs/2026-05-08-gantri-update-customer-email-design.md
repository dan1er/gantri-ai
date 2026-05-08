# `gantri.update_customer_email` — Design Spec

**Date**: 2026-05-08
**Author**: Danny + Claude
**Status**: Approved — ready for plan
**Document status**: Approved
**Feature status**: Planned
**Owner**: Danny
**Team / Pod**: Functional (gantri-ai-bot)
**Related links**:
- Originating CX request (Slack message from Zuzanna, May 8 2026): "modify email on customer account, order 43785"
- Existing connector: `src/connectors/gantri-porter/gantri-porter-connector.ts`
- Existing connector: `src/connectors/klaviyo/connector.ts`
- Sibling spec (admin-only role gate + audit pattern): `2026-05-07-pipedrive-write-tools-tier1-design.md`
- Porter route: `PUT /api/user` → `updateUser` controller (porter-as2000 `controllers/user.js:1769`)
- Porter route reference: `controllers/user.js:1828` (uniqueness validation)

---

## Functional Specification

### Overview

Customer experience (CX) sometimes receives requests like Zuzanna's: "please modify the email on order 43785 to danavoniel@gmail.com". Today this either gets handled by an engineer running a SQL query (which bypasses Porter's app-level hooks — notification, validation, session invalidation, Klaviyo sync) or simply doesn't happen because admin.gantri.com has no UI for editing a customer's email.

This spec adds **`gantri.update_customer_email`**, a Slack-side write tool that:
- Lets a `cx` (or `admin`) role user trigger an email change against a specific order's customer.
- Goes through Porter's normal `PUT /api/user` endpoint via **API impersonation** — using the customer's own `authToken` (exposed on the order response). This preserves ALL of Porter's app-level hooks (uniqueness validation, notification email to the old address, session-token invalidation, etc.) — same behavior as if the customer changed it themselves on their account page.
- Optionally syncs the change to the linked Klaviyo profile (`order.user.klaviyoId`) so receipts/marketing emails go to the new address. Default on; opt-out per call.
- Records a full audit row in a new `gantri_writes` table tying the Slack caller (e.g. Zuzanna's Slack id) to the Porter user_id, order_id, before/after emails, and Klaviyo sync outcome.
- Two-step confirm gate (preview first, "yes" second) — same UX pattern as Pipedrive's `delete_*` tools.
- Defaults to running against **staging** (`stage.api.gantri.com`); switching to prod is a separate `fly secrets set` once Danny validates.

This is the foundation for a future `cx` toolkit. Tier 2 is explicitly deferred (other field updates, customer-search-by-email, deletion, etc.).

### Conceptual

**What it does.** Lets a `cx` or `admin` Slack user, in a DM with the bot, change the email on a specific customer's Gantri account. The user gives the bot an order ID + a new email; the bot previews the change ("Order 43785 currently belongs to Xavi Ocana <xavi.ocana.s@gmail.com> — change to danavoniel@gmail.com? Other orders affected: 3. Klaviyo profile linked: yes."), waits for explicit yes, then executes. Porter handles the email change exactly as it would for a customer-driven self-edit. A separate audit row tracks who triggered it.

**Glossary.**

| Term | Definition |
|---|---|
| **Order** | A Porter `Transaction` row with `type='Order'`. Identified by integer order id (e.g. 43785). Links to a single customer via `userId`. |
| **Customer / user** | A Porter `User` row, identified by integer `userId`. Has `email`, `firstName`, `lastName`, etc. The same `User` can have multiple orders. |
| **`authToken`** | A long-lived JWT stamped onto the `User` row. Exposed on the order response (`order.user.authToken`). Used by admin tooling to act as the user without their password. We use it here to call `PUT /api/user` impersonating the customer. |
| **Impersonation** | Calling Porter's API with the customer's `authToken` instead of the bot's bot-account token, so the request hits the same code path as if the customer had self-edited. Preserves all hooks. |
| **`gantri_writes`** | New audit table (this spec) recording every successful or failed Gantri-customer write triggered from the bot. The "who" (Slack id) lives only here — Porter's own audit will see "user changed own email". |
| **CX role** | A new `authorized_users.role` value `cx` (added in migration 0022, already deployed). Granted to Zuzanna (added 2026-05-08, no intro DM). Distinct from `marketing` to keep blast radius small. |
| **Klaviyo profile sync** | Optional follow-up `PATCH /api/profiles/{klaviyoId}` to push the new email into Klaviyo so receipts/marketing aren't sent to the old address. |
| **Write target** | `staging` (default) or `prod`. Read by the connector at request time from the env var `PORTER_WRITE_TARGET`; staging hits `stage.api.gantri.com`, prod hits the existing `PORTER_API_BASE_URL`. |

### Goals

1. CX (Zuzanna today, more later) can resolve email-change tickets in Slack in <60 seconds, without engineering involvement.
2. The change goes through Porter's normal app-level hooks (uniqueness, notification, session invalidation) — no direct DB write.
3. Klaviyo profile is updated in the same call by default, so receipts/marketing reach the new email.
4. Every write produces a forensic audit row tying Slack caller → Porter user_id → before/after.
5. Staging-first deployment: tool runs against `stage.api.gantri.com` until Danny flips the flag.
6. Two-step confirm: zero risk of the LLM auto-executing an email change on a misread message.

### Non-goals

- **Updating any field other than email.** Phone, address, name, etc. are deferred. Once the email path is proven, expanding is a small follow-up.
- **Customer search by email.** The user must provide an order ID. If they only have a customer email, they can use existing read tools (`gantri.orders_query` with the email as search term) to find the order first.
- **Updating customers by `userId` alone.** v1 only accepts `orderId` as the lookup key, because the `authToken` lives on the order response. Tier 2 may add a user-id lookup endpoint via Porter API extension.
- **Direct DB writes (`PorterDbClient`).** Out of scope — Porter DB requires VPN from Fly, and impersonation gives us hook-preserving behavior anyway. Re-evaluate if a future tool genuinely needs DB access.
- **Adding a proper Porter admin endpoint** (PR to porter-as2000 for `PATCH /api/admin/users/:id/email`). Cleaner long-term but blocks on engineering review. Impersonation is functionally equivalent today; revisit when there's a Porter sprint.
- **Bulk email updates.** v1 is one-customer-at-a-time. Bulk is not in any current CX request.
- **Klaviyo profile updates other than email.** Future tool; out of scope here.

### User-visible behavior

| Slack input (from Zuzanna or another `cx` / `admin`) | Bot reply |
|---|---|
| _"Modify the email on order 43785 to danavoniel@gmail.com"_ | Preview: "Order 43785 belongs to **Xavi Ocana** (`xavi.ocana.s@gmail.com`). About to change to `danavoniel@gmail.com`. This customer has 3 orders total — all of them will reflect the new email. Klaviyo profile is linked and will also be updated. Reply *yes* to confirm." |
| _"yes"_ (after the preview above) | "Email updated. Porter user 59516 now has email `danavoniel@gmail.com`. Klaviyo profile synced. Audit id: `…`." |
| _"Modify the email on order 99999"_ (order doesn't exist) | "Order 99999 not found in Porter." |
| _"Modify the email on order 43785 to alice@x.com"_ but `alice@x.com` already belongs to another Gantri customer | Porter rejects with "The email already belongs to another account." Bot relays the error verbatim. |
| Caller has role `marketing` (not `cx`/`admin`) | "Sorry — `gantri.update_customer_email` requires the `cx` or `admin` role." |
| _"Modify the email on order 43785 to danavoniel@gmail.com without touching Klaviyo"_ | Same preview but with "Klaviyo: skip per request". On confirm, only Porter is updated. |
| Bot is configured to staging (`PORTER_WRITE_TARGET=staging`, default) | Reply prefix: "_(staging mode — change applies to stage.api.gantri.com only)_" so the operator can't mistake it for a prod write. |

### Out of scope (clarifications)

- **The new email going through email-confirmation.** Porter's `PUT /api/user` simply updates the column; it does NOT send a verification flow to the new address. If CX needs that (e.g. for compliance), we'd add `klaviyo.send_email` separately. For now, no verification — same as today's manual SQL.
- **Reverting an erroneous change.** If the operator confirms with the wrong email, the path to revert is: re-run the tool with the original email (and the customer's order id, which is preserved in the audit row).
- **Klaviyo sync as the only side effect**. Other linked systems (Stripe, Intercom, etc.) are NOT updated in this tool. If receipts go via Stripe, the operator should do that separately.
- **Notifying the old email** that the change happened. Porter's `saveNewInfo` may already do this — if so, it's preserved by going through `PUT /api/user`. We don't add anything; we don't remove anything.

---

## Technical Specification

### Architecture

```
Slack message from cx/admin user
        │
        ▼
DM handler → orchestrator.run() → LLM dispatches gantri.update_customer_email
        │                                        │
        │            ┌──── confirm: false ───────┘
        │            ▼
        │  GantriPorterConnector.runUpdateCustomerEmail (preview)
        │            │
        │            ├─► GET /api/admin/transactions/{orderId} (bot token)
        │            │      → grab user.id, user.email, user.authToken, user.klaviyoId
        │            ├─► GET /api/admin/paginated-transactions (count user's other orders)
        │            └─► return { kind: 'awaiting_confirmation', ... preview ... }
        │
        └────  confirm: true ────┐
                                 ▼
                  GantriPorterConnector.runUpdateCustomerEmail (execute)
                                 │
                                 ├─► GET /api/admin/transactions/{orderId} (re-fetch for safety)
                                 ├─► GET /api/user (impersonation: customer's authToken) — get firstName, lastName
                                 ├─► PUT /api/user (impersonation) — { email, firstName, lastName }
                                 │     ↳ Porter validates uniqueness, runs saveNewInfo hooks
                                 ├─► (optional, if syncKlaviyo=true and klaviyoId present)
                                 │     PATCH /api/profiles/{klaviyoId} — { attributes: { email } }
                                 ├─► gantri_writes INSERT { caller, order_id, user_id, klaviyo_id, before, after, status }
                                 └─► return { ok, message, ... }
```

The connector is `GantriPorterConnector` (existing). The new tool is the only addition to that connector's tool list. Klaviyo's existing `KlaviyoApiClient` gains one new method (`updateProfileEmail`).

### Components affected

#### 1. `migrations/0023_gantri_writes.sql` — NEW

```sql
CREATE TABLE IF NOT EXISTS gantri_writes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_slack_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('update_customer_email')),
  porter_user_id integer,
  porter_order_id integer,
  klaviyo_profile_id text,
  request_payload jsonb NOT NULL,
  response_payload jsonb,
  status text NOT NULL CHECK (status IN ('success', 'partial', 'failure')),
  write_target text NOT NULL CHECK (write_target IN ('staging', 'prod')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gantri_writes_caller_idx ON gantri_writes (caller_slack_id, created_at DESC);
CREATE INDEX IF NOT EXISTS gantri_writes_target_idx ON gantri_writes (porter_user_id, porter_order_id);
```

`status='partial'` covers "Porter updated but Klaviyo sync failed" — actionable for the operator (re-run with `syncKlaviyo: true` should be idempotent on Porter and retry the Klaviyo step).

`write_target` is recorded per row so a forensic look at the audit table tells you which environment the write hit.

#### 2. `src/storage/repositories/gantri-writes.ts` — NEW

Mirror `PipedriveWritesRepo`:

```ts
export interface GantriWriteRow {
  id: string;
  callerSlackId: string;
  action: 'update_customer_email';
  porterUserId: number | null;
  porterOrderId: number | null;
  klaviyoProfileId: string | null;
  requestPayload: unknown;
  responsePayload: unknown;
  status: 'success' | 'partial' | 'failure';
  writeTarget: 'staging' | 'prod';
  createdAt: string;
}

export class GantriWritesRepo {
  insert(input: Omit<GantriWriteRow, 'id' | 'createdAt'>): Promise<GantriWriteRow>;
  listForCaller(slackUserId: string, limit?: number): Promise<GantriWriteRow[]>;
}
```

#### 3. `src/connectors/gantri-porter/gantri-porter-connector.ts` — extend

Add to `GantriPorterConnectorDeps`:

```ts
export interface GantriPorterConnectorDeps {
  // ... existing fields
  writesRepo?: GantriWritesRepo;
  usersRepo?: AuthorizedUsersRepo;
  getActor?: () => ActorContext | undefined;
  klaviyoClient?: KlaviyoApiClient;   // for the optional sync step
}
```

Add a per-request base-URL helper that switches between prod and staging:

```ts
private writeBaseUrl(): string {
  return process.env.PORTER_WRITE_TARGET === 'prod'
    ? this.cfg.baseUrl   // existing prod URL
    : 'https://stage.api.gantri.com';
}

private writeTargetLabel(): 'staging' | 'prod' {
  return process.env.PORTER_WRITE_TARGET === 'prod' ? 'prod' : 'staging';
}
```

Default: `staging`. Switching to prod = `fly secrets set PORTER_WRITE_TARGET=prod` (no redeploy needed if we read it per-request, which we will).

Add the new tool:

```ts
const UpdateCustomerEmailArgs = z.object({
  orderId: z.number().int().positive().describe('Porter order id (the integer in https://admin.gantri.com/orders/<id>).'),
  newEmail: z.string().email().describe('The new email to set on the customer.'),
  syncKlaviyo: z.boolean().default(true).describe('When true (default), also patch the linked Klaviyo profile so receipts/marketing reach the new address. Pass false to update Porter only.'),
  confirm: z.boolean().default(false).describe('Pass true ONLY after the user has explicitly confirmed (e.g. replied "yes"). On the first call (confirm=false) the tool returns a preview asking for confirmation; do NOT auto-confirm.'),
});

const updateCustomerEmailTool: ToolDef<...> = {
  name: 'gantri.update_customer_email',
  description: [
    'Change the email on a Gantri customer account. Goes through Porter\'s PUT /api/user via impersonation, so all app-level hooks fire (uniqueness validation, notification email to the old address, session-token invalidation). Optionally syncs the change to the linked Klaviyo profile in the same call.',
    'CX or ADMIN role only — fails with FORBIDDEN otherwise.',
    'TWO-STEP CONFIRM: first call without confirm:true returns a preview (current email, customer name, total order count, klaviyo-linked flag); relay the preview to the user, wait for explicit "yes"/"si" in the NEXT message, then re-call with confirm:true. NEVER auto-confirm.',
    'Use when CX says: "modify email on order X to Y", "cambia el correo en el order X", "update customer email on order X", or relays a CX ticket text.',
    'When PORTER_WRITE_TARGET=staging (default), writes hit stage.api.gantri.com. When set to prod, writes hit production. Surface the target prominently in the user-facing reply.',
  ].join(' '),
  schema: UpdateCustomerEmailArgs,
  jsonSchema: zodToJsonSchema(UpdateCustomerEmailArgs),
  execute: (args) => this.runUpdateCustomerEmail(args),
};
```

The `runUpdateCustomerEmail` method:

```ts
private async runUpdateCustomerEmail(args: { orderId; newEmail; syncKlaviyo; confirm }) {
  // 1. Auth + role
  if (!this.deps.writesRepo || !this.deps.usersRepo || !this.deps.getActor) {
    return { error: { code: 'WRITE_DEPS_NOT_CONFIGURED', message: '...' } };
  }
  const actor = this.deps.getActor();
  if (!actor) return { error: { code: 'NO_ACTOR', message: '...' } };
  const role = await this.deps.usersRepo.getRole(actor.slackUserId);
  if (role !== 'cx' && role !== 'admin') {
    return { error: { code: 'FORBIDDEN', message: 'gantri.update_customer_email requires role=cx or role=admin.' } };
  }

  // 2. Fetch order
  const baseUrl = this.writeBaseUrl();
  const target = this.writeTargetLabel();
  const order = await this.fetchOrderForUpdate(baseUrl, args.orderId);
  if (!order) return { error: { code: 'ORDER_NOT_FOUND', message: `Order ${args.orderId} not found.` } };

  // 3. Preview
  if (!args.confirm) {
    const otherOrdersCount = await this.countOrdersForUser(baseUrl, order.user.id);
    return {
      kind: 'awaiting_confirmation',
      target,
      orderId: args.orderId,
      userId: order.user.id,
      customerName: `${order.firstName ?? ''} ${order.lastName ?? ''}`.trim(),
      currentEmail: order.email,
      newEmail: args.newEmail,
      otherOrdersCount,                 // total orders for this user (not just this one)
      klaviyoProfileLinked: !!order.user.klaviyoId,
      willSyncKlaviyo: args.syncKlaviyo && !!order.user.klaviyoId,
      message: buildPreviewText({ ... }),  // see "User-visible behavior" table
    };
  }

  // 4. Execute (impersonation)
  let porterOk = false;
  let klaviyoOk = false;
  let klaviyoError: string | undefined;
  try {
    // 4a. fetch the customer's current state via impersonation (need firstName/lastName for the PUT)
    const me = await fetchMeAsCustomer(baseUrl, order.user.authToken);

    // 4b. PUT new email
    await putUpdateUser(baseUrl, order.user.authToken, {
      email: args.newEmail,
      firstName: me.firstName,
      lastName: me.lastName,
    });
    porterOk = true;

    // 4c. optional Klaviyo sync
    if (args.syncKlaviyo && order.user.klaviyoId && this.deps.klaviyoClient) {
      try {
        await this.deps.klaviyoClient.updateProfileEmail(order.user.klaviyoId, args.newEmail);
        klaviyoOk = true;
      } catch (err) {
        klaviyoError = err instanceof Error ? err.message : String(err);
      }
    }

    // 4d. audit
    const status = porterOk && (!args.syncKlaviyo || klaviyoOk || !order.user.klaviyoId)
      ? 'success'
      : 'partial';
    await this.deps.writesRepo.insert({
      callerSlackId: actor.slackUserId,
      action: 'update_customer_email',
      porterUserId: order.user.id,
      porterOrderId: args.orderId,
      klaviyoProfileId: order.user.klaviyoId ?? null,
      requestPayload: { ...args, fromEmail: order.email },
      responsePayload: { porterOk, klaviyoOk, klaviyoError },
      status,
      writeTarget: target,
    });

    return { ok: true, target, porterOk, klaviyoOk, klaviyoError, message: '...' };
  } catch (err) {
    // 4e. failure audit
    await this.deps.writesRepo.insert({ ..., status: 'failure', responsePayload: { error: err } });
    return { error: { code: 'PORTER_ERROR', message: err.message } };
  }
}
```

#### 4. `src/connectors/klaviyo/client.ts` — add `updateProfileEmail`

```ts
async updateProfileEmail(profileId: string, newEmail: string): Promise<void> {
  // PATCH /api/profiles/{id}
  // body: { data: { type: 'profile', id: profileId, attributes: { email: newEmail } } }
  // 200 = success; 404 = profile not found; 409 = email conflict on Klaviyo side
}
```

Errors propagate up. The connector catches and treats Klaviyo failure as `partial` (Porter still succeeded).

#### 5. `src/index.ts` — wiring

Pass `writesRepo`, `usersRepo`, `getActor`, `klaviyoClient` through to `GantriPorterConnector`. Pattern matches what we did for `PipedriveConnector` in commit `e6fc745`.

Read `PORTER_WRITE_TARGET` once at startup just for a startup log line (so we can see "bot booted writing to staging" in deploy logs), but the connector itself reads `process.env.PORTER_WRITE_TARGET` per-request so a `fly secrets set` flips behavior without redeploy.

#### 6. `src/orchestrator/prompts.ts` — bullet

Add to the Gantri/Porter section:

```
• **`gantri.update_customer_email`** — change the email on a Gantri customer account. CX/ADMIN only. Goes through Porter's PUT /api/user via impersonation (preserves all hooks: uniqueness validation, notification email to the old address, session invalidation). Optionally syncs to the linked Klaviyo profile (default true). TWO-STEP CONFIRM: first call returns a preview; relay it to the user, wait for explicit "yes" in their NEXT message, THEN re-call with confirm:true. NEVER auto-confirm. Trigger words: "modify email on order X", "cambia el correo en el order X", "update customer email", CX ticket relays. Args: `orderId`, `newEmail`, `syncKlaviyo` (default true), `confirm` (default false).
```

Also a one-line note in the role-gate paragraph: "The `cx` role gates `gantri.update_customer_email` only. Reads (analytics, queries) remain open to all authorized users."

#### 7. `src/connectors/broadcast/intro-message.ts` — DON'T touch

Per Danny's "no auto-broadcast of intro" rule: any intro update happens later, after Danny reviews. v1 ships without an intro change — we'll draft a CX-broadcast separately for his approval.

### Data flow — happy path

1. Zuzanna in Slack DM: _"Modify the email on order 43785 to danavoniel@gmail.com"_.
2. Bot's orchestrator routes → `gantri.update_customer_email({ orderId: 43785, newEmail: 'danavoniel@gmail.com' })`.
3. Connector: role check `cx` → pass.
4. Connector fetches `GET /api/admin/transactions/43785` → gets `user.id=59516`, `user.authToken=…`, `user.klaviyoId=…`, `email=xavi.ocana.s@gmail.com`.
5. Connector counts user's orders via `paginated-transactions { search: 'xavi.ocana.s@gmail.com' }` → 3.
6. Connector returns `awaiting_confirmation` with preview.
7. Bot relays preview. Zuzanna replies _"yes"_.
8. LLM re-calls tool with `confirm: true`.
9. Connector re-fetches the order (defensive — state might have changed).
10. Connector calls `GET /api/user` (impersonation) → grabs `firstName='Xavi', lastName='Ocana'`.
11. Connector calls `PUT /api/user` (impersonation) with `{ email: 'danavoniel@gmail.com', firstName: 'Xavi', lastName: 'Ocana' }`.
12. Porter's `saveNewInfo` validates uniqueness, sends notification, etc. Returns 200.
13. Connector calls Klaviyo `PATCH /api/profiles/{klaviyoId}` with new email. Returns 200.
14. Audit row inserted: `status='success', porter_user_id=59516, porter_order_id=43785, klaviyo_profile_id=…, request_payload, response_payload, write_target='staging'`.
15. Bot replies: "Email updated. Porter user 59516 → `danavoniel@gmail.com`. Klaviyo synced. Audit id `…`."

### Error paths

| Scenario | Behavior |
|---|---|
| Order id doesn't exist in Porter (404 / null on read) | Connector returns `ORDER_NOT_FOUND` BEFORE preview. |
| New email already belongs to another Gantri customer | Porter rejects with "The email already belongs to another account." (line 1841 of `controllers/user.js`). Connector relays as `EMAIL_TAKEN`. Audit row `status='failure'` with the Porter error verbatim. |
| Customer's `authToken` is expired or invalid | Porter returns 401 from `PUT /api/user`. Connector returns `IMPERSONATION_FAILED`. The order data response should always carry a fresh enough authToken; if this happens, escalate to engineering. Audit row `status='failure'`. |
| Klaviyo PATCH fails (404 — profile gone, 409 — email conflict, 5xx — transient) | Porter update SUCCESS, Klaviyo step recorded as failed in response_payload. Audit `status='partial'`. Bot reply explicitly says "Porter updated, Klaviyo sync failed: <error>. Re-run the tool with `syncKlaviyo: true` to retry just that step." (Re-running with the same args is safe — Porter's email is already correct, the second `PUT` is a no-op.) |
| Caller is `marketing` / `user` (not `cx`/`admin`) | `FORBIDDEN`, no API calls. |
| `PORTER_WRITE_TARGET=staging` (default) and the order id only exists in prod | `ORDER_NOT_FOUND` (staging genuinely doesn't have the prod data). Bot reply mentions the target so the operator can switch contexts: "Order 43785 not found in **staging**. If this is a prod ticket, we'd need PORTER_WRITE_TARGET=prod." |
| LLM passes `confirm: true` without an explicit user yes (prompt-injection or hallucination) | Last-resort guard: the connector compares the most recent message timestamp in audit to the last `awaiting_confirmation` it returned for the same caller. If the gap is < 1 second, we can safely assume the LLM auto-confirmed — return `INVALID_AUTO_CONFIRM`. (Defense-in-depth; should not normally fire.) |

### Configuration

- **`PORTER_WRITE_TARGET`** — env var read at request time. Values: `staging` (default) or `prod`. Switch with `fly secrets set PORTER_WRITE_TARGET=prod` once Danny is ready to flip. Does NOT require redeploy.
- **`cx` role** — already added (migration 0022 applied 2026-05-08). Zuzanna already inserted (`U02K1RBQK6C`, no intro DM).
- **No new vault secrets**: bot's existing `PORTER_BOT_EMAIL` / `PORTER_BOT_PASSWORD` work against staging too (verified 2026-05-08).

### Performance / cost

- Preview path: 2 sequential Porter API calls (~300ms total).
- Execute path: 4 sequential calls (Porter GET order + Porter GET self + Porter PUT + Klaviyo PATCH) + 1 Supabase insert. ~700-900ms.
- Klaviyo PATCH: ~150ms when present; gracefully skipped if no klaviyoId on user.
- Pipedrive rate-limit equivalents: Porter has no per-token rate limit visible. Klaviyo has 75/m on profile writes — well within budget for one-customer-at-a-time.

---

## Testing Specification

### Layer 1 — unit tests (no external API)

`tests/unit/storage/gantri-writes-repo.test.ts` — NEW. 3 tests: insert success row, insert partial/failure row, listForCaller.

`tests/unit/connectors/gantri-porter/update-customer-email-tool.test.ts` — NEW. ~10 tests:
- Role gate (`cx` succeeds, `admin` succeeds, `marketing` → FORBIDDEN, `user` → FORBIDDEN, no actor → NO_ACTOR).
- `confirm=false` returns `awaiting_confirmation` with the right preview shape.
- `confirm=true` happy path: GET order → GET self → PUT → Klaviyo PATCH → audit row inserted with `status='success'`.
- `confirm=true` Klaviyo fails: audit row `status='partial'`, response includes klaviyoError.
- `confirm=true` no klaviyoId on user: skips Klaviyo entirely, `status='success'`, no klaviyoError.
- `confirm=true` `syncKlaviyo=false`: skips Klaviyo, audit row `klaviyo_profile_id` left null.
- Order not found (404) → `ORDER_NOT_FOUND`, no audit row.
- Schema rejects `newEmail` that's not a valid email.
- `write_target` is correctly recorded as 'staging' or 'prod' depending on `process.env.PORTER_WRITE_TARGET`.
- `customerName` falls back gracefully when firstName/lastName missing.

`tests/unit/connectors/klaviyo/update-profile-email.test.ts` — NEW. 3 tests: PATCH body shape, 404 maps to error, 200 returns void.

### Layer 2 — orchestrator integration tests with mocked LLM

New file: `tests/unit/orchestrator/gantri-update-email-routing.test.ts`. Same `fakeClaude` pattern as `pipedrive-write-routing.test.ts`. Scenarios:
- A. CX user: _"Modify email on order 43785 to alice@x.com"_ → tool calls `[gantri.update_customer_email({orderId:43785, newEmail:'alice@x.com'})]` (preview only). Then user replies _"yes"_ → tool re-called with `confirm:true`. Both calls captured.
- B. Marketing user: same input. Tool returns FORBIDDEN; LLM relays "requires cx or admin role".
- C. User says "no" mid-confirm: LLM does NOT call with confirm:true. Audit table has zero rows (the preview-only call doesn't write).
- D. Klaviyo sync explicitly off: _"Modify email on order 43785 to alice@x.com but don't touch Klaviyo"_ → tool args include `syncKlaviyo: false`.

### Layer 3 — E2E real-API smoke against STAGING

Per the auto-deploy memory and the "real-API smoke required" memory, before merge:
1. Run a probe script (similar to `probe-imperson-self-staging.mjs` from this design conversation) that creates a throwaway user on staging, runs the bot's compiled `runUpdateCustomerEmail` against it, verifies the change, **and reverts** so staging stays clean.
2. Confirm the audit row appears in Supabase with `write_target='staging'`.
3. Confirm Klaviyo PATCH was called only if a klaviyoId is present (skipped on a fresh test user — they have no Klaviyo profile).

The smoke runs against staging only. Prod is exercised manually by Danny once he flips `PORTER_WRITE_TARGET=prod` and runs an actual CX ticket end-to-end.

### Coverage gate

Layers 1+2 must pass in CI. Layer 3 is mandatory pre-deploy; failure on any item blocks rollout.

---

## Operational Specification

### Deploy

1. Apply migration `0023_gantri_writes.sql` via Supabase MCP. (`cx` role migration 0022 already applied.)
2. `git push origin main` + `fly deploy`. Bot boots with `PORTER_WRITE_TARGET=staging` (default).
3. Run the staging smoke checklist (Layer 3).
4. Optionally validate from Slack: Zuzanna or Danny DMs the bot with a real staging-order ticket. Audit row appears.
5. Once Danny confirms behavior is correct: `fly secrets set PORTER_WRITE_TARGET=prod`. Bot picks it up on next request (no redeploy needed because we read the env var per-request).
6. Update `tests/integration/smoke.md` with the CX flow checklist for future deploys.

### Rollback

Two paths:
- **Just tool**: revert the merge commit + redeploy. The migration is additive (new table, new role enum value) so rollback doesn't break old behavior.
- **Just write target**: `fly secrets set PORTER_WRITE_TARGET=staging` (or unset) — reverts to non-prod immediately, no redeploy.

### Observability

New log lines (pino, info level unless noted):
- `gantri_customer_email_preview_returned`: `{ caller, order_id, user_id, new_email, target }`.
- `gantri_customer_email_porter_updated`: `{ caller, order_id, user_id, target }`.
- `gantri_customer_email_klaviyo_synced`: `{ caller, order_id, klaviyo_id }`.
- `gantri_customer_email_klaviyo_skipped`: `{ caller, order_id, reason }` (no klaviyoId, or syncKlaviyo=false).
- `gantri_customer_email_klaviyo_failed`: `{ caller, order_id, error }` at warn level.
- `gantri_customer_email_failed`: `{ caller, order_id, error }` at warn level (Porter side failure).

### Alerting

No new alerts in v1. Existing audit-table reads + log-grep cover ops needs. Add a Grafana panel for "gantri_writes status=failure rate" if the volume justifies it post-launch.

---

## Security Specification

- **Role gate.** `cx` and `admin` only. Migration 0022 already added the role; the new tool is the first to gate on it. Other tools that gate on `admin` or `marketing` are unaffected.
- **Audit trail.** Every call (preview + execute) lives in `gantri_writes` with `caller_slack_id`. Forensic linkage to Slack id is the only place that records "who triggered the write" — Porter sees it as the customer's own self-edit.
- **`authToken` exposure.** The customer's authToken is read from the order response in-memory only. Never persisted, never logged. The `request_payload` jsonb in audit captures `args` (orderId, newEmail, syncKlaviyo) — NOT the authToken.
- **Email-as-attack-vector.** Email change is the canonical account-takeover vector. The two-step confirm + role gate + Slack-side audit close the obvious holes; the residual risk is "compromised CX Slack account triggers email changes." Mitigation: the `cx` role grants ONLY this tool (not `admin`), so a compromised Zuzanna account can't broadcast or add users.
- **Staging isolation.** Default behavior is staging. Production writes require an explicit `fly secrets set PORTER_WRITE_TARGET=prod`. The bot's reply prefix announces the target so an operator can't accidentally think they're in prod when they're in staging (or vice versa).
- **No new secrets.** Reuses existing `PORTER_BOT_EMAIL` / `PORTER_BOT_PASSWORD` (verified to work against staging). Klaviyo client already uses `KLAVIYO_API_KEY`. No new vault keys.

---

## Related Work

- `2026-05-07-pipedrive-write-tools-tier1-design.md` — same role-gate + audit pattern, two-step confirm UX.
- `2026-05-05-klaviyo-import-design.md` — sibling spec for Klaviyo writes; the `klaviyo.update_profile_email` method added here is its own micro-extension.
- Migration `0022_authorized_users_cx_role.sql` (applied 2026-05-08) — added the `cx` role enum value.

---

## Open Questions

1. **Should the tool also support `userId` lookup (not just `orderId`)?** Decision: no, defer to Tier 2. Order id is what CX has in tickets. Customer-search-by-email can come later.
2. **Should we add a lightweight notification to the OLD email saying "your email was changed by Gantri support, here's how to dispute"?** Decision: Porter's `saveNewInfo` may already do this — we don't add a separate one. If it doesn't, that's a Porter-side gap, fix there.
3. **Should `cx` role be allowed to use other tools (e.g. `gantri.orders_query` for context)?** Decision: yes, all reads remain open to all authorized users (regardless of role). The `cx` role only gates the WRITE we're adding here.
4. **Should Brooklyn also become `cx`?** Decision: open. Zuzanna is the immediate need (she sent the request). Whether more CX folks need access is a separate add-user call later.

---

## Future Work

- **Tier 2 — `gantri.update_customer_phone`, `_address`, `_name`.** Same pattern (impersonation + audit). Each adds one row to the `gantri_writes.action` enum.
- **Tier 2 — `gantri.find_customer_by_email`.** Read tool that lets CX go from "customer email" to "list of their orders" without an order id in hand.
- **Tier 2 — Notification template.** Manual override of the notification email content if Porter's default doesn't say enough about CX intervention.
- **Tier 3 — Direct Porter PR.** When engineering has bandwidth, add `PATCH /api/admin/users/:id/email` with proper admin gate + dedicated audit row in Porter's own log. Drops the impersonation hack. The bot tool stays interface-compatible; just swap the underlying call.
- **Tier 3 — `PorterDbClient` for fields where impersonation can't reach.** Only revisit if a future tool genuinely can't go through the API.
