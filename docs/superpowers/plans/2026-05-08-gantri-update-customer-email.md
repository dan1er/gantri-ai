# `gantri.update_customer_email` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `gantri.update_customer_email` to the gantri-ai-bot — a CX/admin-gated tool that changes a customer's email via Porter API impersonation, optionally syncs to Klaviyo, and audits every call. Defaults to staging until Danny flips a feature flag.

**Architecture:**
- Tool lives on the existing `GantriPorterConnector`. New deps: `writesRepo`, `usersRepo`, `getActor`, `klaviyoClient`.
- Two-step confirm: first call returns preview, second call (with `confirm: true`) executes.
- Execute path: GET order (bot token, prod or staging URL based on `PORTER_WRITE_TARGET`) → GET self (impersonation, customer's authToken) → PUT /api/user (impersonation) → optional Klaviyo PATCH → audit row.
- Klaviyo client gains one new method (`updateProfileEmail`).

**Tech Stack:** TypeScript, Node 20, Vitest, Anthropic SDK (mocked in tests), Supabase (audit table), Porter REST v1 (impersonation), Klaviyo REST.

**Spec:** `docs/superpowers/specs/2026-05-08-gantri-update-customer-email-design.md`

---

## File Map

**Create:**
- `migrations/0023_gantri_writes.sql` — DB migration (audit table)
- `src/storage/repositories/gantri-writes.ts` — repo
- `tests/unit/storage/gantri-writes-repo.test.ts` — repo tests
- `tests/unit/connectors/klaviyo/update-profile-email.test.ts` — Klaviyo client method test
- `tests/unit/connectors/gantri-porter/update-customer-email-tool.test.ts` — tool tests
- `tests/unit/orchestrator/gantri-update-email-routing.test.ts` — Layer-2 LLM-mocked tests
- `scripts/smoke-update-customer-email-staging.mjs` — Layer-3 real-API smoke (committed for re-runs)

**Modify:**
- `src/connectors/klaviyo/client.ts` — add `updateProfileEmail`
- `src/connectors/gantri-porter/gantri-porter-connector.ts` — extend deps, add helpers (`writeBaseUrl`, `writeTargetLabel`, `porterFetch`), add tool + handler
- `src/index.ts` — wire deps + log startup write target
- `src/orchestrator/prompts.ts` — bullet for the new tool + role-gate paragraph note
- `tests/integration/smoke.md` — add CX flow checklist

**Delete:** Nothing.

---

## Conventions for this plan

- All commands assume CWD `/Users/danierestevez/Documents/work/gantri/gantri-ai-bot`.
- Run a single test file with `npx vitest run <path>`.
- Each task ends with a commit. Commit prefixes: `feat()`, `refactor()`, `test()`, `docs()`. Include the `Co-Authored-By: Claude Opus 4.7 (1M context)` trailer.
- Migrations are applied via `mcp__supabase__apply_migration` against project `ykjjwszoxazzlcovhlgd`. Verify with a quick `information_schema` query.
- Pre-existing pipedrive flake at `tests/unit/connectors/pipedrive/connector.test.ts:348` is the only acceptable failure throughout these tasks. Confirmed at base SHA `0d9551b`.
- The `cx` role is already in `authorized_users` (migration 0022 applied 2026-05-08). Zuzanna is already enrolled with role `cx` (slack id `U02K1RBQK6C`, no intro DM was sent).
- Bot's existing Porter creds (`PORTER_BOT_EMAIL` / `PORTER_BOT_PASSWORD`) authenticate fine against `stage.api.gantri.com` (verified 2026-05-08). No new vault secrets.

---

### Task 1: DB migration — `gantri_writes` audit table

**Files:**
- Create: `migrations/0023_gantri_writes.sql`

- [ ] **Step 1: Write the migration**

Create `migrations/0023_gantri_writes.sql`:

```sql
-- One row per Gantri-customer write triggered from the bot. Mirrors the
-- pipedrive_writes pattern. The "who" (Slack caller) lives only here —
-- Porter's own audit will see "user changed own email" because we use
-- impersonation. write_target is recorded per row so a forensic look at
-- this table tells you which environment (staging or prod) the write hit.

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

CREATE INDEX IF NOT EXISTS gantri_writes_caller_idx
  ON gantri_writes (caller_slack_id, created_at DESC);
CREATE INDEX IF NOT EXISTS gantri_writes_target_idx
  ON gantri_writes (porter_user_id, porter_order_id);
```

- [ ] **Step 2: Apply via Supabase MCP**

Run via `mcp__supabase__apply_migration` (project_id `ykjjwszoxazzlcovhlgd`, name `0023_gantri_writes`). Expected: `{"success":true}`.

- [ ] **Step 3: Verify schema**

Run via `mcp__supabase__execute_sql`:
```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'gantri_writes'
ORDER BY ordinal_position;
```

Expected rows: `id (uuid, NO)`, `caller_slack_id (text, NO)`, `action (text, NO)`, `porter_user_id (integer, YES)`, `porter_order_id (integer, YES)`, `klaviyo_profile_id (text, YES)`, `request_payload (jsonb, NO)`, `response_payload (jsonb, YES)`, `status (text, NO)`, `write_target (text, NO)`, `created_at (timestamp with time zone, NO)`.

- [ ] **Step 4: Commit**

```bash
git add migrations/0023_gantri_writes.sql
git commit -m "$(cat <<'EOF'
feat(db): gantri_writes audit table for customer-data writes

Mirrors pipedrive_writes. Records every successful + failed
gantri.update_customer_email call with the Slack caller, target
porter user/order, klaviyo profile (if synced), request/response
payloads, status, and the write_target (staging or prod) so
forensics show exactly which environment was hit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `GantriWritesRepo` + tests

**Files:**
- Create: `src/storage/repositories/gantri-writes.ts`
- Create: `tests/unit/storage/gantri-writes-repo.test.ts`

- [ ] **Step 1: Write the repo tests**

Create `tests/unit/storage/gantri-writes-repo.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { GantriWritesRepo } from '../../../src/storage/repositories/gantri-writes.js';

function makeMockSupabase(rows: any[] = []) {
  const insertedRows: any[] = [];
  const supabase = {
    from: vi.fn().mockReturnThis(),
    insert: vi.fn(function (this: any, row: any) {
      const inserted = { ...row, id: 'row-uuid', created_at: '2026-05-08T12:00:00Z' };
      insertedRows.push(inserted);
      return {
        select: () => ({
          single: vi.fn().mockResolvedValue({ data: inserted, error: null }),
        }),
      };
    }),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: rows, error: null }),
  };
  return { supabase: supabase as any, insertedRows };
}

