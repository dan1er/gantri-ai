# Pipedrive Write Tools — Tier 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three write tools to the gantri-ai-bot's Pipedrive connector — `pipedrive.create_lead`, `pipedrive.add_note`, `pipedrive.create_activity` — gated by `role IN ('admin','marketing')` and audited via a new `pipedrive_writes` table.

**Architecture:**
- Pipedrive REST writes happen through extensions to the existing `PipedriveApiClient` (no new client class — same auth, same rate limiter, same retry helper).
- A new `PipedriveWritesRepo` records every write (success and failure) with the Slack caller id.
- The `PipedriveConnector` constructor accepts three new deps (`writesRepo`, `usersRepo`, `getActor`) — same shape Klaviyo's connector already uses.
- `pipedrive.create_lead` runs an internal find-or-create flow for person + organization before creating the lead, so duplicates are minimized.

**Tech Stack:** TypeScript, Node 20, Vitest, Anthropic SDK (mocked in integration tests), Supabase (writes audit table), Pipedrive REST v1.

**Spec:** `docs/superpowers/specs/2026-05-07-pipedrive-write-tools-tier1-design.md`

---

## File Map

**Create:**
- `migrations/0018_pipedrive_writes.sql` — DB migration
- `src/storage/repositories/pipedrive-writes.ts` — audit row repo
- `tests/unit/storage/pipedrive-writes-repo.test.ts` — repo tests
- `tests/unit/connectors/pipedrive/client-write.test.ts` — write-method tests
- `tests/unit/connectors/pipedrive/lead-tool.test.ts` — `create_lead` tool tests
- `tests/unit/connectors/pipedrive/note-tool.test.ts` — `add_note` tool tests
- `tests/unit/connectors/pipedrive/activity-tool.test.ts` — `create_activity` tool tests
- `tests/unit/orchestrator/pipedrive-write-routing.test.ts` — LLM-mocked end-to-end tests

**Modify:**
- `src/connectors/pipedrive/client.ts` — add `requestWrite`, `findPersonByEmail`, `findOrganizationByName`, `createPerson`, `createOrganization`, `createLead`, `createNote`, `createActivity`
- `src/connectors/pipedrive/connector.ts` — extend `PipedriveConnectorDeps`, add three tool definitions
- `src/index.ts` — instantiate `PipedriveWritesRepo`, pass new deps to `PipedriveConnector`
- `src/orchestrator/prompts.ts` — add three bullets in the Pipedrive section
- `src/connectors/broadcast/intro-message.ts` — add Pipedrive write callout after the read examples block
- `tests/integration/smoke.md` — add 6-step manual smoke checklist

---

## Conventions for this plan

- All commands assume CWD `/Users/danierestevez/Documents/work/gantri/gantri-ai-bot`.
- Run a single test file with `npx vitest run <path>`.
- Each task ends with a commit. Commit prefixes: `feat()`, `refactor()`, `test()`, `docs()`. Include the `Co-Authored-By: Claude Opus 4.7 (1M context)` trailer.
- Migrations are applied via `mcp__supabase__apply_migration` against project `ykjjwszoxazzlcovhlgd`. Verify with a quick `information_schema` query.
- Pipedrive lead ids are UUIDs (string); deal/person/org/activity ids are integers (cast to string for the `pipedrive_resource_id` text column).
- Pre-existing pipedrive flake at `tests/unit/connectors/pipedrive/connector.test.ts:348` (organization_performance Bilotti row ordering) is NOT introduced by this plan — confirmed at base SHA `3c206de`. It's the only acceptable failure throughout these tasks.

---

### Task 1: DB migration — `pipedrive_writes` audit table

**Files:**
- Create: `migrations/0018_pipedrive_writes.sql`

- [ ] **Step 1: Write the migration**

Create `migrations/0018_pipedrive_writes.sql`:

```sql
-- One row per Pipedrive write triggered from the bot. Used to forensically
-- map a Slack user → the Pipedrive resource they created (Pipedrive's own
-- creator/timestamp logs only the API token's user, not the actual operator).

CREATE TABLE IF NOT EXISTS pipedrive_writes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_slack_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('create_lead', 'add_note', 'create_activity')),
  pipedrive_resource_type text CHECK (
    pipedrive_resource_type IS NULL OR
    pipedrive_resource_type IN ('lead', 'note', 'activity', 'person', 'organization')
  ),
  pipedrive_resource_id text,
  request_payload jsonb NOT NULL,
  response_payload jsonb,
  status text NOT NULL CHECK (status IN ('success', 'failure')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pipedrive_writes_caller_idx
  ON pipedrive_writes (caller_slack_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pipedrive_writes_resource_idx
  ON pipedrive_writes (pipedrive_resource_type, pipedrive_resource_id);
```

- [ ] **Step 2: Apply via the Supabase MCP tool**

Run the migration through `mcp__supabase__apply_migration` (project_id `ykjjwszoxazzlcovhlgd`). Pass the file contents verbatim. Expected: success.

- [ ] **Step 3: Verify the table exists**

Run via `mcp__supabase__execute_sql`:
```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'pipedrive_writes'
ORDER BY ordinal_position;
```

Expected rows: `id (uuid, NO)`, `caller_slack_id (text, NO)`, `action (text, NO)`, `pipedrive_resource_type (text, YES)`, `pipedrive_resource_id (text, YES)`, `request_payload (jsonb, NO)`, `response_payload (jsonb, YES)`, `status (text, NO)`, `created_at (timestamp with time zone, NO)`.

- [ ] **Step 4: Commit the SQL file**

```bash
git add migrations/0018_pipedrive_writes.sql
git commit -m "$(cat <<'EOF'
feat(db): pipedrive_writes audit table for tier 1 write tools

Records every Pipedrive write triggered from the bot with the Slack
caller id. Pipedrive's own logs track the API token's user; this table
is the only place Slack user → Pipedrive resource is recorded.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `PipedriveWritesRepo` + tests

**Files:**
- Create: `src/storage/repositories/pipedrive-writes.ts`
- Create: `tests/unit/storage/pipedrive-writes-repo.test.ts`

- [ ] **Step 1: Write the repo test**

Create `tests/unit/storage/pipedrive-writes-repo.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { PipedriveWritesRepo } from '../../../src/storage/repositories/pipedrive-writes.js';