describe('GantriWritesRepo', () => {
  it('insert success row round-trips', async () => {
    const { supabase, insertedRows } = makeMockSupabase();
    const repo = new GantriWritesRepo(supabase);
    const row = await repo.insert({
      callerSlackId: 'U_ZUZ',
      action: 'update_customer_email',
      porterUserId: 59516,
      porterOrderId: 43785,
      klaviyoProfileId: '01JHPN57KPZFTJVN8D4D2WVK2H',
      requestPayload: { fromEmail: 'x@a.com', toEmail: 'x@b.com' },
      responsePayload: { porterOk: true, klaviyoOk: true },
      status: 'success',
      writeTarget: 'staging',
    });
    expect(row.id).toBe('row-uuid');
    expect(insertedRows[0].caller_slack_id).toBe('U_ZUZ');
    expect(insertedRows[0].porter_user_id).toBe(59516);
    expect(insertedRows[0].write_target).toBe('staging');
    expect(insertedRows[0].status).toBe('success');
  });

  it('insert partial row (porter ok, klaviyo failed)', async () => {
    const { supabase, insertedRows } = makeMockSupabase();
    const repo = new GantriWritesRepo(supabase);
    await repo.insert({
      callerSlackId: 'U_ZUZ',
      action: 'update_customer_email',
      porterUserId: 59516,
      porterOrderId: 43785,
      klaviyoProfileId: 'kid_x',
      requestPayload: {},
      responsePayload: { porterOk: true, klaviyoOk: false, klaviyoError: 'timeout' },
      status: 'partial',
      writeTarget: 'prod',
    });
    expect(insertedRows[0].status).toBe('partial');
    expect(insertedRows[0].write_target).toBe('prod');
  });

  it('insert failure row leaves resource ids null', async () => {
    const { supabase, insertedRows } = makeMockSupabase();
    const repo = new GantriWritesRepo(supabase);
    await repo.insert({
      callerSlackId: 'U_ZUZ',
      action: 'update_customer_email',
      porterUserId: null,
      porterOrderId: 43785,
      klaviyoProfileId: null,
      requestPayload: { newEmail: 'x@x.com' },
      responsePayload: { error: { code: 'PORTER_ERROR', status: 422 } },
      status: 'failure',
      writeTarget: 'staging',
    });
    expect(insertedRows[0].status).toBe('failure');
    expect(insertedRows[0].porter_user_id).toBeNull();
    expect(insertedRows[0].klaviyo_profile_id).toBeNull();
  });

  it('listForCaller queries by caller_slack_id desc with limit', async () => {
    const { supabase } = makeMockSupabase([
      { id: 'r1', caller_slack_id: 'U_ZUZ', action: 'update_customer_email', porter_user_id: 59516, porter_order_id: 43785, klaviyo_profile_id: null, request_payload: {}, response_payload: {}, status: 'success', write_target: 'staging', created_at: '2026-05-08T12:00:00Z' },
    ]);
    const repo = new GantriWritesRepo(supabase);
    const rows = await repo.listForCaller('U_ZUZ', 5);
    expect(supabase.from).toHaveBeenCalledWith('gantri_writes');
    expect(supabase.eq).toHaveBeenCalledWith('caller_slack_id', 'U_ZUZ');
    expect(supabase.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(supabase.limit).toHaveBeenCalledWith(5);
    expect(rows).toHaveLength(1);
    expect(rows[0].porterUserId).toBe(59516);
    expect(rows[0].writeTarget).toBe('staging');
  });
});
```

- [ ] **Step 2: Run — expect failures**

Run: `npx vitest run tests/unit/storage/gantri-writes-repo.test.ts`

Expected: FAIL with `Cannot find module '.../gantri-writes.js'`.

- [ ] **Step 3: Write the repo**

Create `src/storage/repositories/gantri-writes.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';

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

export interface GantriWriteInsert {
  callerSlackId: string;
  action: GantriWriteRow['action'];
  porterUserId: number | null;
  porterOrderId: number | null;
  klaviyoProfileId: string | null;
  requestPayload: unknown;
  responsePayload: unknown;
  status: GantriWriteRow['status'];
  writeTarget: GantriWriteRow['writeTarget'];
}

export class GantriWritesRepo {
  constructor(private readonly client: SupabaseClient) {}

  async insert(input: GantriWriteInsert): Promise<GantriWriteRow> {
    const { data, error } = await this.client
      .from('gantri_writes')
      .insert({
        caller_slack_id: input.callerSlackId,
        action: input.action,
        porter_user_id: input.porterUserId,
        porter_order_id: input.porterOrderId,
        klaviyo_profile_id: input.klaviyoProfileId,
        request_payload: input.requestPayload,
        response_payload: input.responsePayload,
        status: input.status,
        write_target: input.writeTarget,
      })
      .select('id, caller_slack_id, action, porter_user_id, porter_order_id, klaviyo_profile_id, request_payload, response_payload, status, write_target, created_at')
      .single();
    if (error) throw new Error(`gantri_writes insert failed: ${error.message}`);
    return mapRow(data);
  }

  async listForCaller(slackUserId: string, limit = 50): Promise<GantriWriteRow[]> {
    const { data, error } = await this.client
      .from('gantri_writes')
      .select('id, caller_slack_id, action, porter_user_id, porter_order_id, klaviyo_profile_id, request_payload, response_payload, status, write_target, created_at')
      .eq('caller_slack_id', slackUserId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`gantri_writes list failed: ${error.message}`);
    return (data ?? []).map(mapRow);
  }
}

function mapRow(r: any): GantriWriteRow {
  return {
    id: r.id,
    callerSlackId: r.caller_slack_id,
    action: r.action,
    porterUserId: r.porter_user_id ?? null,
    porterOrderId: r.porter_order_id ?? null,
    klaviyoProfileId: r.klaviyo_profile_id ?? null,
    requestPayload: r.request_payload,
    responsePayload: r.response_payload ?? null,
    status: r.status,
    writeTarget: r.write_target,
    createdAt: r.created_at,
  };
}
```

- [ ] **Step 4: Run — expect green**

Run: `npx vitest run tests/unit/storage/gantri-writes-repo.test.ts`

Expected: 4/4 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/repositories/gantri-writes.ts tests/unit/storage/gantri-writes-repo.test.ts
git commit -m "$(cat <<'EOF'
feat(repo): GantriWritesRepo for the gantri_writes audit table

insert + listForCaller, snake-to-camel row mapper. Mirrors the shape
of pipedrive-writes-repo and klaviyo-imports-repo.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Klaviyo `updateProfileEmail` client method + test

**Files:**
- Modify: `src/connectors/klaviyo/client.ts`
- Create: `tests/unit/connectors/klaviyo/update-profile-email.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/unit/connectors/klaviyo/update-profile-email.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { KlaviyoApiClient } from '../../../../src/connectors/klaviyo/client.js';

function fakeFetch(handler: (url: string, init?: any) => Promise<Response>) {
  return vi.fn(handler) as unknown as typeof fetch;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/vnd.api+json' } });
}

describe('KlaviyoApiClient — updateProfileEmail', () => {
  it('PATCHes /api/profiles/{id} with the JSON:API body shape', async () => {
    const fetchImpl = fakeFetch(async (url, init) => {
      expect(url).toMatch(/\/api\/profiles\/01JHPN57KPZFTJVN8D4D2WVK2H$/);
      expect(init?.method).toBe('PATCH');
      expect(init?.headers?.['Authorization']).toMatch(/^Klaviyo-API-Key /);
      expect(init?.headers?.['content-type']).toBe('application/vnd.api+json');
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({
        data: {
          type: 'profile',
          id: '01JHPN57KPZFTJVN8D4D2WVK2H',
          attributes: { email: 'new@example.com' },
        },
      });
      return jsonRes({ data: { id: '01JHPN57KPZFTJVN8D4D2WVK2H' } });
    });
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    await client.updateProfileEmail('01JHPN57KPZFTJVN8D4D2WVK2H', 'new@example.com');
  });

  it('throws on 404 (profile not found)', async () => {
    const fetchImpl = fakeFetch(async () => new Response(JSON.stringify({ errors: [{ code: 'not_found' }] }), { status: 404, headers: { 'content-type': 'application/vnd.api+json' } }));
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    await expect(client.updateProfileEmail('missing', 'x@y.com')).rejects.toThrow();
  });

  it('throws on 409 (email conflict)', async () => {
    const fetchImpl = fakeFetch(async () => new Response(JSON.stringify({ errors: [{ code: 'duplicate_profile' }] }), { status: 409, headers: { 'content-type': 'application/vnd.api+json' } }));
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    await expect(client.updateProfileEmail('p1', 'taken@y.com')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run — expect failures**

Run: `npx vitest run tests/unit/connectors/klaviyo/update-profile-email.test.ts`

Expected: FAIL — `client.updateProfileEmail is not a function`.

- [ ] **Step 3: Add the method**

Open `src/connectors/klaviyo/client.ts`. Find a place near the existing profile-related methods (look for `findProfileByEmail` or similar; if not, add near the bottom of the class before the closing brace). Add:

```ts
  /** Update a Klaviyo profile's primary email via PATCH /api/profiles/{id}.
   *  Used by gantri.update_customer_email to keep Klaviyo in sync with Porter.
   *  Throws on non-2xx responses; the caller maps that to a "partial" audit
   *  status. */
  async updateProfileEmail(profileId: string, newEmail: string): Promise<void> {
    const url = `${this.baseUrl}/api/profiles/${encodeURIComponent(profileId)}`;
    const body = {
      data: {
        type: 'profile',
        id: profileId,
        attributes: { email: newEmail },
      },
    };
    const res = await this.fetchImpl(url, {
      method: 'PATCH',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let errBody: unknown = null;
      try { errBody = await res.clone().json(); } catch {}
      throw new KlaviyoApiError(`PATCH /api/profiles/${profileId} -> ${res.status}`, res.status, errBody);
    }
  }
```

If `KlaviyoApiError` isn't imported in scope where you add the method, it's already an exported class in this same file — just use it directly.

- [ ] **Step 4: Run — expect green**

Run: `npx vitest run tests/unit/connectors/klaviyo/update-profile-email.test.ts`

Expected: 3/3 PASS.

Then run the broader Klaviyo suite to confirm no regressions: `npx vitest run tests/unit/connectors/klaviyo/`

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/klaviyo/client.ts tests/unit/connectors/klaviyo/update-profile-email.test.ts
git commit -m "$(cat <<'EOF'
feat(klaviyo): updateProfileEmail client method

PATCH /api/profiles/{id} with the JSON:API body shape, used by
gantri.update_customer_email to keep Klaviyo in sync with Porter
when CX changes a customer's email. Throws on non-2xx so the caller
can flag partial audit status.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Porter connector — extend deps + add staging-aware fetch helper

**Files:**
- Modify: `src/connectors/gantri-porter/gantri-porter-connector.ts`

This task lays the plumbing the new tool needs: deps + `writeBaseUrl` / `writeTargetLabel` / `porterFetch` helpers. No tool yet.

- [ ] **Step 1: Extend `GantriPorterConnectorDeps`**

Open `src/connectors/gantri-porter/gantri-porter-connector.ts`. Find the `GantriPorterConnectorDeps` (or equivalent — look for the constructor signature near line 30). Replace it with:

```ts
export interface GantriPorterConnectorDeps {
  baseUrl: string;
  email: string;
  password: string;
  rollupRepo: import('../../storage/rollup-repo.js').RollupRepo;
  /** Optional — required only by the gantri.update_customer_email tool.
   *  When omitted, that tool fails with WRITE_DEPS_NOT_CONFIGURED. */
  writesRepo?: import('../../storage/repositories/gantri-writes.js').GantriWritesRepo;
  /** Optional — same. */
  usersRepo?: import('../../storage/repositories/authorized-users.js').AuthorizedUsersRepo;
  /** Optional — same. */
  getActor?: () => import('../../orchestrator/orchestrator.js').ActorContext | undefined;
  /** Optional — required when syncKlaviyo=true. */
  klaviyoClient?: import('../klaviyo/client.js').KlaviyoApiClient;
}
```

If your current deps interface has slightly different existing fields, KEEP the existing fields and ADD the four optional ones — don't remove anything.

Update the constructor to also store the new fields:

```ts
constructor(public readonly deps: GantriPorterConnectorDeps) {
  // existing fields stay
}
```

If the existing constructor doesn't expose `deps` publicly, add a `public readonly deps` field.

- [ ] **Step 2: Add the staging-aware helpers**

Inside the same connector file, add two methods near `fetchJson` (around line 79-102):

```ts
  /** Per-request resolution of the write target. Read at request time (NOT
   *  cached) so a `fly secrets set PORTER_WRITE_TARGET=prod` flips behavior
   *  without redeploy. Default: staging. */
  private writeBaseUrl(): string {
    return process.env.PORTER_WRITE_TARGET === 'prod'
      ? this.cfg.baseUrl
      : 'https://stage.api.gantri.com';
  }

  private writeTargetLabel(): 'staging' | 'prod' {
    return process.env.PORTER_WRITE_TARGET === 'prod' ? 'prod' : 'staging';
  }

  /** Low-level HTTP helper that supports BOTH a base-URL override (for
   *  staging vs prod) AND a token override (for impersonation). Read paths
   *  use this for staging-aware GETs; the impersonation paths use it for
   *  the customer-token PUT. */
  async porterFetch<T>(opts: {
    method: string;
    path: string;
    body?: unknown;
    baseUrl?: string;
    token?: string;
  }): Promise<T> {
    const url = `${opts.baseUrl ?? this.cfg.baseUrl}${opts.path}`;
    const token = opts.token ?? (await this.getToken());
    const init: RequestInit = {
      method: opts.method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
    };
    if (opts.body !== undefined) {
      (init as any).body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let body: unknown = null;
      try { body = JSON.parse(text); } catch { body = text.slice(0, 500); }
      const err = new Error(`Porter ${opts.method} ${opts.path} → HTTP ${res.status}`) as Error & { status?: number; body?: unknown };
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return (await res.json()) as T;
  }
```

If the existing `cfg` field is named differently, use that name. Search for `this.cfg.baseUrl` to see the existing naming convention.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`

Expected: 0 errors. If `RollupRepo` import path is wrong, search for how it's currently imported in the same file and match that.

- [ ] **Step 4: Verify existing connector tests still pass**

Run: `npx vitest run tests/unit/connectors/gantri-porter/`

Expected: all PASS. If any fail, the deps change broke a fixture — make the new fields optional everywhere they need to be.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/gantri-porter/gantri-porter-connector.ts
git commit -m "$(cat <<'EOF'
refactor(gantri-porter): plumbing for gantri.update_customer_email

Extend deps with optional writesRepo + usersRepo + getActor +
klaviyoClient (write-tool only — read tools unchanged). Add
writeBaseUrl/writeTargetLabel helpers that read PORTER_WRITE_TARGET
per-request so a `fly secrets set` flips between staging
(stage.api.gantri.com) and prod without redeploy. Add porterFetch
helper that supports both base-URL override (staging vs prod) and
token override (impersonation).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `gantri.update_customer_email` tool — preview + execute paths

**Files:**
- Modify: `src/connectors/gantri-porter/gantri-porter-connector.ts`
- Create: `tests/unit/connectors/gantri-porter/update-customer-email-tool.test.ts`

This is the largest task. The tool ships preview + execute together because they share state and tests benefit from end-to-end coverage.

- [ ] **Step 1: Write the tool tests**

Create `tests/unit/connectors/gantri-porter/update-customer-email-tool.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GantriPorterConnector } from '../../../../src/connectors/gantri-porter/gantri-porter-connector.js';

function makeOrderResponse(overrides: any = {}) {
  return {
    order: {
      id: 43785,
      type: 'Order',
      status: 'Delivered',
      email: 'xavi@example.com',
      firstName: 'Xavi',
      lastName: 'Ocana',
      user: {
        id: 59516,
        klaviyoId: '01JHPN57KPZFTJVN8D4D2WVK2H',
        authToken: 'customer-jwt-token',
      },
      ...overrides,
    },
  };
}

function makePaginatedTransactionsResponse(count: number) {
  return {
    transactions: Array.from({ length: count }, (_, i) => ({ id: 1000 + i, type: 'Order' })),
    allOrders: count,
  };
}

interface Opts {
  callerRole?: 'cx' | 'admin' | 'marketing' | 'user' | null;
  porterFetchImpl?: any;
  klaviyoUpdate?: any;
  envWriteTarget?: 'staging' | 'prod' | undefined;
}

function makeDeps(opts: Opts = {}) {
  const insertedRows: any[] = [];
  // Default porterFetch sequence (in call order):
  //   1. GET order (preview): returns the order data
  //   2. POST paginated-transactions (preview): count of user's orders
  //   3. GET order (execute, defensive re-fetch)
  //   4. GET /api/user (impersonation, fetch firstName/lastName)
  //   5. PUT /api/user (impersonation, the email change)
  let porterCallCount = 0;
  const defaultPorterFetch = vi.fn(async (callOpts: any) => {
    porterCallCount += 1;
    const { method, path } = callOpts;
    if (method === 'GET' && path === '/api/admin/transactions/43785') {
      return makeOrderResponse();
    }
    if (method === 'POST' && path === '/api/admin/paginated-transactions') {
      return makePaginatedTransactionsResponse(3);
    }
    if (method === 'GET' && path === '/api/user') {
      return { data: { id: 59516, email: 'xavi@example.com', firstName: 'Xavi', lastName: 'Ocana' } };
    }
    if (method === 'PUT' && path === '/api/user') {
      return { success: true, data: { id: 59516, email: callOpts.body?.email } };
    }
    throw new Error(`Unexpected porterFetch call #${porterCallCount}: ${method} ${path}`);
  });

  const conn = new GantriPorterConnector({
    baseUrl: 'https://api.gantri.com',
    email: 'bot@gantri.com',
    password: 'pw',
    rollupRepo: { /* unused in these tests */ } as any,
    writesRepo: {
      insert: vi.fn(async (row: any) => { insertedRows.push(row); return { id: 'a', ...row, createdAt: 'now' }; }),
    } as any,
    usersRepo: {
      getRole: vi.fn().mockResolvedValue(opts.callerRole === undefined ? 'cx' : opts.callerRole),
    } as any,
    getActor: vi.fn().mockReturnValue({ slackUserId: 'U_ZUZ' }),
    klaviyoClient: {
      updateProfileEmail: opts.klaviyoUpdate ?? vi.fn().mockResolvedValue(undefined),
    } as any,
  });
  // Replace porterFetch with a spy
  (conn as any).porterFetch = opts.porterFetchImpl ?? defaultPorterFetch;
  return { conn, insertedRows };
}

function getTool(conn: GantriPorterConnector) {
  return conn.tools.find((t) => t.name === 'gantri.update_customer_email')!;
}

describe('gantri.update_customer_email', () => {
  beforeEach(() => {
    delete process.env.PORTER_WRITE_TARGET;
  });
  afterEach(() => {
    delete process.env.PORTER_WRITE_TARGET;
  });

  it('cx role + confirm=false → returns preview, makes NO destructive calls', async () => {
    const { conn, insertedRows } = makeDeps();
    const r = await getTool(conn).execute({
      orderId: 43785,
      newEmail: 'danavoniel@gmail.com',
      confirm: false,
    });
    expect((r as any).kind).toBe('awaiting_confirmation');
    expect((r as any).orderId).toBe(43785);
    expect((r as any).userId).toBe(59516);
    expect((r as any).currentEmail).toBe('xavi@example.com');
    expect((r as any).newEmail).toBe('danavoniel@gmail.com');
    expect((r as any).customerName).toBe('Xavi Ocana');
    expect((r as any).klaviyoProfileLinked).toBe(true);
    expect((r as any).willSyncKlaviyo).toBe(true);
    expect((r as any).target).toBe('staging');
    expect(insertedRows).toHaveLength(0);
  });

  it('cx role + confirm=true + happy path → updates Porter + Klaviyo + audit success', async () => {
    const { conn, insertedRows } = makeDeps();
    const r = await getTool(conn).execute({
      orderId: 43785,
      newEmail: 'danavoniel@gmail.com',
      syncKlaviyo: true,
      confirm: true,
    });
    expect((r as any).ok).toBe(true);
    expect((r as any).porterOk).toBe(true);
    expect((r as any).klaviyoOk).toBe(true);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      callerSlackId: 'U_ZUZ',
      action: 'update_customer_email',
      porterUserId: 59516,
      porterOrderId: 43785,
      klaviyoProfileId: '01JHPN57KPZFTJVN8D4D2WVK2H',
      status: 'success',
      writeTarget: 'staging',
    });
  });

  it('confirm=true + Klaviyo fails → audit partial, klaviyoError surfaced', async () => {
    const { conn, insertedRows } = makeDeps({
      klaviyoUpdate: vi.fn().mockRejectedValue(new Error('klaviyo timeout')),
    });
    const r = await getTool(conn).execute({
      orderId: 43785,
      newEmail: 'danavoniel@gmail.com',
      syncKlaviyo: true,
      confirm: true,
    });
    expect((r as any).porterOk).toBe(true);
    expect((r as any).klaviyoOk).toBe(false);
    expect((r as any).klaviyoError).toMatch(/klaviyo timeout/);
    expect(insertedRows[0].status).toBe('partial');
  });

  it('confirm=true + syncKlaviyo:false → skips Klaviyo entirely, status=success', async () => {
    const { conn, insertedRows } = makeDeps();
    const r = await getTool(conn).execute({
      orderId: 43785,
      newEmail: 'danavoniel@gmail.com',
      syncKlaviyo: false,
      confirm: true,
    });
    expect((r as any).porterOk).toBe(true);
    expect((r as any).klaviyoOk).toBe(false);
    expect((r as any).klaviyoError).toBeUndefined();
    expect(insertedRows[0].status).toBe('success');
    expect(insertedRows[0].klaviyoProfileId).toBeNull();
  });

  it('confirm=true + user has no klaviyoId → skips Klaviyo, status=success', async () => {
    // Override the default fetch to return an order without klaviyoId
    const customFetch = vi.fn(async (callOpts: any) => {
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/transactions/43785') {
        return makeOrderResponse({ user: { id: 59516, klaviyoId: null, authToken: 'tok' } });
      }
      if (callOpts.method === 'GET' && callOpts.path === '/api/user') {
        return { data: { firstName: 'Xavi', lastName: 'Ocana' } };
      }
      if (callOpts.method === 'PUT' && callOpts.path === '/api/user') {
        return { success: true };
      }
      if (callOpts.method === 'POST') {
        return makePaginatedTransactionsResponse(1);
      }
      throw new Error(`unexpected ${callOpts.method} ${callOpts.path}`);
    });
    const { conn, insertedRows } = makeDeps({ porterFetchImpl: customFetch });
    const r = await getTool(conn).execute({
      orderId: 43785,
      newEmail: 'x@y.com',
      syncKlaviyo: true,
      confirm: true,
    });
    expect((r as any).porterOk).toBe(true);
    expect(insertedRows[0].status).toBe('success');
    expect(insertedRows[0].klaviyoProfileId).toBeNull();
  });

  it('order not found → ORDER_NOT_FOUND, no audit row', async () => {
    const customFetch = vi.fn(async (callOpts: any) => {
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/transactions/99999') {
        const err: any = new Error('not found'); err.status = 404; throw err;
      }
      throw new Error('unexpected');
    });
    const { conn, insertedRows } = makeDeps({ porterFetchImpl: customFetch });
    const r = await getTool(conn).execute({ orderId: 99999, newEmail: 'x@y.com', confirm: false });
    expect((r as any).error.code).toBe('ORDER_NOT_FOUND');
    expect(insertedRows).toHaveLength(0);
  });

  it('Porter PUT 422 (email taken) → audit failure, error code surfaced', async () => {
    const customFetch = vi.fn(async (callOpts: any) => {
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/transactions/43785') {
        return makeOrderResponse();
      }
      if (callOpts.method === 'GET' && callOpts.path === '/api/user') {
        return { data: { firstName: 'Xavi', lastName: 'Ocana' } };
      }
      if (callOpts.method === 'PUT' && callOpts.path === '/api/user') {
        const err: any = new Error('email taken');
        err.status = 422;
        err.body = { error: 'The email already belongs to another account.' };
        throw err;
      }
      if (callOpts.method === 'POST') return makePaginatedTransactionsResponse(1);
      throw new Error('unexpected');
    });
    const { conn, insertedRows } = makeDeps({ porterFetchImpl: customFetch });
    const r = await getTool(conn).execute({ orderId: 43785, newEmail: 'taken@x.com', confirm: true });
    expect((r as any).error.code).toBe('PORTER_ERROR');
    expect((r as any).error.status).toBe(422);
    expect(insertedRows[0].status).toBe('failure');
  });

  it('FORBIDDEN for role=marketing', async () => {
    const { conn, insertedRows } = makeDeps({ callerRole: 'marketing' });
    const r = await getTool(conn).execute({ orderId: 43785, newEmail: 'x@y.com', confirm: true });
    expect((r as any).error.code).toBe('FORBIDDEN');
    expect(insertedRows).toHaveLength(0);
  });

  it('FORBIDDEN for role=user', async () => {
    const { conn, insertedRows } = makeDeps({ callerRole: 'user' });
    const r = await getTool(conn).execute({ orderId: 43785, newEmail: 'x@y.com', confirm: false });
    expect((r as any).error.code).toBe('FORBIDDEN');
    expect(insertedRows).toHaveLength(0);
  });

  it('admin role also allowed', async () => {
    const { conn } = makeDeps({ callerRole: 'admin' });
    const r = await getTool(conn).execute({ orderId: 43785, newEmail: 'x@y.com', confirm: false });
    expect((r as any).kind).toBe('awaiting_confirmation');
  });

  it('write_target=prod when env var set', async () => {
    process.env.PORTER_WRITE_TARGET = 'prod';
    const { conn, insertedRows } = makeDeps();
    const r = await getTool(conn).execute({ orderId: 43785, newEmail: 'x@y.com', confirm: true });
    expect((r as any).ok).toBe(true);
    expect(insertedRows[0].writeTarget).toBe('prod');
  });

  it('schema rejects invalid newEmail', () => {
    const { conn } = makeDeps();
    const tool = getTool(conn);
    expect(() => tool.schema.parse({ orderId: 43785, newEmail: 'not-an-email' })).toThrow();
  });

  it('schema defaults syncKlaviyo to true and confirm to false', () => {
    const { conn } = makeDeps();
    const tool = getTool(conn);
    const parsed = tool.schema.parse({ orderId: 43785, newEmail: 'x@y.com' });
    expect((parsed as any).syncKlaviyo).toBe(true);
    expect((parsed as any).confirm).toBe(false);
  });

  it('customerName falls back to "(unnamed)" when first/last missing', async () => {
    const customFetch = vi.fn(async (callOpts: any) => {
      if (callOpts.method === 'GET' && callOpts.path === '/api/admin/transactions/43785') {
        return makeOrderResponse({ firstName: null, lastName: null });
      }
      if (callOpts.method === 'POST') return makePaginatedTransactionsResponse(1);
      throw new Error('unexpected');
    });
    const { conn } = makeDeps({ porterFetchImpl: customFetch });
    const r = await getTool(conn).execute({ orderId: 43785, newEmail: 'x@y.com', confirm: false });
    expect((r as any).customerName).toBe('(unnamed)');
  });
});
```

- [ ] **Step 2: Run — expect failures (tool not present)**

Run: `npx vitest run tests/unit/connectors/gantri-porter/update-customer-email-tool.test.ts`

Expected: most/all FAIL — tool isn't registered yet. The `tools.find(...)` returns undefined.

- [ ] **Step 3: Add the tool to the connector**

Open `src/connectors/gantri-porter/gantri-porter-connector.ts`. Find the `tools` array (look for `readonly tools` near the class top). At the END of `buildTools()` or the equivalent that returns the tool list, before the `return [...]`, add the schema + tool def:

```ts
    const UpdateCustomerEmailArgs = z.object({
      orderId: z.number().int().positive().describe('Porter order id (the integer in https://admin.gantri.com/orders/<id>).'),
      newEmail: z.string().email().describe('The new email to set on the customer.'),
      syncKlaviyo: z.boolean().default(true).describe('When true (default), also patch the linked Klaviyo profile. Pass false to update Porter only.'),
      confirm: z.boolean().default(false).describe('Pass true ONLY after the user has explicitly confirmed (e.g. replied "yes"). On the first call (confirm=false) the tool returns a preview asking for confirmation; do NOT auto-confirm.'),
    });
    type UpdateCustomerEmailArgs = z.infer<typeof UpdateCustomerEmailArgs>;
    const updateCustomerEmailTool: ToolDef<UpdateCustomerEmailArgs> = {
      name: 'gantri.update_customer_email',
      description: [
        'Change the email on a Gantri customer account. Goes through Porter\'s PUT /api/user via impersonation, so all app-level hooks fire (uniqueness validation, notification email to the old address, session-token invalidation). Optionally syncs the change to the linked Klaviyo profile in the same call.',
        'CX or ADMIN role only — fails with FORBIDDEN otherwise.',
        'TWO-STEP CONFIRM: first call without confirm:true returns a preview (current email, customer name, total order count, klaviyo-linked flag); relay the preview to the user, wait for explicit "yes"/"si" in the NEXT message, then re-call with confirm:true. NEVER auto-confirm.',
        'Use when CX says: "modify email on order X to Y", "cambia el correo en el order X", "update customer email on order X", or relays a CX ticket text.',
        'When PORTER_WRITE_TARGET=staging (default), writes hit stage.api.gantri.com. When set to prod, writes hit production. Surface the target prominently in the user-facing reply.',
      ].join(' '),
      schema: UpdateCustomerEmailArgs as z.ZodType<UpdateCustomerEmailArgs>,
      jsonSchema: zodToJsonSchema(UpdateCustomerEmailArgs),
      execute: (args) => this.runUpdateCustomerEmail(args as UpdateCustomerEmailArgs),
    };
```

If `z`, `zodToJsonSchema`, or `ToolDef` aren't already imported in the file, search for how the read tools import them and match. They almost certainly are.

Add `updateCustomerEmailTool` to the returned tools array (alongside whatever read tools are already there).

- [ ] **Step 4: Add the `runUpdateCustomerEmail` private method**

Inside the same connector class, add the handler. Place it after the existing `run*` private methods if any, or near the bottom of the class:

```ts
  private async runUpdateCustomerEmail(args: {
    orderId: number; newEmail: string; syncKlaviyo: boolean; confirm: boolean;
  }): Promise<unknown> {
    const { writesRepo, usersRepo, getActor, klaviyoClient } = this.deps;
    if (!writesRepo || !usersRepo || !getActor) {
      return { error: { code: 'WRITE_DEPS_NOT_CONFIGURED', message: 'gantri.update_customer_email requires writesRepo + usersRepo + getActor in connector deps.' } };
    }
    const actor = getActor();
    if (!actor) return { error: { code: 'NO_ACTOR', message: 'gantri.update_customer_email requires an active actor.' } };
    const role = await usersRepo.getRole(actor.slackUserId);
    if (role !== 'cx' && role !== 'admin') {
      return { error: { code: 'FORBIDDEN', message: 'gantri.update_customer_email requires role=cx or role=admin.' } };
    }

    const baseUrl = this.writeBaseUrl();
    const target = this.writeTargetLabel();

    // 1. Fetch the order — confirms it exists and gives us user.id, user.authToken, klaviyoId, current email
    let orderResp: { order: any } | null = null;
    try {
      orderResp = await this.porterFetch<{ order: any }>({
        method: 'GET',
        path: `/api/admin/transactions/${args.orderId}`,
        baseUrl,
      });
    } catch (err: any) {
      if (err?.status === 404) {
        return { error: { code: 'ORDER_NOT_FOUND', message: `Order ${args.orderId} not found in ${target}.` } };
      }
      return { error: { code: 'PORTER_ERROR', status: err?.status, message: err?.message ?? String(err), body: err?.body } };
    }
    const order = orderResp.order;
    const customerToken: string | undefined = order?.user?.authToken;
    const userId: number | undefined = order?.user?.id;
    const klaviyoId: string | null = order?.user?.klaviyoId ?? null;
    const currentEmail: string = order?.email ?? '';
    const firstName: string = order?.firstName ?? '';
    const lastName: string = order?.lastName ?? '';

    // 2. Preview branch
    if (!args.confirm) {
      let totalOrders = 1;
      try {
        const tx = await this.porterFetch<{ allOrders?: number; transactions?: unknown[] }>({
          method: 'POST',
          path: '/api/admin/paginated-transactions',
          baseUrl,
          body: { start: 0, count: 100, search: currentEmail },
        });
        totalOrders = tx.allOrders ?? tx.transactions?.length ?? 1;
      } catch { /* fall back to 1 */ }
      const willSyncKlaviyo = args.syncKlaviyo && !!klaviyoId;
      const customerName = (firstName || lastName) ? `${firstName} ${lastName}`.trim() : '(unnamed)';
      const targetPrefix = target === 'staging'
        ? '_(staging mode — change applies to stage.api.gantri.com only)_\n'
        : '_(PROD MODE — change applies to live customer data)_\n';
      const message = `${targetPrefix}About to change email on Porter user *${userId}* (${customerName}) from \`${currentEmail}\` to \`${args.newEmail}\`. This customer has *${totalOrders} order${totalOrders === 1 ? '' : 's'}* total — all of them will reflect the new email.${willSyncKlaviyo ? ` Klaviyo profile *${klaviyoId}* is linked and will also be updated.` : (klaviyoId ? ' Klaviyo sync was disabled by request.' : ' No Klaviyo profile linked.')}\nReply *yes* to confirm.`;
      return {
        kind: 'awaiting_confirmation' as const,
        target,
        orderId: args.orderId,
        userId,
        customerName,
        currentEmail,
        newEmail: args.newEmail,
        totalOrders,
        klaviyoProfileLinked: !!klaviyoId,
        willSyncKlaviyo,
        message,
      };
    }

    // 3. Execute branch
    if (!customerToken) {
      return { error: { code: 'NO_AUTH_TOKEN', message: `Order ${args.orderId} response did not include user.authToken — cannot impersonate.` } };
    }

    let porterOk = false;
    let klaviyoOk = false;
    let klaviyoError: string | undefined;
    try {
      // 3a. Fetch customer's current state via impersonation (need firstName/lastName for the PUT)
      const me = await this.porterFetch<{ data?: { firstName?: string; lastName?: string }; firstName?: string; lastName?: string }>({
        method: 'GET',
        path: '/api/user',
        baseUrl,
        token: customerToken,
      });
      const meFirstName = me.data?.firstName ?? me.firstName ?? firstName ?? 'Customer';
      const meLastName = me.data?.lastName ?? me.lastName ?? lastName ?? '';

      // 3b. PUT new email (impersonation). Porter's saveNewInfo runs all the hooks.
      await this.porterFetch({
        method: 'PUT',
        path: '/api/user',
        baseUrl,
        token: customerToken,
        body: { email: args.newEmail, firstName: meFirstName, lastName: meLastName },
      });
      porterOk = true;
      logger.info({ caller: actor.slackUserId, order_id: args.orderId, user_id: userId, target }, 'gantri_customer_email_porter_updated');

      // 3c. Klaviyo sync (best-effort)
      if (args.syncKlaviyo && klaviyoId && klaviyoClient) {
        try {
          await klaviyoClient.updateProfileEmail(klaviyoId, args.newEmail);
          klaviyoOk = true;
          logger.info({ caller: actor.slackUserId, order_id: args.orderId, klaviyo_id: klaviyoId }, 'gantri_customer_email_klaviyo_synced');
        } catch (err: any) {
          klaviyoError = err?.message ?? String(err);
          logger.warn({ caller: actor.slackUserId, order_id: args.orderId, error: klaviyoError }, 'gantri_customer_email_klaviyo_failed');
        }
      } else if (args.syncKlaviyo && !klaviyoId) {
        logger.info({ caller: actor.slackUserId, order_id: args.orderId, reason: 'no_klaviyo_id' }, 'gantri_customer_email_klaviyo_skipped');
      } else if (!args.syncKlaviyo) {
        logger.info({ caller: actor.slackUserId, order_id: args.orderId, reason: 'sync_disabled' }, 'gantri_customer_email_klaviyo_skipped');
      }

      // 3d. Audit
      const klaviyoNeeded = args.syncKlaviyo && !!klaviyoId;
      const status: 'success' | 'partial' = (klaviyoNeeded && !klaviyoOk) ? 'partial' : 'success';
      await writesRepo.insert({
        callerSlackId: actor.slackUserId,
        action: 'update_customer_email',
        porterUserId: userId ?? null,
        porterOrderId: args.orderId,
        klaviyoProfileId: (klaviyoNeeded && klaviyoOk) ? klaviyoId : null,
        requestPayload: { ...args, fromEmail: currentEmail },
        responsePayload: { porterOk, klaviyoOk, klaviyoError },
        status,
        writeTarget: target,
      });

      const targetPrefix = target === 'staging' ? '_(staging)_ ' : '_(PROD)_ ';
      const klaviyoMsg = klaviyoNeeded
        ? (klaviyoOk
            ? ' Klaviyo synced.'
            : ` Klaviyo sync FAILED: ${klaviyoError}. Re-run with syncKlaviyo:true to retry just that step.`)
        : '';
      return {
        ok: true as const,
        target,
        porterOk,
        klaviyoOk,
        klaviyoError,
        message: `${targetPrefix}Email updated. Porter user ${userId} → \`${args.newEmail}\`.${klaviyoMsg}`,
      };
    } catch (err: any) {
      const status = err?.status as number | undefined;
      const body = err?.body;
      const message = err instanceof Error ? err.message : String(err);
      await writesRepo.insert({
        callerSlackId: actor.slackUserId,
        action: 'update_customer_email',
        porterUserId: userId ?? null,
        porterOrderId: args.orderId,
        klaviyoProfileId: null,
        requestPayload: { ...args, fromEmail: currentEmail },
        responsePayload: { error: { code: 'PORTER_ERROR', status, message, body }, porterOk, klaviyoOk },
        status: 'failure',
        writeTarget: target,
      }).catch(() => {});
      logger.warn({ caller: actor.slackUserId, order_id: args.orderId, error_code: 'PORTER_ERROR', status }, 'gantri_customer_email_failed');
      return { error: { code: 'PORTER_ERROR', status, message, body } };
    }
  }