function makeMockSupabase(rows: any[] = []) {
  const insertedRows: any[] = [];
  const supabase = {
    from: vi.fn().mockReturnThis(),
    insert: vi.fn(function (this: any, row: any) {
      const inserted = { ...row, id: 'row-uuid', created_at: '2026-05-07T12:00:00Z' };
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

describe('PipedriveWritesRepo', () => {
  it('insert round-trips the row with status, payload, and resource ids', async () => {
    const { supabase, insertedRows } = makeMockSupabase();
    const repo = new PipedriveWritesRepo(supabase);
    const row = await repo.insert({
      callerSlackId: 'U1',
      action: 'create_lead',
      pipedriveResourceType: 'lead',
      pipedriveResourceId: 'lead-uuid-1',
      requestPayload: { title: 'Foo Studio' },
      responsePayload: { id: 'lead-uuid-1' },
      status: 'success',
    });
    expect(row.id).toBe('row-uuid');
    expect(insertedRows[0].caller_slack_id).toBe('U1');
    expect(insertedRows[0].action).toBe('create_lead');
    expect(insertedRows[0].pipedrive_resource_type).toBe('lead');
    expect(insertedRows[0].pipedrive_resource_id).toBe('lead-uuid-1');
    expect(insertedRows[0].status).toBe('success');
  });

  it('insert with status=failure also records', async () => {
    const { supabase, insertedRows } = makeMockSupabase();
    const repo = new PipedriveWritesRepo(supabase);
    await repo.insert({
      callerSlackId: 'U1',
      action: 'add_note',
      pipedriveResourceType: null,
      pipedriveResourceId: null,
      requestPayload: { targetType: 'lead', targetId: 'x', content: 'y' },
      responsePayload: { error: { code: 'PIPEDRIVE_ERROR', status: 400 } },
      status: 'failure',
    });
    expect(insertedRows[0].status).toBe('failure');
    expect(insertedRows[0].pipedrive_resource_id).toBeNull();
  });

  it('listForCaller queries by caller_slack_id desc by created_at with limit', async () => {
    const { supabase } = makeMockSupabase([
      { id: 'r1', caller_slack_id: 'U1', action: 'create_lead', pipedrive_resource_type: 'lead', pipedrive_resource_id: 'l1', request_payload: {}, response_payload: {}, status: 'success', created_at: '2026-05-07T12:00:00Z' },
    ]);
    const repo = new PipedriveWritesRepo(supabase);
    const rows = await repo.listForCaller('U1', 5);
    expect(supabase.from).toHaveBeenCalledWith('pipedrive_writes');
    expect(supabase.eq).toHaveBeenCalledWith('caller_slack_id', 'U1');
    expect(supabase.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(supabase.limit).toHaveBeenCalledWith(5);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('create_lead');
  });
});
```

- [ ] **Step 2: Run — expect failures (file doesn't exist yet)**

Run: `npx vitest run tests/unit/storage/pipedrive-writes-repo.test.ts`

Expected: FAIL with `Cannot find module '.../pipedrive-writes.js'`.

- [ ] **Step 3: Write the repo**

Create `src/storage/repositories/pipedrive-writes.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';

export interface PipedriveWriteRow {
  id: string;
  callerSlackId: string;
  action: 'create_lead' | 'add_note' | 'create_activity';
  pipedriveResourceType: 'lead' | 'note' | 'activity' | 'person' | 'organization' | null;
  pipedriveResourceId: string | null;
  requestPayload: unknown;
  responsePayload: unknown;
  status: 'success' | 'failure';
  createdAt: string;
}

export interface PipedriveWriteInsert {
  callerSlackId: string;
  action: PipedriveWriteRow['action'];
  pipedriveResourceType: PipedriveWriteRow['pipedriveResourceType'];
  pipedriveResourceId: PipedriveWriteRow['pipedriveResourceId'];
  requestPayload: unknown;
  responsePayload: unknown;
  status: PipedriveWriteRow['status'];
}

export class PipedriveWritesRepo {
  constructor(private readonly client: SupabaseClient) {}

  async insert(input: PipedriveWriteInsert): Promise<PipedriveWriteRow> {
    const { data, error } = await this.client
      .from('pipedrive_writes')
      .insert({
        caller_slack_id: input.callerSlackId,
        action: input.action,
        pipedrive_resource_type: input.pipedriveResourceType,
        pipedrive_resource_id: input.pipedriveResourceId,
        request_payload: input.requestPayload,
        response_payload: input.responsePayload,
        status: input.status,
      })
      .select('id, caller_slack_id, action, pipedrive_resource_type, pipedrive_resource_id, request_payload, response_payload, status, created_at')
      .single();
    if (error) throw new Error(`pipedrive_writes insert failed: ${error.message}`);
    return mapRow(data);
  }

  async listForCaller(slackUserId: string, limit = 50): Promise<PipedriveWriteRow[]> {
    const { data, error } = await this.client
      .from('pipedrive_writes')
      .select('id, caller_slack_id, action, pipedrive_resource_type, pipedrive_resource_id, request_payload, response_payload, status, created_at')
      .eq('caller_slack_id', slackUserId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`pipedrive_writes list failed: ${error.message}`);
    return (data ?? []).map(mapRow);
  }
}

function mapRow(r: any): PipedriveWriteRow {
  return {
    id: r.id,
    callerSlackId: r.caller_slack_id,
    action: r.action,
    pipedriveResourceType: r.pipedrive_resource_type ?? null,
    pipedriveResourceId: r.pipedrive_resource_id ?? null,
    requestPayload: r.request_payload,
    responsePayload: r.response_payload ?? null,
    status: r.status,
    createdAt: r.created_at,
  };
}
```

- [ ] **Step 4: Run — expect green**

Run: `npx vitest run tests/unit/storage/pipedrive-writes-repo.test.ts`

Expected: 3/3 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/repositories/pipedrive-writes.ts tests/unit/storage/pipedrive-writes-repo.test.ts
git commit -m "$(cat <<'EOF'
feat(repo): PipedriveWritesRepo for the tier 1 audit table

insert + listForCaller. Mirrors the shape of klaviyo-imports-repo
(same supabase client pattern, same row-mapper helper).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Client write surface — extend `PipedriveApiClient`

**Files:**
- Modify: `src/connectors/pipedrive/client.ts`
- Create: `tests/unit/connectors/pipedrive/client-write.test.ts`

- [ ] **Step 1: Write the client tests**

Create `tests/unit/connectors/pipedrive/client-write.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { PipedriveApiClient } from '../../../../src/connectors/pipedrive/client.js';

function fakeFetch(handler: (url: string, init?: any) => Promise<Response>) {
  return vi.fn(handler) as unknown as typeof fetch;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('PipedriveApiClient — write methods', () => {
  it('findPersonByEmail returns first hit when search has results', async () => {
    const fetchImpl = fakeFetch(async (url) => {
      expect(url).toContain('/v1/persons/search');
      expect(url).toContain('term=jane%40foo.com');
      expect(url).toContain('fields=email');
      expect(url).toContain('exact_match=true');
      return jsonRes({ success: true, data: { items: [{ item: { id: 9012, name: 'Jane Doe' } }] } });
    });
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const r = await client.findPersonByEmail('jane@foo.com');
    expect(r).toEqual({ id: 9012, name: 'Jane Doe' });
  });

  it('findPersonByEmail returns null on empty results', async () => {
    const fetchImpl = fakeFetch(async () => jsonRes({ success: true, data: { items: [] } }));
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const r = await client.findPersonByEmail('nobody@foo.com');
    expect(r).toBeNull();
  });

  it('findOrganizationByName returns first hit', async () => {
    const fetchImpl = fakeFetch(async (url) => {
      expect(url).toContain('/v1/organizations/search');
      return jsonRes({ success: true, data: { items: [{ item: { id: 7843, name: 'Foo Studio' } }] } });
    });
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const r = await client.findOrganizationByName('Foo Studio');
    expect(r).toEqual({ id: 7843, name: 'Foo Studio' });
  });

  it('createPerson POSTs the right body', async () => {
    const fetchImpl = fakeFetch(async (url, init) => {
      expect(url).toMatch(/\/v1\/persons$/);
      expect(init?.method).toBe('POST');
      expect(init?.headers?.['content-type']).toBe('application/json');
      const body = JSON.parse(init?.body as string);
      expect(body.name).toBe('Jane Doe');
      expect(body.email).toEqual([{ value: 'jane@foo.com', primary: true, label: 'work' }]);
      expect(body.phone).toEqual([{ value: '+1 415 555 0101', primary: true, label: 'work' }]);
      expect(body.org_id).toBe(7843);
      return jsonRes({ success: true, data: { id: 9012, name: 'Jane Doe' } });
    });
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const r = await client.createPerson({ name: 'Jane Doe', email: 'jane@foo.com', phone: '+1 415 555 0101', orgId: 7843 });
    expect(r).toEqual({ id: 9012, name: 'Jane Doe' });
  });

  it('createOrganization POSTs name', async () => {
    const fetchImpl = fakeFetch(async (url, init) => {
      expect(url).toMatch(/\/v1\/organizations$/);
      const body = JSON.parse(init?.body as string);
      expect(body.name).toBe('Foo Studio');
      return jsonRes({ success: true, data: { id: 7843, name: 'Foo Studio' } });
    });
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const r = await client.createOrganization({ name: 'Foo Studio' });
    expect(r).toEqual({ id: 7843, name: 'Foo Studio' });
  });

  it('createLead POSTs title + person_id + org_id + value', async () => {
    const fetchImpl = fakeFetch(async (url, init) => {
      expect(url).toMatch(/\/v1\/leads$/);
      const body = JSON.parse(init?.body as string);
      expect(body.title).toBe('Foo Studio');
      expect(body.person_id).toBe(9012);
      expect(body.organization_id).toBe(7843);
      expect(body.value).toEqual({ amount: 5000, currency: 'USD' });
      expect(body.label_ids).toEqual(['lbl-1']);
      expect(body.expected_close_date).toBe('2026-06-30');
      return jsonRes({ success: true, data: { id: 'lead-uuid', title: 'Foo Studio', person_id: 9012, organization_id: 7843 } });
    });
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const r = await client.createLead({
      title: 'Foo Studio',
      personId: 9012,
      orgId: 7843,
      value: { amount: 5000, currency: 'USD' },
      labelIds: ['lbl-1'],
      expectedCloseDate: '2026-06-30',
    });
    expect(r.id).toBe('lead-uuid');
  });

  it('createNote with lead_id (UUID) — sets lead_id field', async () => {
    const fetchImpl = fakeFetch(async (url, init) => {
      expect(url).toMatch(/\/v1\/notes$/);
      const body = JSON.parse(init?.body as string);
      expect(body.content).toBe('hello');
      expect(body.lead_id).toBe('lead-uuid');
      expect(body.deal_id).toBeUndefined();
      return jsonRes({ success: true, data: { id: 5511, content: 'hello' } });
    });
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const r = await client.createNote({ content: 'hello', leadId: 'lead-uuid' });
    expect(r.id).toBe(5511);
  });

  it('createNote with deal_id (integer)', async () => {
    const fetchImpl = fakeFetch(async (url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.deal_id).toBe(123);
      expect(body.lead_id).toBeUndefined();
      return jsonRes({ success: true, data: { id: 5512, content: 'h' } });
    });
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    await client.createNote({ content: 'h', dealId: 123 });
  });

  it('createActivity POSTs subject + type + due_* + lead_id', async () => {
    const fetchImpl = fakeFetch(async (url, init) => {
      expect(url).toMatch(/\/v1\/activities$/);
      const body = JSON.parse(init?.body as string);
      expect(body.subject).toBe('Follow up');
      expect(body.type).toBe('call');
      expect(body.due_date).toBe('2026-05-12');
      expect(body.due_time).toBe('15:00');
      expect(body.duration).toBe('00:30');
      expect(body.note).toBe('Talk pricing');
      expect(body.lead_id).toBe('lead-uuid');
      expect(body.user_id).toBe(42);
      return jsonRes({ success: true, data: { id: 8801, subject: 'Follow up' } });
    });
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl });
    const r = await client.createActivity({
      subject: 'Follow up',
      type: 'call',
      dueDate: '2026-05-12',
      dueTime: '15:00',
      durationMinutes: 30,
      note: 'Talk pricing',
      leadId: 'lead-uuid',
      userId: 42,
    });
    expect(r.id).toBe(8801);
  });

  it('write surface retries once on 429 then succeeds', async () => {
    let calls = 0;
    const fetchImpl = fakeFetch(async () => {
      calls += 1;
      if (calls === 1) return new Response('rate limited', { status: 429 });
      return jsonRes({ success: true, data: { id: 9999, name: 'Foo' } });
    });
    const client = new PipedriveApiClient({ apiToken: 'tok', fetchImpl, retryDelayMs: 1 });
    const r = await client.createOrganization({ name: 'Foo' });
    expect(r.id).toBe(9999);
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 2: Run — expect failures (methods don't exist yet)**

Run: `npx vitest run tests/unit/connectors/pipedrive/client-write.test.ts`

Expected: FAIL — `client.findPersonByEmail is not a function` etc.

- [ ] **Step 3: Add the write surface to `client.ts`**

Open `src/connectors/pipedrive/client.ts`. Find the existing `private async request<T>(...)` method (around line 225). After `paginateV2()` ends (around line 290-300, before the closing `}` of the class), add the following methods. They reuse `this.fetchImpl`, `this.headers()`, `this.baseUrl`, and `this.retryDelayMs`.

```ts
  /** Single-attempt POST that throws on 4xx/5xx (caller wraps with retry). */
  private async fetchOncePost(url: string, body: unknown): Promise<Response> {
    return this.fetchImpl(url, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** POST with one retry on 429/5xx. `path` starts with `/`. Returns parsed JSON `data` field. */
  private async requestWrite<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const t0 = Date.now();
    let res = await this.fetchOncePost(url, body);
    if (res.status === 429 || res.status >= 500) {
      logger.warn({ path, status: res.status }, 'pipedrive transient write error — retrying once');
      await new Promise((r) => setTimeout(r, this.retryDelayMs));
      res = await this.fetchOncePost(url, body);
    }
    const elapsed = Date.now() - t0;
    if (!res.ok) {
      let errBody: unknown = null;
      try { errBody = await res.clone().json(); } catch { errBody = await res.clone().text().catch(() => null); }
      logger.warn({ path, status: res.status, elapsed, body: errBody }, 'pipedrive write api error');
      throw new PipedriveApiError(`POST ${path} -> ${res.status}`, res.status, errBody);
    }
    const json = await res.clone().json();
    logger.info({ path, status: res.status, elapsed }, 'pipedrive write api ok');
    // Pipedrive v1 wraps the resource as { success, data }
    return (json as { data: T }).data;
  }

  // ─── search helpers ──────────────────────────────────────────────────────

  async findPersonByEmail(email: string): Promise<{ id: number; name: string } | null> {
    const path = '/v1/persons/search';
    const params = new URLSearchParams({ term: email, fields: 'email', exact_match: 'true', limit: '5' });
    const url = `${this.baseUrl}${path}?${params.toString()}`;
    const res = await this.fetchImpl(url, { method: 'GET', headers: this.headers() });
    if (!res.ok) {
      let body: unknown = null;
      try { body = await res.clone().json(); } catch {}
      throw new PipedriveApiError(`GET ${path} -> ${res.status}`, res.status, body);
    }
    const json = await res.clone().json() as { success: boolean; data?: { items?: Array<{ item: { id: number; name: string } }> } };
    const item = json.data?.items?.[0]?.item;
    return item ? { id: item.id, name: item.name } : null;
  }

  async findOrganizationByName(name: string): Promise<{ id: number; name: string } | null> {
    const path = '/v1/organizations/search';
    const params = new URLSearchParams({ term: name, exact_match: 'true', limit: '5' });
    const url = `${this.baseUrl}${path}?${params.toString()}`;
    const res = await this.fetchImpl(url, { method: 'GET', headers: this.headers() });
    if (!res.ok) {
      let body: unknown = null;
      try { body = await res.clone().json(); } catch {}
      throw new PipedriveApiError(`GET ${path} -> ${res.status}`, res.status, body);
    }
    const json = await res.clone().json() as { success: boolean; data?: { items?: Array<{ item: { id: number; name: string } }> } };
    const item = json.data?.items?.[0]?.item;
    return item ? { id: item.id, name: item.name } : null;
  }

  // ─── create helpers ──────────────────────────────────────────────────────

  async createPerson(input: { name: string; email?: string; phone?: string; orgId?: number }): Promise<{ id: number; name: string }> {
    const body: Record<string, unknown> = { name: input.name };
    if (input.email) body.email = [{ value: input.email, primary: true, label: 'work' }];
    if (input.phone) body.phone = [{ value: input.phone, primary: true, label: 'work' }];
    if (input.orgId !== undefined) body.org_id = input.orgId;
    const r = await this.requestWrite<{ id: number; name: string }>('/v1/persons', body);
    return { id: r.id, name: r.name };
  }

  async createOrganization(input: { name: string }): Promise<{ id: number; name: string }> {
    const r = await this.requestWrite<{ id: number; name: string }>('/v1/organizations', { name: input.name });
    return { id: r.id, name: r.name };
  }

  async createLead(input: {
    title: string;
    personId?: number;
    orgId?: number;
    ownerId?: number;
    value?: { amount: number; currency: string };
    expectedCloseDate?: string;
    labelIds?: string[];
  }): Promise<{ id: string; title: string; person_id: number | null; organization_id: number | null }> {
    const body: Record<string, unknown> = { title: input.title };
    if (input.personId !== undefined) body.person_id = input.personId;
    if (input.orgId !== undefined) body.organization_id = input.orgId;
    if (input.ownerId !== undefined) body.owner_id = input.ownerId;
    if (input.value) body.value = input.value;
    if (input.expectedCloseDate) body.expected_close_date = input.expectedCloseDate;
    if (input.labelIds?.length) body.label_ids = input.labelIds;
    return this.requestWrite('/v1/leads', body);
  }

  async createNote(input: {
    content: string;
    leadId?: string;
    dealId?: number;
    personId?: number;
    orgId?: number;
  }): Promise<{ id: number; content: string }> {
    const body: Record<string, unknown> = { content: input.content };
    if (input.leadId) body.lead_id = input.leadId;
    if (input.dealId !== undefined) body.deal_id = input.dealId;
    if (input.personId !== undefined) body.person_id = input.personId;
    if (input.orgId !== undefined) body.org_id = input.orgId;
    return this.requestWrite('/v1/notes', body);
  }

  async createActivity(input: {
    subject: string;
    type: string;
    dueDate?: string;
    dueTime?: string;
    durationMinutes?: number;
    note?: string;
    leadId?: string;
    dealId?: number;
    personId?: number;
    orgId?: number;
    userId?: number;
  }): Promise<{ id: number; subject: string }> {
    const body: Record<string, unknown> = { subject: input.subject, type: input.type };
    if (input.dueDate) body.due_date = input.dueDate;
    if (input.dueTime) body.due_time = input.dueTime;
    if (input.durationMinutes !== undefined) {
      // Pipedrive expects HH:MM string, NOT integer minutes.
      const h = Math.floor(input.durationMinutes / 60);
      const m = input.durationMinutes % 60;
      body.duration = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
    if (input.note) body.note = input.note;
    if (input.leadId) body.lead_id = input.leadId;
    if (input.dealId !== undefined) body.deal_id = input.dealId;
    if (input.personId !== undefined) body.person_id = input.personId;
    if (input.orgId !== undefined) body.org_id = input.orgId;
    if (input.userId !== undefined) body.user_id = input.userId;
    return this.requestWrite('/v1/activities', body);
  }
```

- [ ] **Step 4: Run write tests — expect green**

Run: `npx vitest run tests/unit/connectors/pipedrive/client-write.test.ts`

Expected: 9/9 PASS.

- [ ] **Step 5: Run all pipedrive tests to confirm no read-side regression**

Run: `npx vitest run tests/unit/connectors/pipedrive/`

Expected: all PASS except the documented pre-existing flake at `connector.test.ts:348` (organization_performance Bilotti row ordering — not affected by this change).

- [ ] **Step 6: Commit**

```bash
git add src/connectors/pipedrive/client.ts tests/unit/connectors/pipedrive/client-write.test.ts
git commit -m "$(cat <<'EOF'
feat(pipedrive): client write surface for tier 1

Adds requestWrite (POST + retry) plus seven write helpers:
findPersonByEmail, findOrganizationByName, createPerson,
createOrganization, createLead, createNote, createActivity. All reuse
the existing fetch + retry plumbing; no new auth path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `pipedrive.create_lead` tool

**Files:**
- Modify: `src/connectors/pipedrive/connector.ts` (extend deps + add tool)
- Create: `tests/unit/connectors/pipedrive/lead-tool.test.ts`

- [ ] **Step 1: Write the lead-tool tests**

Create `tests/unit/connectors/pipedrive/lead-tool.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { PipedriveConnector } from '../../../../src/connectors/pipedrive/connector.js';

interface Opts {
  callerRole?: 'admin' | 'marketing' | 'user' | null;
  findPerson?: any;
  findOrg?: any;
  createPerson?: any;
  createOrg?: any;
  createLead?: any;
  createNote?: any;
}

function makeDeps(opts: Opts = {}) {
  const insertedRows: any[] = [];
  return {
    client: {
      // read methods (unused by lead tool but typed)
      listPipelines: vi.fn(), listStages: vi.fn(), listUsers: vi.fn(),
      listDealFields: vi.fn(), listSourceOptions: vi.fn(),
      // write methods
      findPersonByEmail: opts.findPerson ?? vi.fn().mockResolvedValue(null),
      findOrganizationByName: opts.findOrg ?? vi.fn().mockResolvedValue(null),
      createPerson: opts.createPerson ?? vi.fn().mockResolvedValue({ id: 9012, name: 'Jane Doe' }),
      createOrganization: opts.createOrg ?? vi.fn().mockResolvedValue({ id: 7843, name: 'Foo Studio' }),
      createLead: opts.createLead ?? vi.fn().mockResolvedValue({ id: 'lead-uuid', title: 'Foo Studio', person_id: 9012, organization_id: 7843 }),
      createNote: opts.createNote ?? vi.fn().mockResolvedValue({ id: 5511, content: 'note' }),
    } as any,
    writesRepo: {
      insert: vi.fn(async (row: any) => { insertedRows.push(row); return { id: 'audit-row', ...row, createdAt: 'now' }; }),
    } as any,
    usersRepo: {
      getRole: vi.fn().mockResolvedValue(opts.callerRole === undefined ? 'marketing' : opts.callerRole),
    } as any,
    getActor: vi.fn().mockReturnValue({ slackUserId: 'U_LANA', slackChannelId: 'D1' }),
    insertedRows,
  };
}

function getTool(deps: any) {
  const conn = new PipedriveConnector(deps);
  return conn.tools.find((t) => t.name === 'pipedrive.create_lead')!;
}

describe('pipedrive.create_lead', () => {
  it('marketing role → creates new person + new org + lead', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({
      title: 'Foo Studio',
      personEmail: 'jane@foo.com',
      personName: 'Jane Doe',
      orgName: 'Foo Studio',
      value: 5000,
      currency: 'USD',
    });
    expect((r as any).leadId).toBe('lead-uuid');
    expect((r as any).personCreated).toBe(true);
    expect((r as any).orgCreated).toBe(true);
    expect(deps.client.findPersonByEmail).toHaveBeenCalledWith('jane@foo.com');
    expect(deps.client.createPerson).toHaveBeenCalledWith({ name: 'Jane Doe', email: 'jane@foo.com', phone: undefined, orgId: 7843 });
    expect(deps.client.createOrganization).toHaveBeenCalledWith({ name: 'Foo Studio' });
    expect(deps.client.createLead).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Foo Studio', personId: 9012, orgId: 7843, value: { amount: 5000, currency: 'USD' },
    }));
    expect(deps.writesRepo.insert).toHaveBeenCalled();
    expect(deps.insertedRows[0].action).toBe('create_lead');
    expect(deps.insertedRows[0].status).toBe('success');
    expect(deps.insertedRows[0].pipedriveResourceId).toBe('lead-uuid');
  });

  it('email matches existing person → reuses, personCreated=false', async () => {
    const deps = makeDeps({
      findPerson: vi.fn().mockResolvedValue({ id: 4521, name: 'Jane Doe' }),
    });
    const r = await getTool(deps).execute({
      title: 'Lead — Jane',
      personEmail: 'jane@foo.com',
    });
    expect((r as any).personId).toBe(4521);
    expect((r as any).personCreated).toBe(false);
    expect(deps.client.createPerson).not.toHaveBeenCalled();
  });

  it('orgName exact match → reuses, orgCreated=false', async () => {
    const deps = makeDeps({
      findOrg: vi.fn().mockResolvedValue({ id: 9999, name: 'Foo Studio' }),
    });
    const r = await getTool(deps).execute({
      title: 'Foo Studio',
      personEmail: 'jane@foo.com',
      orgName: 'Foo Studio',
    });
    expect((r as any).orgId).toBe(9999);
    expect((r as any).orgCreated).toBe(false);
    expect(deps.client.createOrganization).not.toHaveBeenCalled();
  });

  it('FORBIDDEN for role=user, no Pipedrive call made', async () => {
    const deps = makeDeps({ callerRole: 'user' });
    const r = await getTool(deps).execute({ title: 'X', personEmail: 'x@y.com' });
    expect((r as any).error.code).toBe('FORBIDDEN');
    expect(deps.client.createLead).not.toHaveBeenCalled();
    expect(deps.writesRepo.insert).not.toHaveBeenCalled();
  });

  it('schema rejects title with no person/org info', () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    expect(() => tool.schema.parse({ title: 'just a title' })).toThrow();
  });

  it('Pipedrive 400 on createLead → audit failure with partial=true (person/org leaked)', async () => {
    const deps = makeDeps({
      createLead: vi.fn().mockRejectedValue(Object.assign(new Error('bad request'), { status: 400, body: { error: 'bad' } })),
    });
    const r = await getTool(deps).execute({
      title: 'X',
      personEmail: 'jane@foo.com',
      orgName: 'Foo Studio',
    });
    expect((r as any).error.code).toBe('PIPEDRIVE_ERROR');
    expect(deps.insertedRows[0].status).toBe('failure');
    expect(deps.insertedRows[0].responsePayload).toMatchObject({
      partial: true,
      personIdLeaked: 9012,
      orgIdLeaked: 7843,
    });
  });

  it('note attached after lead creation; note failure does not roll back', async () => {
    const deps = makeDeps({
      createNote: vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { status: 500 })),
    });
    const r = await getTool(deps).execute({
      title: 'X',
      personEmail: 'jane@foo.com',
      note: 'they want matte black',
    });
    expect((r as any).leadId).toBe('lead-uuid');
    expect((r as any).noteSubmitted).toBe(false);
    expect((r as any).noteError).toMatch(/boom/);
  });
});
```

- [ ] **Step 2: Run — expect failures (deps schema mismatch + tool not present)**

Run: `npx vitest run tests/unit/connectors/pipedrive/lead-tool.test.ts`

Expected: FAIL — `tools.find(...)` returns undefined for `pipedrive.create_lead`; constructor likely throws on extra deps.

- [ ] **Step 3: Extend `PipedriveConnectorDeps` + add tool**

Open `src/connectors/pipedrive/connector.ts`. Replace the deps interface (around line 25):

```ts
export interface PipedriveConnectorDeps {
  client: PipedriveApiClient;
  /** When omitted, write tools fail with WRITE_DEPS_NOT_CONFIGURED. */
  writesRepo?: import('../../storage/repositories/pipedrive-writes.js').PipedriveWritesRepo;
  /** When omitted, write tools fail with WRITE_DEPS_NOT_CONFIGURED. */
  usersRepo?: import('../../storage/repositories/authorized-users.js').AuthorizedUsersRepo;
  /** When omitted, write tools fail with NO_ACTOR. */
  getActor?: () => import('../../orchestrator/orchestrator.js').ActorContext | undefined;
}
```

Update the constructor (around line 33-37) to also store the new deps:

```ts
  private readonly client: PipedriveApiClient;
  private readonly writesRepo?: PipedriveConnectorDeps['writesRepo'];
  private readonly usersRepo?: PipedriveConnectorDeps['usersRepo'];
  private readonly getActor?: PipedriveConnectorDeps['getActor'];

  constructor(deps: PipedriveConnectorDeps) {
    this.client = deps.client;
    this.writesRepo = deps.writesRepo;
    this.usersRepo = deps.usersRepo;
    this.getActor = deps.getActor;
    this.tools = this.buildTools();
  }
```

Find the `return [` at the end of `buildTools()` (around the 11-tool list). BEFORE that `return`, declare a new tool:

```ts
    const CreateLeadArgs = z.object({
      title: z.string().min(1).max(255).describe('Title of the lead — usually the company or contact name. Required.'),
      personEmail: z.string().email().optional().describe('Email of the contact person. If omitted, no person attaches by email.'),
      personName: z.string().min(1).max(120).optional().describe('Display name of the person. Falls back to the email when not provided.'),
      personPhone: z.string().min(3).max(40).optional().describe('Phone number of the person (e.g. "+1 415 555 0101"). Optional.'),
      orgName: z.string().min(1).max(255).optional().describe('Organization name. The connector first looks for an exact match before creating a new org.'),
      value: z.number().positive().optional().describe('Expected lead value (amount only).'),
      currency: z.string().length(3).default('USD').describe('Currency code for `value`. Default USD.'),
      labelIds: z.array(z.string()).optional().describe('Pipedrive lead label ids to attach.'),
      expectedCloseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Expected close date in YYYY-MM-DD.'),
      note: z.string().min(1).max(5000).optional().describe('Optional first note to pin to the lead. Best-effort: lead succeeds even if the note fails.'),
    }).refine(
      (v) => Boolean(v.personEmail || v.personName || v.orgName),
      { message: 'Need at least one of personEmail, personName, or orgName.' },
    );
    type CreateLeadArgs = z.infer<typeof CreateLeadArgs>;
    const createLeadTool: ToolDef<CreateLeadArgs> = {
      name: 'pipedrive.create_lead',
      description: [
        'Create a new B2B lead in Pipedrive (the Leads Inbox — pre-deal). Auto-finds the person by email and the organization by name; creates them if absent.',
        'ADMIN or MARKETING role only — fails with FORBIDDEN otherwise.',
        'At least one of `personEmail`, `personName`, `orgName` must be set.',
        'Use ONLY when the user explicitly asks to "add a lead", "capture a lead", "create a lead", "captura un lead", "registra un lead". Do NOT fire it for analytics/read questions.',
      ].join(' '),
      schema: CreateLeadArgs as z.ZodType<CreateLeadArgs>,
      jsonSchema: zodToJsonSchema(CreateLeadArgs),
      execute: (args) => this.runCreateLead(args as CreateLeadArgs),
    };
```

Add the corresponding private method right above `private buildTools()`:

```ts
  private async runCreateLead(args: import('zod').infer<any>): Promise<unknown> {
    const a = args as { title: string; personEmail?: string; personName?: string; personPhone?: string; orgName?: string; value?: number; currency: string; labelIds?: string[]; expectedCloseDate?: string; note?: string };
    if (!this.writesRepo || !this.usersRepo || !this.getActor) {
      return { error: { code: 'WRITE_DEPS_NOT_CONFIGURED', message: 'Pipedrive write tools require writesRepo + usersRepo + getActor in connector deps.' } };
    }
    const actor = this.getActor();
    if (!actor) return { error: { code: 'NO_ACTOR', message: 'pipedrive.create_lead requires an active actor.' } };
    const role = await this.usersRepo.getRole(actor.slackUserId);
    if (role !== 'admin' && role !== 'marketing') {
      logger.warn({ caller: actor.slackUserId, role }, 'pipedrive_create_lead_denied');
      return { error: { code: 'FORBIDDEN', message: 'Pipedrive write tools require role=admin or role=marketing.' } };
    }

    let personId: number | undefined;
    let personName: string | undefined;
    let personCreated = false;
    let orgId: number | undefined;
    let orgName: string | undefined;
    let orgCreated = false;

    try {
      // Resolve person
      if (a.personEmail) {
        const found = await this.client.findPersonByEmail(a.personEmail);
        if (found) {
          personId = found.id;
          personName = found.name;
        } else {
          const created = await this.client.createPerson({
            name: a.personName ?? a.personEmail,
            email: a.personEmail,
            phone: a.personPhone,
          });
          personId = created.id;
          personName = created.name;
          personCreated = true;
        }
      } else if (a.personName) {
        const created = await this.client.createPerson({ name: a.personName, phone: a.personPhone });
        personId = created.id;
        personName = created.name;
        personCreated = true;
      }

      // Resolve org
      if (a.orgName) {
        const found = await this.client.findOrganizationByName(a.orgName);
        if (found) {
          orgId = found.id;
          orgName = found.name;
        } else {
          const created = await this.client.createOrganization({ name: a.orgName });
          orgId = created.id;
          orgName = created.name;
          orgCreated = true;
        }
      }

      // Create lead
      const lead = await this.client.createLead({
        title: a.title,
        personId,
        orgId,
        value: a.value !== undefined ? { amount: a.value, currency: a.currency } : undefined,
        labelIds: a.labelIds,
        expectedCloseDate: a.expectedCloseDate,
      });

      // Best-effort note attach
      let noteSubmitted = true;
      let noteError: string | undefined;
      if (a.note) {
        try {
          await this.client.createNote({ content: a.note, leadId: lead.id });
        } catch (err: unknown) {
          noteSubmitted = false;
          noteError = err instanceof Error ? err.message : String(err);
        }
      }

      const responsePayload = { leadId: lead.id, personId, orgId, personCreated, orgCreated, noteSubmitted, noteError };
      await this.writesRepo.insert({
        callerSlackId: actor.slackUserId,
        action: 'create_lead',
        pipedriveResourceType: 'lead',
        pipedriveResourceId: lead.id,
        requestPayload: a,
        responsePayload,
        status: 'success',
      });
      logger.info({ caller: actor.slackUserId, lead_id: lead.id, person_id: personId, org_id: orgId, person_created: personCreated, org_created: orgCreated }, 'pipedrive_lead_created');

      return {
        leadId: lead.id,
        leadTitle: lead.title,
        personId,
        personName,
        personCreated,
        orgId,
        orgName,
        orgCreated,
        noteSubmitted: a.note ? noteSubmitted : undefined,
        noteError,
      };
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      const body = (err as { body?: unknown })?.body;
      const message = err instanceof Error ? err.message : String(err);
      const partial = personId !== undefined || orgId !== undefined;
      await this.writesRepo.insert({
        callerSlackId: actor.slackUserId,
        action: 'create_lead',
        pipedriveResourceType: null,
        pipedriveResourceId: null,
        requestPayload: a,
        responsePayload: { error: { code: 'PIPEDRIVE_ERROR', status, message, body }, partial, personIdLeaked: personId, orgIdLeaked: orgId },
        status: 'failure',
      }).catch(() => {});
      logger.warn({ caller: actor.slackUserId, action: 'create_lead', error_code: 'PIPEDRIVE_ERROR', status }, 'pipedrive_write_failed');
      return { error: { code: 'PIPEDRIVE_ERROR', status, message, body, partial, personIdLeaked: personId, orgIdLeaked: orgId } };
    }
  }
```

Add `createLeadTool` to the returned tool array:

```ts
    return [
      // ... existing 11 tools (unchanged) ...
      createLeadTool,
    ];
```

- [ ] **Step 4: Run lead-tool tests — expect green**

Run: `npx vitest run tests/unit/connectors/pipedrive/lead-tool.test.ts`

Expected: 7/7 PASS.

- [ ] **Step 5: Run all pipedrive tests — confirm read tools still work**

Run: `npx vitest run tests/unit/connectors/pipedrive/`

Expected: all PASS except the documented Bilotti flake.

- [ ] **Step 6: Commit**

```bash
git add src/connectors/pipedrive/connector.ts tests/unit/connectors/pipedrive/lead-tool.test.ts
git commit -m "$(cat <<'EOF'
feat(pipedrive): pipedrive.create_lead tool with find-or-create person/org

Marketing/admin gated. Resolves person by email and org by exact name
before falling back to creation, so duplicate proliferation stays low.
Best-effort embedded note attach. Writes audit row (success or failure
with partial=true when person/org leaked before lead 4xx).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `pipedrive.add_note` tool

**Files:**
- Modify: `src/connectors/pipedrive/connector.ts`
- Create: `tests/unit/connectors/pipedrive/note-tool.test.ts`

- [ ] **Step 1: Write the note-tool tests**

Create `tests/unit/connectors/pipedrive/note-tool.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { PipedriveConnector } from '../../../../src/connectors/pipedrive/connector.js';

function makeDeps(opts: { callerRole?: 'admin' | 'marketing' | 'user' | null; createNote?: any } = {}) {
  const insertedRows: any[] = [];
  return {
    client: {
      listPipelines: vi.fn(), listStages: vi.fn(), listUsers: vi.fn(),
      listDealFields: vi.fn(), listSourceOptions: vi.fn(),
      findPersonByEmail: vi.fn(), findOrganizationByName: vi.fn(),
      createPerson: vi.fn(), createOrganization: vi.fn(), createLead: vi.fn(),
      createNote: opts.createNote ?? vi.fn().mockResolvedValue({ id: 5511, content: 'hello' }),
      createActivity: vi.fn(),
    } as any,
    writesRepo: { insert: vi.fn(async (row: any) => { insertedRows.push(row); return { id: 'a', ...row, createdAt: 'now' }; }) } as any,
    usersRepo: { getRole: vi.fn().mockResolvedValue(opts.callerRole === undefined ? 'marketing' : opts.callerRole) } as any,
    getActor: vi.fn().mockReturnValue({ slackUserId: 'U_LANA', slackChannelId: 'D1' }),
    insertedRows,
  };
}

function getTool(deps: any) {
  const conn = new PipedriveConnector(deps);
  return conn.tools.find((t) => t.name === 'pipedrive.add_note')!;
}

describe('pipedrive.add_note', () => {
  it('lead UUID target → calls createNote with lead_id', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({
      targetType: 'lead',
      targetId: '550e8400-e29b-41d4-a716-446655440000',
      content: 'They want matte black',
    });
    expect((r as any).noteId).toBe(5511);
    expect(deps.client.createNote).toHaveBeenCalledWith({
      content: 'They want matte black',
      leadId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(deps.insertedRows[0].action).toBe('add_note');
    expect(deps.insertedRows[0].status).toBe('success');
  });

  it('deal integer target → calls createNote with deal_id', async () => {
    const deps = makeDeps();
    await getTool(deps).execute({ targetType: 'deal', targetId: '12345', content: 'deal note' });
    expect(deps.client.createNote).toHaveBeenCalledWith({ content: 'deal note', dealId: 12345 });
  });

  it('person target with non-integer id → INVALID_ARGS', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({ targetType: 'person', targetId: 'abc', content: 'x' });
    expect((r as any).error.code).toBe('INVALID_ARGS');
  });

  it('lead target with non-UUID id → INVALID_ARGS', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({ targetType: 'lead', targetId: '12345', content: 'x' });
    expect((r as any).error.code).toBe('INVALID_ARGS');
  });

  it('FORBIDDEN for role=user', async () => {
    const deps = makeDeps({ callerRole: 'user' });
    const r = await getTool(deps).execute({ targetType: 'deal', targetId: '12345', content: 'x' });
    expect((r as any).error.code).toBe('FORBIDDEN');
    expect(deps.client.createNote).not.toHaveBeenCalled();
  });

  it('schema rejects empty content', () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    expect(() => tool.schema.parse({ targetType: 'lead', targetId: 'x', content: '' })).toThrow();
  });

  it('Pipedrive 400 → audit failure + error returned', async () => {
    const deps = makeDeps({
      createNote: vi.fn().mockRejectedValue(Object.assign(new Error('bad'), { status: 400, body: { error: 'bad' } })),
    });
    const r = await getTool(deps).execute({
      targetType: 'lead', targetId: '550e8400-e29b-41d4-a716-446655440000', content: 'x',
    });
    expect((r as any).error.code).toBe('PIPEDRIVE_ERROR');
    expect(deps.insertedRows[0].status).toBe('failure');
  });
});
```

- [ ] **Step 2: Run — expect failures**

Run: `npx vitest run tests/unit/connectors/pipedrive/note-tool.test.ts`

Expected: FAIL — `pipedrive.add_note` not present in tools.

- [ ] **Step 3: Add the tool to `connector.ts`**

In `connector.ts`, immediately after the `createLeadTool` declaration from Task 4, declare:

```ts
    const AddNoteArgs = z.object({
      targetType: z.enum(['lead', 'deal', 'person', 'org']).describe('Which Pipedrive entity to attach the note to.'),
      targetId: z.string().min(1).describe('Lead UUID, or integer id (as string) for deal/person/org.'),
      content: z.string().min(1).max(5000).describe('Note body. Plain text or simple HTML; Pipedrive sanitizes.'),
    });
    type AddNoteArgs = z.infer<typeof AddNoteArgs>;
    const addNoteTool: ToolDef<AddNoteArgs> = {
      name: 'pipedrive.add_note',
      description: [
        'Pin a note to an existing Pipedrive lead, deal, person, or organization.',
        'ADMIN or MARKETING role only.',
        'Use when the user says "note on the X lead", "log that…", "anota que…", "agrega una nota a…".',
      ].join(' '),
      schema: AddNoteArgs as z.ZodType<AddNoteArgs>,
      jsonSchema: zodToJsonSchema(AddNoteArgs),
      execute: (args) => this.runAddNote(args as AddNoteArgs),
    };
```

Add the private method (place it right after `runCreateLead`):

```ts
  private async runAddNote(args: { targetType: 'lead' | 'deal' | 'person' | 'org'; targetId: string; content: string }): Promise<unknown> {
    if (!this.writesRepo || !this.usersRepo || !this.getActor) {
      return { error: { code: 'WRITE_DEPS_NOT_CONFIGURED', message: 'Pipedrive write tools require writesRepo + usersRepo + getActor.' } };
    }
    const actor = this.getActor();
    if (!actor) return { error: { code: 'NO_ACTOR', message: 'pipedrive.add_note requires an active actor.' } };
    const role = await this.usersRepo.getRole(actor.slackUserId);
    if (role !== 'admin' && role !== 'marketing') {
      return { error: { code: 'FORBIDDEN', message: 'Pipedrive write tools require role=admin or role=marketing.' } };
    }

    // Lead ids are UUIDs; deal/person/org ids are integers
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let payload: { content: string; leadId?: string; dealId?: number; personId?: number; orgId?: number };
    if (args.targetType === 'lead') {
      if (!UUID_RE.test(args.targetId)) return { error: { code: 'INVALID_ARGS', message: 'Lead targetId must be a UUID.' } };
      payload = { content: args.content, leadId: args.targetId };
    } else {
      const numId = Number(args.targetId);
      if (!Number.isInteger(numId) || numId <= 0) {
        return { error: { code: 'INVALID_ARGS', message: `${args.targetType} targetId must be a positive integer.` } };
      }
      payload = { content: args.content };
      if (args.targetType === 'deal') payload.dealId = numId;
      else if (args.targetType === 'person') payload.personId = numId;
      else if (args.targetType === 'org') payload.orgId = numId;
    }

    try {
      const note = await this.client.createNote(payload);
      await this.writesRepo.insert({
        callerSlackId: actor.slackUserId,
        action: 'add_note',
        pipedriveResourceType: 'note',
        pipedriveResourceId: String(note.id),
        requestPayload: args,
        responsePayload: { noteId: note.id },
        status: 'success',
      });
      logger.info({ caller: actor.slackUserId, note_id: note.id, target_type: args.targetType, target_id: args.targetId }, 'pipedrive_note_created');
      return { noteId: note.id, targetType: args.targetType, targetId: args.targetId };
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      const body = (err as { body?: unknown })?.body;
      const message = err instanceof Error ? err.message : String(err);
      await this.writesRepo.insert({
        callerSlackId: actor.slackUserId,
        action: 'add_note',
        pipedriveResourceType: null,
        pipedriveResourceId: null,
        requestPayload: args,
        responsePayload: { error: { code: 'PIPEDRIVE_ERROR', status, message, body } },
        status: 'failure',
      }).catch(() => {});
      logger.warn({ caller: actor.slackUserId, action: 'add_note', error_code: 'PIPEDRIVE_ERROR', status }, 'pipedrive_write_failed');
      return { error: { code: 'PIPEDRIVE_ERROR', status, message, body } };
    }
  }
```

Add `addNoteTool` to the returned tool array (alongside `createLeadTool`):

```ts
    return [
      // ... existing 11 tools ...
      createLeadTool,
      addNoteTool,
    ];
```

- [ ] **Step 4: Run note-tool tests — expect green**

Run: `npx vitest run tests/unit/connectors/pipedrive/note-tool.test.ts`

Expected: 7/7 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/pipedrive/connector.ts tests/unit/connectors/pipedrive/note-tool.test.ts
git commit -m "$(cat <<'EOF'
feat(pipedrive): pipedrive.add_note tool

Pin a note to a lead (UUID) / deal / person / org (integer ids).
Marketing/admin gated. Validates target id shape per target type.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `pipedrive.create_activity` tool

**Files:**
- Modify: `src/connectors/pipedrive/connector.ts`
- Create: `tests/unit/connectors/pipedrive/activity-tool.test.ts`

- [ ] **Step 1: Write the activity-tool tests**

Create `tests/unit/connectors/pipedrive/activity-tool.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { PipedriveConnector } from '../../../../src/connectors/pipedrive/connector.js';

function makeDeps(opts: { callerRole?: 'admin' | 'marketing' | 'user' | null; createActivity?: any } = {}) {
  const insertedRows: any[] = [];
  return {
    client: {
      listPipelines: vi.fn(), listStages: vi.fn(), listUsers: vi.fn(),
      listDealFields: vi.fn(), listSourceOptions: vi.fn(),
      findPersonByEmail: vi.fn(), findOrganizationByName: vi.fn(),
      createPerson: vi.fn(), createOrganization: vi.fn(), createLead: vi.fn(),
      createNote: vi.fn(),
      createActivity: opts.createActivity ?? vi.fn().mockResolvedValue({ id: 8801, subject: 'Follow up' }),
    } as any,
    writesRepo: { insert: vi.fn(async (row: any) => { insertedRows.push(row); return { id: 'a', ...row, createdAt: 'now' }; }) } as any,
    usersRepo: { getRole: vi.fn().mockResolvedValue(opts.callerRole === undefined ? 'marketing' : opts.callerRole) } as any,
    getActor: vi.fn().mockReturnValue({ slackUserId: 'U_LANA', slackChannelId: 'D1' }),
    insertedRows,
  };
}

function getTool(deps: any) {
  const conn = new PipedriveConnector(deps);
  return conn.tools.find((t) => t.name === 'pipedrive.create_activity')!;
}

describe('pipedrive.create_activity', () => {
  it('minimal task succeeds', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({ subject: 'Follow up', type: 'task' });
    expect((r as any).activityId).toBe(8801);
    expect(deps.client.createActivity).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'Follow up', type: 'task',
    }));
    expect(deps.insertedRows[0].action).toBe('create_activity');
    expect(deps.insertedRows[0].pipedriveResourceId).toBe('8801');
  });

  it('full call activity with attachment to lead', async () => {
    const deps = makeDeps();
    await getTool(deps).execute({
      subject: 'Follow up', type: 'call',
      dueDate: '2026-05-12', dueTime: '15:00',
      durationMinutes: 30, note: 'Talk pricing',
      attachToType: 'lead', attachToId: '550e8400-e29b-41d4-a716-446655440000',
      assigneeUserId: 42,
    });
    expect(deps.client.createActivity).toHaveBeenCalledWith({
      subject: 'Follow up', type: 'call',
      dueDate: '2026-05-12', dueTime: '15:00',
      durationMinutes: 30, note: 'Talk pricing',
      leadId: '550e8400-e29b-41d4-a716-446655440000',
      userId: 42,
    });
  });

  it('attach to deal (integer)', async () => {
    const deps = makeDeps();
    await getTool(deps).execute({
      subject: 'X', type: 'meeting',
      attachToType: 'deal', attachToId: '12345',
    });
    expect(deps.client.createActivity).toHaveBeenCalledWith(expect.objectContaining({
      dealId: 12345,
    }));
  });

  it('attach to lead with non-UUID → INVALID_ARGS', async () => {
    const deps = makeDeps();
    const r = await getTool(deps).execute({
      subject: 'X', type: 'task', attachToType: 'lead', attachToId: '12345',
    });
    expect((r as any).error.code).toBe('INVALID_ARGS');
    expect(deps.client.createActivity).not.toHaveBeenCalled();
  });

  it('FORBIDDEN for role=user', async () => {
    const deps = makeDeps({ callerRole: 'user' });
    const r = await getTool(deps).execute({ subject: 'X', type: 'task' });
    expect((r as any).error.code).toBe('FORBIDDEN');
  });

  it('schema rejects unknown type', () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    expect(() => tool.schema.parse({ subject: 'X', type: 'wizard' })).toThrow();
  });
});
```

- [ ] **Step 2: Run — expect failures**

Run: `npx vitest run tests/unit/connectors/pipedrive/activity-tool.test.ts`

Expected: FAIL — `pipedrive.create_activity` not present.

- [ ] **Step 3: Add the tool to `connector.ts`**

In `connector.ts`, after `addNoteTool`, declare:

```ts
    const CreateActivityArgs = z.object({
      subject: z.string().min(1).max(255).describe('Title of the activity.'),
      type: z.enum(['call', 'meeting', 'task', 'email', 'lunch']).default('task').describe('Activity type. Default "task".'),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD due date.'),
      dueTime: z.string().regex(/^\d{2}:\d{2}$/).optional().describe('HH:MM (24h) due time.'),
      durationMinutes: z.number().int().min(1).max(480).optional().describe('Duration in minutes (max 8h).'),
      note: z.string().max(5000).optional().describe('Body of the activity (notes/agenda).'),
      attachToType: z.enum(['lead', 'deal', 'person', 'org']).optional().describe('Optional: attach the activity to a Pipedrive entity.'),
      attachToId: z.string().optional().describe('Lead UUID or integer id (as string) of the entity to attach to.'),
      assigneeUserId: z.number().int().positive().optional().describe('Pipedrive user id of the assignee. Defaults to the API token user.'),
    });
    type CreateActivityArgs = z.infer<typeof CreateActivityArgs>;
    const createActivityTool: ToolDef<CreateActivityArgs> = {
      name: 'pipedrive.create_activity',
      description: [
        'Schedule a Pipedrive activity (call/meeting/task/email/lunch) with optional due date, time, duration, and attachment to a lead/deal/person/org.',
        'ADMIN or MARKETING role only.',
        'Use when the user says "remind me to follow up", "schedule a call", "agendame seguimiento", "follow up next Tuesday".',
      ].join(' '),
      schema: CreateActivityArgs as z.ZodType<CreateActivityArgs>,
      jsonSchema: zodToJsonSchema(CreateActivityArgs),
      execute: (args) => this.runCreateActivity(args as CreateActivityArgs),
    };
```

Add the private method (after `runAddNote`):

```ts
  private async runCreateActivity(args: {
    subject: string; type: 'call' | 'meeting' | 'task' | 'email' | 'lunch';
    dueDate?: string; dueTime?: string; durationMinutes?: number; note?: string;
    attachToType?: 'lead' | 'deal' | 'person' | 'org'; attachToId?: string;
    assigneeUserId?: number;
  }): Promise<unknown> {
    if (!this.writesRepo || !this.usersRepo || !this.getActor) {
      return { error: { code: 'WRITE_DEPS_NOT_CONFIGURED', message: 'Pipedrive write tools require writesRepo + usersRepo + getActor.' } };
    }
    const actor = this.getActor();
    if (!actor) return { error: { code: 'NO_ACTOR', message: 'pipedrive.create_activity requires an active actor.' } };
    const role = await this.usersRepo.getRole(actor.slackUserId);
    if (role !== 'admin' && role !== 'marketing') {
      return { error: { code: 'FORBIDDEN', message: 'Pipedrive write tools require role=admin or role=marketing.' } };
    }

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const payload: Parameters<typeof this.client.createActivity>[0] = {
      subject: args.subject, type: args.type,
      dueDate: args.dueDate, dueTime: args.dueTime,
      durationMinutes: args.durationMinutes, note: args.note,
      userId: args.assigneeUserId,
    };
    if (args.attachToType && args.attachToId) {
      if (args.attachToType === 'lead') {
        if (!UUID_RE.test(args.attachToId)) return { error: { code: 'INVALID_ARGS', message: 'Lead attachToId must be a UUID.' } };
        payload.leadId = args.attachToId;
      } else {
        const numId = Number(args.attachToId);
        if (!Number.isInteger(numId) || numId <= 0) return { error: { code: 'INVALID_ARGS', message: `${args.attachToType} attachToId must be a positive integer.` } };
        if (args.attachToType === 'deal') payload.dealId = numId;
        else if (args.attachToType === 'person') payload.personId = numId;
        else if (args.attachToType === 'org') payload.orgId = numId;
      }
    }

    try {
      const activity = await this.client.createActivity(payload);
      await this.writesRepo.insert({
        callerSlackId: actor.slackUserId,
        action: 'create_activity',
        pipedriveResourceType: 'activity',
        pipedriveResourceId: String(activity.id),
        requestPayload: args,
        responsePayload: { activityId: activity.id },
        status: 'success',
      });
      logger.info({ caller: actor.slackUserId, activity_id: activity.id, attach_to_type: args.attachToType, attach_to_id: args.attachToId }, 'pipedrive_activity_created');
      return {
        activityId: activity.id, subject: activity.subject,
        dueDate: args.dueDate, dueTime: args.dueTime,
        attachToType: args.attachToType, attachToId: args.attachToId,
      };
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      const body = (err as { body?: unknown })?.body;
      const message = err instanceof Error ? err.message : String(err);
      await this.writesRepo.insert({
        callerSlackId: actor.slackUserId,
        action: 'create_activity',
        pipedriveResourceType: null,
        pipedriveResourceId: null,
        requestPayload: args,
        responsePayload: { error: { code: 'PIPEDRIVE_ERROR', status, message, body } },
        status: 'failure',
      }).catch(() => {});
      logger.warn({ caller: actor.slackUserId, action: 'create_activity', error_code: 'PIPEDRIVE_ERROR', status }, 'pipedrive_write_failed');
      return { error: { code: 'PIPEDRIVE_ERROR', status, message, body } };
    }
  }
```

Add `createActivityTool` to the returned tool array:

```ts
    return [
      // ... existing 11 tools ...
      createLeadTool,
      addNoteTool,
      createActivityTool,
    ];
```

- [ ] **Step 4: Run activity-tool tests — expect green**

Run: `npx vitest run tests/unit/connectors/pipedrive/activity-tool.test.ts`

Expected: 6/6 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/pipedrive/connector.ts tests/unit/connectors/pipedrive/activity-tool.test.ts
git commit -m "$(cat <<'EOF'
feat(pipedrive): pipedrive.create_activity tool

Schedules a call/meeting/task/email/lunch activity with optional
due date/time, duration, attachment to lead/deal/person/org, and
assignee. Marketing/admin gated.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Wire `writesRepo` + `usersRepo` + `getActor` in `src/index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Find the existing PipedriveConnector instantiation**

Run: `grep -n "PipedriveConnector\|pipedriveApiToken" src/index.ts | head -10`

You'll see the construction is currently `new PipedriveConnector({ client: pipedriveClient })`. Adjacent code already constructs `usersRepo` (an `AuthorizedUsersRepo`) and `getActiveActor` is exported from `orchestrator.js`.

- [ ] **Step 2: Add the new wiring**

Open `src/index.ts`. Locate the Pipedrive registration block (around the `if (pipedriveApiToken) { ... }`). Just above the `registry.register(new PipedriveConnector({ client: pipedriveClient }));` line, add the repo construction. Then update the connector construction to pass the four deps:

```ts
  if (pipedriveApiToken) {
    const pipedriveClient = new PipedriveApiClient({ apiToken: pipedriveApiToken });
    const pipedriveWritesRepo = new PipedriveWritesRepo(supabase);
    registry.register(new PipedriveConnector({
      client: pipedriveClient,
      writesRepo: pipedriveWritesRepo,
      usersRepo,
      getActor: () => getActiveActor(),
    }));
    logger.info('pipedrive connector registered');
  } else {
    logger.warn('pipedrive not configured (PIPEDRIVE_API_TOKEN missing) — skipping registration');
  }
```

Add the `PipedriveWritesRepo` import alongside the other repo imports near the top of `src/index.ts`:

```ts
import { PipedriveWritesRepo } from './storage/repositories/pipedrive-writes.js';
```

`AuthorizedUsersRepo`, `getActiveActor`, and `supabase` are already imported / in scope where the Pipedrive registration runs. Verify by re-reading the surrounding lines after editing.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`

Expected: 0 errors.

- [ ] **Step 4: Run the full unit suite**

Run: `npx vitest run`

Expected: every test passes except the pre-existing pipedrive flake at `tests/unit/connectors/pipedrive/connector.test.ts:348`. The four new pipedrive write test files (client-write, lead-tool, note-tool, activity-tool) plus the writes-repo test are green.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
feat(index): wire PipedriveWritesRepo + usersRepo + getActor for write tools

PipedriveConnector now receives the three new deps required by
create_lead / add_note / create_activity. Read-only deployments
(no PIPEDRIVE_API_TOKEN) are unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Layer-2 integration tests with mocked LLM

**Files:**
- Create: `tests/unit/orchestrator/pipedrive-write-routing.test.ts`

- [ ] **Step 1: Create the test file**

Create `tests/unit/orchestrator/pipedrive-write-routing.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { Orchestrator } from '../../../src/orchestrator/orchestrator.js';
import { ConnectorRegistry } from '../../../src/connectors/base/registry.js';
import type { Connector, ToolDef } from '../../../src/connectors/base/connector.js';

function buildPipedriveRegistry(overrides: {
  createLead?: (args: any) => any;
  addNote?: (args: any) => any;
  createActivity?: (args: any) => any;
} = {}) {
  const createLead: ToolDef = {
    name: 'pipedrive.create_lead',
    description: 'create lead',
    schema: z.object({ title: z.string() }).passthrough(),
    jsonSchema: { type: 'object' },
    execute: vi.fn(async (args) =>
      overrides.createLead ? overrides.createLead(args) : { leadId: 'lead-uuid-1', leadTitle: (args as any).title, personCreated: true, orgCreated: true },
    ),
  };
  const addNote: ToolDef = {
    name: 'pipedrive.add_note',
    description: 'add note',
    schema: z.object({ targetType: z.string(), targetId: z.string(), content: z.string() }).passthrough(),
    jsonSchema: { type: 'object' },
    execute: vi.fn(async (args) =>
      overrides.addNote ? overrides.addNote(args) : { noteId: 5511 },
    ),
  };
  const createActivity: ToolDef = {
    name: 'pipedrive.create_activity',
    description: 'create activity',
    schema: z.object({ subject: z.string(), type: z.string() }).passthrough(),
    jsonSchema: { type: 'object' },
    execute: vi.fn(async (args) =>
      overrides.createActivity ? overrides.createActivity(args) : { activityId: 8801 },
    ),
  };
  const conn: Connector = {
    name: 'pipedrive',
    tools: [createLead, addNote, createActivity],
    async healthCheck() { return { ok: true }; },
  };
  const r = new ConnectorRegistry();
  r.register(conn);
  return { registry: r, createLead, addNote, createActivity };
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

describe('pipedrive write routing — orchestrator + LLM mock', () => {
  it('A. single create_lead', async () => {
    const { registry, createLead } = buildPipedriveRegistry();
    const claude: any = fakeClaude([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'pipedrive_create_lead', input: { title: 'Foo Studio', personEmail: 'jane@foo.com' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: 'Created lead Foo Studio (id: lead-uuid-1).' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({ question: 'Add jane@foo.com as a lead', threadHistory: [] });
    expect(out.toolCalls.map((c) => c.name)).toEqual(['pipedrive.create_lead']);
    expect((createLead.execute as any).mock.calls[0][0]).toMatchObject({ title: 'Foo Studio', personEmail: 'jane@foo.com' });
  });

  it('B. compound conversational turn — create_lead → add_note → create_activity', async () => {
    const { registry, createLead, addNote, createActivity } = buildPipedriveRegistry();
    const claude: any = fakeClaude([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'pipedrive_create_lead', input: { title: 'Foo Studio', personEmail: 'jane@foostudio.com', orgName: 'Foo Studio' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'tool_use', id: 't2', name: 'pipedrive_add_note', input: { targetType: 'lead', targetId: 'lead-uuid-1', content: 'They want a matte black finish' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'tool_use', id: 't3', name: 'pipedrive_create_activity', input: { subject: 'Follow up with Foo Studio', type: 'call', dueDate: '2026-05-12', dueTime: '15:00', attachToType: 'lead', attachToId: 'lead-uuid-1' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: 'Created lead, pinned the note, scheduled the follow-up.' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({
      question: 'I had a great call with Foo Studio (jane@foostudio.com). Add them as a lead, note that they want matte black, and remind me to follow up Tuesday at 3pm',
      threadHistory: [],
    });
    expect(out.toolCalls.map((c) => c.name)).toEqual([
      'pipedrive.create_lead', 'pipedrive.add_note', 'pipedrive.create_activity',
    ]);
    expect((addNote.execute as any).mock.calls[0][0]).toMatchObject({ targetType: 'lead', targetId: 'lead-uuid-1' });
    expect((createActivity.execute as any).mock.calls[0][0]).toMatchObject({ attachToType: 'lead', attachToId: 'lead-uuid-1' });
  });

  it('C. role gate: tool returns FORBIDDEN, LLM relays to user', async () => {
    const { registry } = buildPipedriveRegistry({
      createLead: () => ({ error: { code: 'FORBIDDEN', message: 'Pipedrive write tools require role=admin or role=marketing.' } }),
    });
    const claude: any = fakeClaude([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'pipedrive_create_lead', input: { title: 'X', personEmail: 'x@y.com' } }],
        stop_reason: 'tool_use', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: "Sorry — Pipedrive write tools require the admin or marketing role. Ping Danny if you need it." }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({ question: 'Add a lead', threadHistory: [] });
    expect(out.toolCalls).toHaveLength(1);
    expect(out.response).toMatch(/admin or marketing/i);
  });

  it('D. analytics question does NOT auto-fire write tools', async () => {
    const { registry, createLead, addNote, createActivity } = buildPipedriveRegistry();
    const claude: any = fakeClaude([
      {
        content: [{ type: 'text', text: 'Looking that up requires a read tool — I would call pipedrive.list_deals (not a write tool).' }],
        stop_reason: 'end_turn', usage: STD_USAGE, model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({ registry, claude, model: 'claude-sonnet-4-6', maxIterations: 5 });
    const out = await orch.run({ question: 'How many leads did we create last week?', threadHistory: [] });
    expect((createLead.execute as any)).not.toHaveBeenCalled();
    expect((addNote.execute as any)).not.toHaveBeenCalled();
    expect((createActivity.execute as any)).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect green**

Run: `npx vitest run tests/unit/orchestrator/pipedrive-write-routing.test.ts`

Expected: 4/4 PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/orchestrator/pipedrive-write-routing.test.ts
git commit -m "$(cat <<'EOF'
test(orchestrator): pipedrive write routing — 4 LLM-mocked scenarios

Single create_lead, compound turn (lead → note → activity sharing the
lead id), FORBIDDEN role gate relayed to the user, and the negative
case where an analytics question does NOT auto-fire writes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Update `prompts.ts` with the three new bullets

**Files:**
- Modify: `src/orchestrator/prompts.ts`

- [ ] **Step 1: Locate the Pipedrive section**

Run: `grep -n "pipedrive\." src/orchestrator/prompts.ts | head -20` to find where the read-tool bullets live.

- [ ] **Step 2: Append the three new bullets**

In `src/orchestrator/prompts.ts`, find the LAST existing pipedrive bullet (the 11th read tool — likely `pipedrive.user_performance`). Immediately after it, before the next section header, add:

```
  • **\`pipedrive.create_lead\`** — capture a new B2B lead in Pipedrive. ADMIN/MARKETING only. Auto-finds the person by email and the org by exact name (creates them if absent). Trigger words: "add X as a lead", "captura un lead", "create a lead for…", "new prospect from BDNY", "registra un lead". Args: \`title\`, \`personEmail?\`, \`personName?\`, \`personPhone?\`, \`orgName?\`, \`value?\`, \`currency?\`, \`expectedCloseDate?\`, \`labelIds?\`, \`note?\`. At least one of personEmail/personName/orgName required.
  • **\`pipedrive.add_note\`** — pin a note to an existing Pipedrive lead, deal, person, or organization. ADMIN/MARKETING only. Trigger words: "note on the X lead", "log that…", "anota que…", "agrega una nota a…". Args: \`targetType\` ('lead'|'deal'|'person'|'org'), \`targetId\` (UUID for lead, integer for the others), \`content\`.
  • **\`pipedrive.create_activity\`** — schedule a Pipedrive activity (call/meeting/task/email/lunch). ADMIN/MARKETING only. Trigger words: "remind me to follow up", "schedule a call with…", "agendame seguimiento", "follow up next Tuesday at 3pm". Args: \`subject\`, \`type\`, \`dueDate?\`, \`dueTime?\`, \`durationMinutes?\`, \`note?\`, \`attachToType?\`, \`attachToId?\`, \`assigneeUserId?\`.
  • All three Pipedrive write tools require role=admin or role=marketing. Non-admin/non-marketing users get FORBIDDEN.
```

Note: the section header above these tools currently reads `*7. Pipedrive (B2B Trade & Wholesale CRM)* — pipedrive.list_directory, pipedrive.search, ...`. Update the header tool list to also include the three new tool names so the LLM sees them in the section's at-a-glance enumeration:

Find the line that lists the Pipedrive tools in the section header (it's a comma-separated list right after the section title) and append `, pipedrive.create_lead, pipedrive.add_note, pipedrive.create_activity` to that list.

- [ ] **Step 3: Run prompts test**

Run: `npx vitest run tests/unit/orchestrator/prompts.test.ts`

Expected: PASS. The existing test asserts presence of date / tool names / catalog — adding bullets won't break it. If a substring assertion happens to match the old wording exactly, update the test to match the new bullet text.

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/prompts.ts
git commit -m "$(cat <<'EOF'
docs(prompts): add bullets for pipedrive create_lead / add_note / create_activity

Trigger words + args list + role gate so the LLM picks the right tool
from natural language.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Update `intro-message.ts` with the Pipedrive write callout

**Files:**
- Modify: `src/connectors/broadcast/intro-message.ts`

- [ ] **Step 1: Locate the Pipedrive read-examples block**

In `src/connectors/broadcast/intro-message.ts`, find the section starting with `'*💼 Sales Pipeline* — Pipedrive (B2B Trade & Wholesale)',` and ending with the last bullet of that block (likely `'• _"Deal #816 in detail with all custom fields"_',`). The next entry is an empty `''` line and then the next section header.

- [ ] **Step 2: Insert the new write-callout block right after the Pipedrive read block**

Just before the empty line that separates the Pipedrive read block from the next section, insert:

```ts
  '',
  '*✏️ Pipedrive lead capture* — _admin / marketing roles only_',
  '',
  'Marketing can write to Pipedrive directly from Slack — useful right after a trade show or a sales call:',
  '• _"Add Foo Studio as a lead — contact is jane@foostudio.com (Jane Doe), value $5k"_ — creates the lead with auto-resolved person + organization (reuses if they already exist).',
  '• _"Note on the Foo Studio lead: they want a custom matte black finish"_ — pin a free-form note to any lead/deal/person/org.',
  '• _"Remind me to follow up with Foo Studio next Tuesday at 3pm"_ — schedule a call/meeting/task with optional due date+time and assignee.',
  '',
  'Every write is audited with the Slack user who triggered it.',
```

- [ ] **Step 3: Run broadcast tests**

Run: `npx vitest run tests/unit/connectors/broadcast/`

Expected: PASS. The existing tests don't substring-match against this exact block.

- [ ] **Step 4: Commit**

```bash
git add src/connectors/broadcast/intro-message.ts
git commit -m "$(cat <<'EOF'
docs(intro): add Pipedrive lead-capture section for marketing/admin

Three examples mirroring the new write tools (create_lead, add_note,
create_activity), positioned right after the existing Pipedrive
analytics block so the Pipedrive capabilities live together.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Smoke checklist + final regression sweep

**Files:**
- Modify: `tests/integration/smoke.md`

- [ ] **Step 1: Append the Pipedrive smoke section to `tests/integration/smoke.md`**

Add a new section right before the trailing `Log the result of the run (pass/fail per step) in the deploy PR.` line:

```markdown
## Pipedrive write tools — Tier 1 (added 2026-05-07)

Run after deploys that touch `src/connectors/pipedrive/connector.ts`, `src/connectors/pipedrive/client.ts`, or `migrations/0018_pipedrive_writes.sql`. Use a throwaway organization name (`E2E Test Co`) and a throwaway email (`e2e-test@example.com`); clean up afterwards.

18. As role=admin in DM with the bot: _"Add e2e-test@example.com as a lead with org E2E Test Co"_. Expect a "Created lead" reply with `personCreated:true`, `orgCreated:true`. Verify a `pipedrive_writes` row appears in Supabase with `status='success'`.
19. _"Note on lead <uuid from step 18>: smoke test note"_. Expect "Note added". Verify the note appears in Pipedrive's UI under that lead.
20. _"Schedule a task to follow up with E2E Test Co next week"_. Expect activity created with `dueDate ≈ today+7`. Verify the activity in Pipedrive.
21. _"Add e2e-test@example.com as a lead again"_ (same email). Expect `personCreated:false` (re-used the existing person). New lead is created.
22. As role=user (a temporarily-demoted admin or a test user): _"Add a lead"_. Expect "Pipedrive write tools require the admin or marketing role" reply.
23. Logs: `fly logs -a gantri-ai-bot | grep -E "pipedrive_(lead|note|activity)_created|pipedrive_write_failed"` should show 3 success log lines from steps 18-21 and zero failures.

Cleanup: archive/delete the test leads, the E2E Test Co organization, and the test person in the Pipedrive UI.
```

- [ ] **Step 2: Run the full unit suite**

Run: `npx vitest run`

Expected: every test passes except the documented Bilotti flake. The newly-added test files (writes-repo, client-write, lead-tool, note-tool, activity-tool, pipedrive-write-routing) are all green.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`

Expected: 0 errors.

- [ ] **Step 4: Commit smoke updates**

```bash
git add tests/integration/smoke.md
git commit -m "$(cat <<'EOF'
docs(smoke): pipedrive write-tools tier 1 pre-deploy checklist

Six steps covering create_lead happy path, dedup-on-second-call,
add_note, create_activity, role gate rejection, and log signal verification.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Checklist (run before handoff)

- [x] **Spec coverage:**
  - Migration → Task 1
  - PipedriveWritesRepo → Task 2
  - Client write surface (7 methods) → Task 3
  - `pipedrive.create_lead` → Task 4
  - `pipedrive.add_note` → Task 5
  - `pipedrive.create_activity` → Task 6
  - `index.ts` wiring → Task 7
  - Layer-2 LLM-mocked tests → Task 8
  - Prompts bullets → Task 9
  - Intro message callout → Task 10
  - Smoke checklist → Task 11

- [x] **No placeholders:** every step shows code or commands.

- [x] **Type consistency:** `PipedriveWritesRepo` / `PipedriveWriteRow` / `PipedriveWriteInsert` consistent across tasks. `pipedriveResourceType` / `pipedriveResourceId` consistent. `find{Person,Organization}` / `create{Person,Organization,Lead,Note,Activity}` method names match between client tests, client implementation, tool tests, and tool implementation.

- [x] **Decomposition:** eleven tasks, each independently committable. Dependency order respected (DB → repo → client → tools → wiring → integration → docs → smoke).