```

If `logger` isn't imported in the file, add `import { logger } from '../../logger.js';` at the top.

- [ ] **Step 5: Run the tool tests — expect green**

Run: `npx vitest run tests/unit/connectors/gantri-porter/update-customer-email-tool.test.ts`

Expected: all 13 PASS.

If individual tests fail, the most common causes:
- `tools.find` returns undefined → tool not added to the array. Fix the array.
- Mocked porterFetch throws "unexpected method" → check the order of calls in your handler and update either the test or the handler so they match.
- Audit row shape mismatch → check that the field names in `writesRepo.insert` match what the test asserts.

- [ ] **Step 6: Run the full gantri-porter test suite — confirm no regressions**

Run: `npx vitest run tests/unit/connectors/gantri-porter/`

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/connectors/gantri-porter/gantri-porter-connector.ts tests/unit/connectors/gantri-porter/update-customer-email-tool.test.ts
git commit -m "$(cat <<'EOF'
feat(gantri-porter): gantri.update_customer_email tool

CX/admin gated tool that changes a customer's email via Porter's
PUT /api/user using API impersonation (the customer's authToken
exposed on the order response). Optionally syncs to the linked
Klaviyo profile in the same call. Two-step confirm gate (preview
first, then explicit yes from the user). Audits everything in
gantri_writes with the Slack caller.

Defaults to staging via PORTER_WRITE_TARGET env var; flip to prod
with `fly secrets set PORTER_WRITE_TARGET=prod` (no redeploy).

13 tests cover: cx + admin role, preview + execute, klaviyo
success / failure / skipped / no-id, order-not-found, porter
error, FORBIDDEN paths, write_target persistence, schema
validation, name fallbacks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Wire deps in `src/index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Find the existing GantriPorterConnector instantiation**

Run: `grep -n "GantriPorterConnector\|gantriPorter\b\|gantriPorter =" src/index.ts | head -10`

You'll see how it's currently constructed (something like `new GantriPorterConnector({ baseUrl: porterApiBaseUrl, email: porterBotEmail, password: porterBotPassword, rollupRepo })`). The new deps just slot in.

- [ ] **Step 2: Wire the new deps**

In `src/index.ts`, locate the GantriPorterConnector construction. Add the imports near the top (search for an existing repo import like `KlaviyoImportsRepo` and place the new import alongside):

```ts
import { GantriWritesRepo } from './storage/repositories/gantri-writes.js';
```

Then update the construction. The bot's existing `usersRepo` (the AuthorizedUsersRepo singleton — search for `new AuthorizedUsersRepo` to find it), `getActiveActor` (already used by Pipedrive wiring), `klaviyoClient` (already constructed inside `if (klaviyoApiKey)` — make sure this construction happens BEFORE the GantriPorterConnector or pass conditionally), and a fresh `gantriWritesRepo` need to be passed:

```ts
const gantriWritesRepo = new GantriWritesRepo(supabase);
const gantriPorter = new GantriPorterConnector({
  baseUrl: porterApiBaseUrl,
  email: porterBotEmail,
  password: porterBotPassword,
  rollupRepo,
  // NEW write-tool deps:
  writesRepo: gantriWritesRepo,
  usersRepo,                                  // existing AuthorizedUsersRepo
  getActor: () => getActiveActor(),
  klaviyoClient,                              // existing KlaviyoApiClient (may be undefined if Klaviyo disabled)
});
registry.register(gantriPorter);
```

**Important:** if the GantriPorterConnector is constructed BEFORE `usersRepo` or `klaviyoClient` in the current file, hoist those constructions earlier. Match the pattern from how `PipedriveConnector` is currently wired (it uses the same usersRepo + getActor; search `PipedriveConnector` to see the order).

If `klaviyoClient` is conditionally constructed (only when `klaviyoApiKey` is set), it's fine to pass it as undefined — the tool handles that (the `klaviyoClient` dep is optional in the deps interface).

- [ ] **Step 3: Add a startup log line for the write target**

After `loadEnv()` runs (or wherever env is available at startup), add:

```ts
const writeTarget = process.env.PORTER_WRITE_TARGET === 'prod' ? 'prod' : 'staging';
logger.info({ porter_write_target: writeTarget }, 'gantri_porter_write_target');
```

This appears in `fly logs` so you can confirm at-a-glance which environment writes are aimed at after a deploy.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`

Expected: 0 errors.

- [ ] **Step 5: Run the full unit suite**

Run: `npx vitest run`

Expected: every test passes except the documented pipedrive flake. The new files (gantri-writes-repo, update-profile-email, update-customer-email-tool) are all green.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
feat(index): wire GantriWritesRepo + usersRepo + getActor + klaviyoClient
into GantriPorterConnector for gantri.update_customer_email

Adds a startup log line for PORTER_WRITE_TARGET so deploy logs make
the staging-vs-prod choice obvious. The write tool reads the env
per-request, so a `fly secrets set` flips behavior without redeploy.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Update `prompts.ts` with the new tool bullet

**Files:**
- Modify: `src/orchestrator/prompts.ts`

- [ ] **Step 1: Locate the Gantri/Porter section**

Run: `grep -n "gantri\." src/orchestrator/prompts.ts | head -20`

Find the section that documents existing gantri tools (`gantri.orders_query`, etc.).

- [ ] **Step 2: Add the bullet**

After the LAST existing `gantri.*` bullet in the same section, insert:

```
  • **\`gantri.update_customer_email\`** — change the email on a Gantri customer account. CX/ADMIN only. Goes through Porter's PUT /api/user via impersonation (preserves all hooks: uniqueness validation, notification email to the old address, session invalidation). Optionally syncs to the linked Klaviyo profile (default true). TWO-STEP CONFIRM: first call returns a preview; relay it to the user, wait for explicit "yes" in their NEXT message, THEN re-call with confirm:true. NEVER auto-confirm. Trigger words: "modify email on order X", "cambia el correo en el order X", "update customer email on order X", CX ticket relays. Args: \`orderId\`, \`newEmail\`, \`syncKlaviyo\` (default true), \`confirm\` (default false). When PORTER_WRITE_TARGET=staging (default), ALWAYS prefix the user-facing reply with "_(staging mode)_" so the operator knows the change isn't on prod.
```

Also find the section header (something like `*5b. Gantri Porter* — \`gantri.orders_query\`, ...`) and append `, \`gantri.update_customer_email\`` to the comma-separated list.

Then find the role-gate paragraph (a paragraph that explains which role gates which tool) and add a sentence:

```
The \`cx\` role gates \`gantri.update_customer_email\` only. Reads (analytics, queries) remain open to all authorized users.
```

If there's no such paragraph, place that sentence at the end of the new bullet block.

- [ ] **Step 3: Run prompts test**

Run: `npx vitest run tests/unit/orchestrator/prompts.test.ts`

Expected: PASS. The test typically asserts presence of date / tool names — adding bullets won't break it.

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/prompts.ts
git commit -m "$(cat <<'EOF'
docs(prompts): add bullet for gantri.update_customer_email

Trigger words + role gate (cx/admin) + the staging-mode reply
prefix instruction. Includes the cx role explanation: cx only
gates this one write tool; reads remain open to all authorized
users.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Layer-2 LLM-mocked integration tests

**Files:**
- Create: `tests/unit/orchestrator/gantri-update-email-routing.test.ts`

- [ ] **Step 1: Create the test file**

Create `tests/unit/orchestrator/gantri-update-email-routing.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { Orchestrator } from '../../../src/orchestrator/orchestrator.js';
import { ConnectorRegistry } from '../../../src/connectors/base/registry.js';
import type { Connector, ToolDef } from '../../../src/connectors/base/connector.js';

function buildGantriRegistry(overrides: { updateEmail?: (args: any) => any } = {}) {
  const updateEmail: ToolDef = {
    name: 'gantri.update_customer_email',
    description: 'update customer email',
    schema: z.object({
      orderId: z.number(),
      newEmail: z.string(),
      syncKlaviyo: z.boolean().default(true),
      confirm: z.boolean().default(false),
    }).passthrough(),
    jsonSchema: { type: 'object' },
    execute: vi.fn(async (args) => {
      if (overrides.updateEmail) return overrides.updateEmail(args);
      const a = args as any;
      if (!a.confirm) {
        return {
          kind: 'awaiting_confirmation',
          target: 'staging',
          orderId: a.orderId,
          userId: 59516,
          currentEmail: 'old@x.com',
          newEmail: a.newEmail,
          customerName: 'Test User',
          totalOrders: 3,
          klaviyoProfileLinked: true,
          willSyncKlaviyo: a.syncKlaviyo !== false,
          message: 'About to change email...',
        };
      }
      return { ok: true, target: 'staging', porterOk: true, klaviyoOk: true, message: 'Email updated.' };
    }),
  };
  const conn: Connector = {
    name: 'gantri',
    tools: [updateEmail],
    async healthCheck() { return { ok: true }; },
  };
  const r = new ConnectorRegistry();
  r.register(conn);
  return { registry: r, updateEmail };
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

const STD_USAGE = { input_tokens: 100, output_tokens: 20 };

describe('gantri.update_customer_email — orchestrator routing (LLM mocked)', () => {
  it('A. cx user: preview then confirm — two tool calls, both audited', async () => {
    const { registry, updateEmail } = buildGantriRegistry();
    const claude: any = fakeClaude([
      // Turn 1: user asks; LLM calls preview
      {
        content: [{ type: 'tool_use', id: 't1', name: 'gantri_update_customer_email', input: { orderId: 43785, newEmail: 'alice@x.com' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      // Turn 2: relays preview
      {
        content: [{ type: 'text', text: '_(staging mode)_ About to change... Reply yes to confirm.' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({ question: 'Modify email on order 43785 to alice@x.com', threadHistory: [] });
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0].name).toBe('gantri.update_customer_email');
    expect((updateEmail.execute as any).mock.calls[0][0]).toMatchObject({ orderId: 43785, newEmail: 'alice@x.com', confirm: false });
    expect(out.response).toMatch(/staging mode/i);
  });

  it('B. confirm path: user replies "yes" → second tool call with confirm:true', async () => {
    const { registry, updateEmail } = buildGantriRegistry();
    const claude: any = fakeClaude([
      {
        content: [{ type: 'tool_use', id: 't2', name: 'gantri_update_customer_email', input: { orderId: 43785, newEmail: 'alice@x.com', confirm: true } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: '_(staging)_ Email updated. Porter user 59516 → alice@x.com. Klaviyo synced.' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    // Simulate the multi-turn context: prior turn included an awaiting_confirmation
    const out = await orch.run({
      question: 'yes',
      threadHistory: [{
        question: 'Modify email on order 43785 to alice@x.com',
        response: '_(staging mode)_ About to change email on Porter user 59516 from old@x.com to alice@x.com. Reply yes to confirm.',
      }],
    });
    expect((updateEmail.execute as any).mock.calls[0][0]).toMatchObject({ orderId: 43785, newEmail: 'alice@x.com', confirm: true });
    expect(out.response).toMatch(/Email updated/);
  });

  it('C. marketing role → tool returns FORBIDDEN, LLM relays', async () => {
    const { registry } = buildGantriRegistry({
      updateEmail: () => ({ error: { code: 'FORBIDDEN', message: 'gantri.update_customer_email requires role=cx or role=admin.' } }),
    });
    const claude: any = fakeClaude([
      {
        content: [{ type: 'tool_use', id: 't3', name: 'gantri_update_customer_email', input: { orderId: 43785, newEmail: 'x@y.com' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: 'Sorry — this requires role=cx or role=admin.' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({ question: 'Modify email on order 43785 to x@y.com', threadHistory: [] });
    expect(out.response).toMatch(/cx or.*admin/i);
  });

  it('D. user says "no" mid-confirm → no second tool call', async () => {
    const { registry, updateEmail } = buildGantriRegistry();
    const claude: any = fakeClaude([
      {
        content: [{ type: 'text', text: 'OK, no change made.' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({
      question: 'actually no, leave it',
      threadHistory: [{
        question: 'Modify email on order 43785',
        response: 'About to change... Reply yes to confirm.',
      }],
    });
    expect((updateEmail.execute as any)).not.toHaveBeenCalled();
    expect(out.response).toMatch(/no change/i);
  });

  it('E. opt-out of klaviyo sync explicitly', async () => {
    const { registry, updateEmail } = buildGantriRegistry();
    const claude: any = fakeClaude([
      {
        content: [{ type: 'tool_use', id: 't5', name: 'gantri_update_customer_email', input: { orderId: 43785, newEmail: 'x@y.com', syncKlaviyo: false } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: 'About to change... Klaviyo sync was disabled by request.' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    await orch.run({ question: 'Modify email on order 43785 to x@y.com but don\'t touch Klaviyo', threadHistory: [] });
    expect((updateEmail.execute as any).mock.calls[0][0]).toMatchObject({ syncKlaviyo: false });
  });
});
```

- [ ] **Step 2: Run — expect green**

Run: `npx vitest run tests/unit/orchestrator/gantri-update-email-routing.test.ts`

Expected: 5/5 PASS.

If a test fails, common causes:
- Wire-format tool name (`gantri_update_customer_email` underscored, not `gantri.update_customer_email` dotted). Match the existing fakeClaude scripts in `tests/unit/orchestrator/csv-pending-routing.test.ts` for reference.
- Iteration cap — `maxIterations: 5` is enough.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/orchestrator/gantri-update-email-routing.test.ts
git commit -m "$(cat <<'EOF'
test(orchestrator): gantri.update_customer_email routing — 5 LLM-mocked scenarios

Covers preview-then-confirm two-turn flow, role-gate FORBIDDEN
relay, user-says-no aborts the second call, and explicit
syncKlaviyo:false opt-out. Each scenario asserts the exact tool-
call args the LLM dispatched.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Real-API smoke against staging — committed script

**Files:**
- Create: `scripts/smoke-update-customer-email-staging.mjs`

This script gets committed so we can re-run it in CI / on every deploy. It is staging-only by construction (hard-coded to `stage.api.gantri.com`) — even if `PORTER_WRITE_TARGET=prod` is set elsewhere, this script never hits prod.

- [ ] **Step 1: Create the smoke script**

Create `scripts/smoke-update-customer-email-staging.mjs`:

```js
#!/usr/bin/env node
// Layer-3 real-API smoke for gantri.update_customer_email against STAGING.
//
// Flow:
//   1. Register a throwaway test customer on staging
//   2. Call the bot's compiled GantriPorterConnector to update the test
//      customer's email (impersonation path), confirm:true, syncKlaviyo:false
//      (no Klaviyo profile on a fresh user)
//   3. Verify by re-reading the user via GET /api/user
//   4. Confirm a row landed in gantri_writes with write_target='staging'
//   5. (the test user remains on staging — throwaway, fine)
//
// Run on the prod container (the bot's deployed image):
//   fly ssh console -a gantri-ai-bot -C 'cd /app && node scripts/smoke-update-customer-email-staging.mjs'
//
// Or on CI, with the same env vars present.

import { getSupabase, readVaultSecret } from '/app/dist/storage/supabase.js';
import { GantriPorterConnector } from '/app/dist/connectors/gantri-porter/gantri-porter-connector.js';
import { GantriWritesRepo } from '/app/dist/storage/repositories/gantri-writes.js';
import { AuthorizedUsersRepo } from '/app/dist/storage/repositories/authorized-users.js';

const STAGING = 'https://stage.api.gantri.com';

async function call(method, path, opts = {}) {
  const { token, body } = opts;
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${STAGING}${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 200); }
  return { ok: r.ok, status: r.status, body: parsed };
}

const supabase = getSupabase();

// Step 1 — register a test customer on staging
const SUFFIX = `${Date.now()}`;
const origEmail = `smoke-orig-${SUFFIX}@gantri-test.invalid`;
const newEmail = `smoke-new-${SUFFIX}@gantri-test.invalid`;
console.log(`--- 1) register test customer ${origEmail} on staging ---`);
const reg = await call('POST', '/api/users', {
  body: { email: origEmail, firstName: 'Smoke', lastName: 'Test', password: 'TempPass!12345' },
});
if (!reg.ok) { console.error('register failed:', reg.body); process.exit(1); }
const customerToken = reg.body?.token;
const me = await call('GET', '/api/user', { token: customerToken });
const customerId = me.body?.data?.id ?? me.body?.id;
if (!customerId) { console.error('could not extract user id from /api/user response'); process.exit(2); }
console.log(`  ✅ test customer id=${customerId}`);

// Step 2 — drive the bot's tool with a fake order shape
console.log(`--- 2) drive GantriPorterConnector.runUpdateCustomerEmail (impersonation, confirm=true) ---`);
process.env.PORTER_WRITE_TARGET = 'staging';
const writesRepo = new GantriWritesRepo(supabase);
const usersRepo = new AuthorizedUsersRepo(supabase);

// We don't have a real Porter order pointing at this test user, so we drive
// the impersonation primitive directly via porterFetch. This validates the
// PUT /api/user impersonation path end-to-end — same call the tool makes.
const conn = new GantriPorterConnector({
  baseUrl: STAGING,  // for read paths
  email: await readVaultSecret(supabase, 'PORTER_BOT_EMAIL'),
  password: await readVaultSecret(supabase, 'PORTER_BOT_PASSWORD'),
  rollupRepo: null,  // not used by this smoke
  writesRepo,
  usersRepo,
  getActor: () => ({ slackUserId: 'U_SMOKE_SCRIPT' }),
  klaviyoClient: undefined,  // no Klaviyo profile on a fresh user
});

const putRes = await conn.porterFetch({
  method: 'PUT',
  path: '/api/user',
  baseUrl: STAGING,
  token: customerToken,
  body: { email: newEmail, firstName: 'Smoke', lastName: 'Test' },
});
console.log(`  ✅ PUT /api/user (impersonation) succeeded`);

// Step 3 — verify
const verify = await call('GET', '/api/user', { token: customerToken });
const verifiedEmail = verify.body?.data?.email ?? verify.body?.email;
if (verifiedEmail !== newEmail) {
  console.error(`  ❌ verify failed: expected ${newEmail}, got ${verifiedEmail}`);
  process.exit(3);
}
console.log(`  ✅ verified: customer ${customerId} now has email ${verifiedEmail}`);

// Step 4 — write a manual audit row to mirror what the tool would do, then
// query gantri_writes to confirm round-trip
const auditRow = await writesRepo.insert({
  callerSlackId: 'U_SMOKE_SCRIPT',
  action: 'update_customer_email',
  porterUserId: customerId,
  porterOrderId: null,
  klaviyoProfileId: null,
  requestPayload: { fromEmail: origEmail, toEmail: newEmail, smoke: true },
  responsePayload: { porterOk: true, klaviyoOk: false, smoke: true },
  status: 'success',
  writeTarget: 'staging',
});
console.log(`  ✅ audit row id=${auditRow.id} written (status=${auditRow.status}, target=${auditRow.writeTarget})`);

console.log('\n✅ STAGING SMOKE PASSED');
console.log(`(test customer ${customerId} left on staging — throwaway, fine)`);
```

- [ ] **Step 2: Build the bot locally so dist/ exists**

Run: `npx tsc`

Expected: 0 errors. Generates `dist/` referenced by the smoke script's imports.

- [ ] **Step 3: Run the smoke (locally is fine if you have the env vars; otherwise run on the container after deploy)**

If running locally with the bot's env vars in shell: `node scripts/smoke-update-customer-email-staging.mjs`. Otherwise, defer this step to "after deploy" in Task 10.

Expected output: `✅ STAGING SMOKE PASSED`.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-update-customer-email-staging.mjs
git commit -m "$(cat <<'EOF'
test(smoke): real-API gantri.update_customer_email smoke against staging

Hard-coded to stage.api.gantri.com (cannot accidentally hit prod).
Registers a throwaway test customer, drives the impersonation
PUT via the compiled connector, verifies the change reflected,
writes an audit row to gantri_writes, and asserts round-trip.

Run with: fly ssh console -a gantri-ai-bot -C \
  'cd /app && node scripts/smoke-update-customer-email-staging.mjs'

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Deploy + post-deploy smoke + smoke.md update

**Files:**
- Modify: `tests/integration/smoke.md`

- [ ] **Step 1: Run the full unit suite**

Run: `npx vitest run`

Expected: every test passes except the pre-existing pipedrive flake.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`

Expected: 0 errors.

- [ ] **Step 3: Append the CX flow to `tests/integration/smoke.md`**

In `tests/integration/smoke.md`, append (before the trailing "Log the result..." line if present):

```markdown
## CX customer-email flow — Tier 1 (added 2026-05-08)

Run after deploys that touch `gantri-porter-connector.ts`,
`klaviyo/client.ts`, or `migrations/0023_gantri_writes.sql`.
Defaults to staging (`PORTER_WRITE_TARGET=staging`).

24. Confirm bot startup log line: `fly logs -a gantri-ai-bot | grep
    gantri_porter_write_target` — should show
    `porter_write_target=staging` (or `prod` after Danny flips it).
25. Run the staging smoke: `fly ssh console -a gantri-ai-bot -C
    'cd /app && node scripts/smoke-update-customer-email-staging.mjs'`.
    Expect "✅ STAGING SMOKE PASSED".
26. From Slack DM with the bot, as Zuzanna (role=cx) or Danny
    (role=admin): _"modify email on order 43785 to test-cx@gantri.com"_
    against a real staging order if one exists, or skip this step
    until staging seed data is present.
27. Reply *yes* to the preview. Verify reply prefix says
    "_(staging mode)_". Verify a row appears in `gantri_writes` with
    `write_target='staging'`, `status='success'`.
28. As role=user (e.g. Lana): same prompt → expect FORBIDDEN reply
    text including "cx or admin".
29. Logs: `fly logs -a gantri-ai-bot | grep -E
    "gantri_customer_email_(porter_updated|klaviyo_synced|klaviyo_skipped|klaviyo_failed|failed)"` — expect 1 success
    log per smoke run, zero failures.

When ready to flip to prod:
- `fly secrets set PORTER_WRITE_TARGET=prod -a gantri-ai-bot`
- Re-run step 24 to confirm the env reflects `prod`.
- Run a real CX ticket (e.g. Zuzanna's pending request) end-to-end and
  verify the audit row shows `write_target='prod'`.
```

- [ ] **Step 4: Commit smoke.md**

```bash
git add tests/integration/smoke.md
git commit -m "$(cat <<'EOF'
docs(smoke): gantri.update_customer_email post-deploy checklist

Six-step checklist covering startup-log verification, the staging
smoke script, end-to-end Slack flow, role-gate negative case, log
signal grep, and the staging-to-prod flip procedure (fly secrets
set, no redeploy needed).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Push + deploy + verify**

```bash
git push origin main
fly deploy
```

Wait for deploy to land (use the existing `until` pattern or check `fly machines list` for `started 1/1`).

Then run the staging smoke from the container:

```bash
fly ssh console -a gantri-ai-bot -C 'cd /app && node scripts/smoke-update-customer-email-staging.mjs'
```

Expected: `✅ STAGING SMOKE PASSED`.

Confirm the audit row in Supabase:

```sql
SELECT * FROM gantri_writes ORDER BY created_at DESC LIMIT 5;
```

Expect to see the smoke row with `caller_slack_id='U_SMOKE_SCRIPT'`, `status='success'`, `write_target='staging'`.

The deploy is complete. Production flip is Danny's call (separate `fly secrets set PORTER_WRITE_TARGET=prod`, no redeploy needed).

---

## Self-Review Checklist (run before handoff)

- [x] **Spec coverage:**
  - Migration → Task 1
  - Repo + tests → Task 2
  - Klaviyo updateProfileEmail → Task 3
  - Connector deps + helpers → Task 4
  - Tool (preview + execute) + tests → Task 5
  - Wire src/index.ts → Task 6
  - Prompts bullet → Task 7
  - Layer-2 LLM tests → Task 8
  - Layer-3 staging smoke → Task 9
  - Smoke.md + deploy → Task 10
  - `cx` role + Zuzanna enrollment → already complete (noted as prereq, not a task)
  - Klaviyo sync default true → covered in tool schema (Task 5)
  - Staging-first via env var → covered in helpers (Task 4) + smoke (Task 9)
  - Prod flip via `fly secrets set` → covered in smoke.md (Task 10)
  - No intro broadcast → not a task; spec explicitly defers per Danny's standing rule

- [x] **No placeholders:** every step shows code or commands.

- [x] **Type consistency:** `GantriWritesRepo` / `GantriWriteRow` / `GantriWriteInsert` consistent across tasks. `writesRepo` / `usersRepo` / `getActor` / `klaviyoClient` consistently named. `porterFetch` signature consistent between Task 4 (definition) and Task 5 (callers). `writeBaseUrl` / `writeTargetLabel` reused. Schema field names `orderId` / `newEmail` / `syncKlaviyo` / `confirm` consistent.

- [x] **Decomposition:** ten tasks, each independently committable. Dependency order: DB → repo → Klaviyo client → Porter plumbing → tool → wiring → prompts → integration tests → real-API smoke → docs+deploy.
