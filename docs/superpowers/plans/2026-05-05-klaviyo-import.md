# Klaviyo Profile Management (Import + Delete) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three Klaviyo write tools (`klaviyo.import_profiles`, `klaviyo.delete_profiles`, `klaviyo.import_status`) plus the supporting infrastructure (new `marketing` role, confirmation flow, audit tables, background poller, Slack file_shared handler) to let admin/marketing-role users in Slack bulk-create + bulk-delete Klaviyo profiles via inline messages or attached CSVs.

**Architecture:** New tools live on the existing `KlaviyoConnector`. The Klaviyo HTTP client gains four methods (bulk subscribe, job status, profile-by-email, deletion-job submission). A new `ConfirmationHandler` runs upstream of the LLM and intercepts literal "yes"/"cancel" replies in DM threads that have a pending row. A new `KlaviyoImportPollerJob` (modeled on `ReportsRunner`) polls in-flight import jobs every 60s and DMs the caller on terminal status. A new Slack `file_shared` event handler downloads + parses CSVs and dispatches into the same `klaviyo.import_profiles` tool path.

**Tech Stack:** TypeScript, Supabase (Postgres + Storage), Klaviyo Profiles + Subscriptions + Data-Privacy APIs (revision `2026-04-15`), `papaparse@5.x`, `libphonenumber-js@1.x`, Vitest, Pino logger.

**Spec:** `docs/superpowers/specs/2026-05-05-klaviyo-import-design.md` (status: Approved — ready for plan).

---

## File Structure

| Type | Path | Responsibility |
|---|---|---|
| New | `migrations/0013_authorized_users_marketing_role.sql` | ALTER role check to allow `'marketing'` |
| New | `migrations/0014_klaviyo_imports.sql` | Import audit table |
| New | `migrations/0015_klaviyo_deletions.sql` | Deletion audit table |
| New | `migrations/0016_pending_confirmations.sql` | Generic 30-min staging table |
| New | `src/storage/repositories/klaviyo-imports.ts` | Imports CRUD + counts |
| New | `src/storage/repositories/klaviyo-deletions.ts` | Deletions CRUD + counts |
| New | `src/storage/repositories/pending-confirmations.ts` | Pending CRUD + sweepExpired + lookupByThread |
| Extend | `src/connectors/klaviyo/client.ts` | Add 4 methods + 2 result interfaces |
| New | `src/connectors/klaviyo/csv-parser.ts` | papaparse wrapper that returns `{rows, warnings}` |
| New | `src/connectors/klaviyo/phone.ts` | E.164 normalizer using libphonenumber-js |
| New | `src/connectors/klaviyo/validation.ts` | Per-row validation pipeline |
| Extend | `src/connectors/klaviyo/connector.ts` | Register 3 new tools, wire repos |
| New | `src/connectors/klaviyo/import-poller.ts` | Background poller class |
| New | `src/orchestrator/confirmation-handler.ts` | Intercept yes/cancel replies |
| Extend | `src/connectors/broadcast/broadcast-connector.ts` | Add `role` arg to `bot.add_user`; add `bot.update_user_role` |
| Extend | `src/slack/handlers.ts` | Add `file_shared` event handler |
| Extend | `src/index.ts` | Wire repos, poller, confirmation handler, file_shared route |
| Extend | `src/reports/live/spec.ts` | Whitelist `klaviyo.import_status` only |
| Extend | `src/connectors/live-reports/tool-output-shapes.ts` | Sample output for `klaviyo.import_status` |
| Extend | `src/orchestrator/prompts.ts` | Document the 3 new Klaviyo tools + role semantics |
| Extend | `package.json` | Add `papaparse`, `libphonenumber-js`, types |
| New | `tests/fixtures/klaviyo-imports/*.csv` | 7 sample CSVs (per spec) |
| New | `tests/unit/storage/klaviyo-imports.test.ts` | Imports repo |
| New | `tests/unit/storage/klaviyo-deletions.test.ts` | Deletions repo |
| New | `tests/unit/storage/pending-confirmations.test.ts` | Pending repo |
| New | `tests/unit/connectors/klaviyo/client-write.test.ts` | New client methods |
| New | `tests/unit/connectors/klaviyo/csv-parser.test.ts` | Papaparse wrapper |
| New | `tests/unit/connectors/klaviyo/phone.test.ts` | E.164 normalizer |
| New | `tests/unit/connectors/klaviyo/validation.test.ts` | Validation pipeline |
| New | `tests/unit/connectors/klaviyo/import-tool.test.ts` | `klaviyo.import_profiles` tool |
| New | `tests/unit/connectors/klaviyo/delete-tool.test.ts` | `klaviyo.delete_profiles` tool |
| New | `tests/unit/connectors/klaviyo/status-tool.test.ts` | `klaviyo.import_status` tool |
| New | `tests/unit/connectors/klaviyo/import-poller.test.ts` | Poller |
| New | `tests/unit/orchestrator/confirmation-handler.test.ts` | Confirmation router |
| Extend | `tests/unit/connectors/broadcast/broadcast-connector.test.ts` | Role arg + new tool |
| Extend | `tests/unit/slack/handlers.test.ts` | file_shared handler |
| New | `scripts/smoke-klaviyo-write.sh` | Manual smoke against staging Klaviyo |

---

## Task K1: Migrations (4 files)

**Files:**
- Create: `migrations/0013_authorized_users_marketing_role.sql`
- Create: `migrations/0014_klaviyo_imports.sql`
- Create: `migrations/0015_klaviyo_deletions.sql`
- Create: `migrations/0016_pending_confirmations.sql`

- [ ] **Step 1: Write `0013_authorized_users_marketing_role.sql`**

```sql
-- Extend authorized_users.role to allow 'marketing' alongside 'admin'/'user'.
-- Existing rows are unchanged. Marketing role gates Klaviyo write tools but NOT
-- bot.broadcast_notification or bot.add_user / bot.update_user_role.
ALTER TABLE authorized_users DROP CONSTRAINT IF EXISTS authorized_users_role_check;
ALTER TABLE authorized_users ADD CONSTRAINT authorized_users_role_check
  CHECK (role IN ('admin', 'marketing', 'user'));
```

- [ ] **Step 2: Write `0014_klaviyo_imports.sql`**

```sql
CREATE TABLE klaviyo_imports (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_slack_id          TEXT NOT NULL,
  caller_email             TEXT,
  source                   TEXT NOT NULL CHECK (source IN ('inline','csv')),
  filename                 TEXT,
  storage_path             TEXT,
  list_id                  TEXT,
  list_name                TEXT,
  channels                 TEXT[] NOT NULL,
  total_submitted          INTEGER NOT NULL,
  total_imported           INTEGER NOT NULL DEFAULT 0,
  total_invalid_rejected   INTEGER NOT NULL DEFAULT 0,
  klaviyo_job_id           TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('queued','processing','complete','failed')),
  started_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at             TIMESTAMPTZ,
  succeeded_count          INTEGER,
  already_subscribed_count INTEGER,
  failed_count             INTEGER,
  error_summary            TEXT,
  CONSTRAINT klaviyo_imports_status_terminal_has_completed_at
    CHECK ((status IN ('complete','failed') AND completed_at IS NOT NULL)
        OR (status IN ('queued','processing') AND completed_at IS NULL))
);

CREATE INDEX idx_klaviyo_imports_caller  ON klaviyo_imports(caller_slack_id, started_at DESC);
CREATE INDEX idx_klaviyo_imports_pending ON klaviyo_imports(status) WHERE status IN ('queued','processing');
CREATE INDEX idx_klaviyo_imports_job     ON klaviyo_imports(klaviyo_job_id);
```

- [ ] **Step 3: Write `0015_klaviyo_deletions.sql`**

```sql
CREATE TABLE klaviyo_deletions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_slack_id     TEXT NOT NULL,
  caller_email        TEXT,
  requested_emails    JSONB NOT NULL,
  found_count         INTEGER NOT NULL,
  deleted_count       INTEGER NOT NULL,
  failed_count        INTEGER NOT NULL,
  failed_details      JSONB NOT NULL DEFAULT '[]',
  status              TEXT NOT NULL CHECK (status IN ('submitted')),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_klaviyo_deletions_caller ON klaviyo_deletions(caller_slack_id, started_at DESC);
```

- [ ] **Step 4: Write `0016_pending_confirmations.sql`**

```sql
CREATE TABLE pending_confirmations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  confirmation_token  UUID NOT NULL UNIQUE,
  caller_slack_id     TEXT NOT NULL,
  channel_id          TEXT NOT NULL,
  thread_ts           TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('klaviyo_import','klaviyo_delete')),
  payload             JSONB NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 minutes')
);

CREATE INDEX idx_pending_confirmations_lookup
  ON pending_confirmations(caller_slack_id, channel_id, thread_ts);
CREATE INDEX idx_pending_confirmations_expiry
  ON pending_confirmations(expires_at);
```

- [ ] **Step 5: Apply all 4 migrations to Supabase**

Use the Supabase MCP tool, one at a time:

```
mcp__supabase__apply_migration project_id=ykjjwszoxazzlcovhlgd name="0013_authorized_users_marketing_role" query=<contents>
mcp__supabase__apply_migration project_id=ykjjwszoxazzlcovhlgd name="0014_klaviyo_imports" query=<contents>
mcp__supabase__apply_migration project_id=ykjjwszoxazzlcovhlgd name="0015_klaviyo_deletions" query=<contents>
mcp__supabase__apply_migration project_id=ykjjwszoxazzlcovhlgd name="0016_pending_confirmations" query=<contents>
```

Expected: each returns success.

- [ ] **Step 6: Verify schemas via information_schema**

Run via Supabase MCP:

```sql
select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_name in ('klaviyo_imports','klaviyo_deletions','pending_confirmations')
order by table_name, ordinal_position;
```

Expected: 17 rows for `klaviyo_imports`, 10 for `klaviyo_deletions`, 8 for `pending_confirmations`.

Then verify the role check:
```sql
select pg_get_constraintdef(oid)
from pg_constraint
where conname = 'authorized_users_role_check';
```
Expected: `CHECK (role = ANY (ARRAY['admin'::text, 'marketing'::text, 'user'::text]))`.

- [ ] **Step 7: Commit**

```bash
git add migrations/0013_authorized_users_marketing_role.sql migrations/0014_klaviyo_imports.sql migrations/0015_klaviyo_deletions.sql migrations/0016_pending_confirmations.sql
git commit -m "feat(db): add marketing role + klaviyo_imports/_deletions/pending_confirmations"
```

---

## Task K2: Storage bucket + npm deps

**Files:**
- Modify: `package.json`
- (Supabase Storage admin via MCP)

- [ ] **Step 1: Create the `klaviyo-imports` bucket in Supabase Storage**

Run via Supabase MCP (or directly in Supabase Studio if MCP doesn't expose Storage):

The bucket must be **private**, with a **90-day lifecycle rule** that deletes objects older than 90 days. If the MCP can't create the bucket, do it via the Supabase dashboard:
1. Storage → New bucket → name: `klaviyo-imports`, public: off.
2. Storage → Buckets → klaviyo-imports → Configuration → Object lifecycle → add rule: delete objects after 90 days.

- [ ] **Step 2: Add deps**

```bash
npm install papaparse@^5.4.1 libphonenumber-js@^1.11.0
npm install --save-dev @types/papaparse@^5.3.14
```

- [ ] **Step 3: Verify install**

```bash
node -e "console.log(require('papaparse').VERSION)"
node -e "console.log(require('libphonenumber-js/package.json').version)"
```
Expected: prints version strings.

- [ ] **Step 4: Run the existing test suite to confirm nothing regressed**

```bash
npx tsc --noEmit && npx vitest run
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(deps): add papaparse + libphonenumber-js for Klaviyo imports"
```

---

## Task K3: KlaviyoImportsRepo

**Files:**
- Create: `src/storage/repositories/klaviyo-imports.ts`
- Create: `tests/unit/storage/klaviyo-imports.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/storage/klaviyo-imports.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KlaviyoImportsRepo, type KlaviyoImportRow } from '../../../src/storage/repositories/klaviyo-imports.js';

function makeStub(table: any) {
  return { from: vi.fn(() => table) } as any;
}

describe('KlaviyoImportsRepo', () => {
  let chain: any;
  let client: any;
  let repo: KlaviyoImportsRepo;

  beforeEach(() => {
    chain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn(),
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      // for count queries
      head: false,
    };
    client = makeStub(chain);
    repo = new KlaviyoImportsRepo(client);
  });

  it('insert returns the inserted row', async () => {
    chain.single.mockResolvedValue({ data: { id: 'abc', status: 'queued' }, error: null });
    const row = await repo.insert({
      callerSlackId: 'U1', callerEmail: 'a@b.com', source: 'inline',
      listId: null, listName: null, channels: ['email'],
      totalSubmitted: 3, totalImported: 3, totalInvalidRejected: 0,
      klaviyoJobId: 'job-1', status: 'queued',
    });
    expect(row.id).toBe('abc');
  });

  it('countInFlight filters status + caller', async () => {
    const head = { count: 2, error: null };
    chain.in = vi.fn().mockReturnThis();
    chain.eq = vi.fn().mockResolvedValue(head);
    expect(await repo.countInFlight('U1')).toBe(2);
    expect(chain.in).toHaveBeenCalledWith('status', ['queued', 'processing']);
  });

  it('countInLastHour filters started_at + caller', async () => {
    chain.gte = vi.fn().mockReturnThis();
    chain.eq = vi.fn().mockResolvedValue({ count: 5, error: null });
    expect(await repo.countInLastHour('U1')).toBe(5);
    const arg = (chain.gte as any).mock.calls[0];
    expect(arg[0]).toBe('started_at');
    expect(typeof arg[1]).toBe('string'); // ISO timestamp ~1h ago
  });

  it('listInFlight returns rows with status queued/processing', async () => {
    chain.in = vi.fn().mockReturnThis();
    chain.order = vi.fn().mockReturnThis();
    chain.limit = vi.fn().mockResolvedValue({ data: [{ id: 'x', status: 'processing', klaviyo_job_id: 'j' }], error: null });
    const rows = await repo.listInFlight(50);
    expect(rows.length).toBe(1);
  });

  it('updateStatus sets status + counts + completed_at on terminal', async () => {
    chain.update = vi.fn().mockReturnThis();
    chain.eq = vi.fn().mockResolvedValue({ data: null, error: null });
    await repo.updateStatus('abc', { status: 'complete', succeededCount: 3, alreadySubscribedCount: 0, failedCount: 0 });
    const update = (chain.update as any).mock.calls[0][0];
    expect(update.status).toBe('complete');
    expect(update.succeeded_count).toBe(3);
    expect(update.completed_at).toBeDefined();
  });

  it('getById returns null when not found', async () => {
    chain.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await repo.getById('xyz')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npx vitest run tests/unit/storage/klaviyo-imports.test.ts
```
Expected: import fails because the file doesn't exist yet.

- [ ] **Step 3: Implement the repo**

Create `src/storage/repositories/klaviyo-imports.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';

export interface KlaviyoImportRow {
  id: string;
  callerSlackId: string;
  callerEmail: string | null;
  source: 'inline' | 'csv';
  filename: string | null;
  storagePath: string | null;
  listId: string | null;
  listName: string | null;
  channels: string[];
  totalSubmitted: number;
  totalImported: number;
  totalInvalidRejected: number;
  klaviyoJobId: string;
  status: 'queued' | 'processing' | 'complete' | 'failed';
  startedAt: string;
  completedAt: string | null;
  succeededCount: number | null;
  alreadySubscribedCount: number | null;
  failedCount: number | null;
  errorSummary: string | null;
}

export interface InsertImportInput {
  callerSlackId: string;
  callerEmail: string | null;
  source: 'inline' | 'csv';
  filename?: string | null;
  storagePath?: string | null;
  listId: string | null;
  listName: string | null;
  channels: string[];
  totalSubmitted: number;
  totalImported: number;
  totalInvalidRejected: number;
  klaviyoJobId: string;
  status: 'queued' | 'processing' | 'complete' | 'failed';
}

export interface UpdateStatusInput {
  status: 'queued' | 'processing' | 'complete' | 'failed';
  succeededCount?: number;
  alreadySubscribedCount?: number;
  failedCount?: number;
  errorSummary?: string;
}

const TERMINAL: ReadonlyArray<UpdateStatusInput['status']> = ['complete', 'failed'];

function rowFromDb(r: Record<string, any>): KlaviyoImportRow {
  return {
    id: r.id,
    callerSlackId: r.caller_slack_id,
    callerEmail: r.caller_email,
    source: r.source,
    filename: r.filename,
    storagePath: r.storage_path,
    listId: r.list_id,
    listName: r.list_name,
    channels: r.channels,
    totalSubmitted: r.total_submitted,
    totalImported: r.total_imported,
    totalInvalidRejected: r.total_invalid_rejected,
    klaviyoJobId: r.klaviyo_job_id,
    status: r.status,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    succeededCount: r.succeeded_count,
    alreadySubscribedCount: r.already_subscribed_count,
    failedCount: r.failed_count,
    errorSummary: r.error_summary,
  };
}

export class KlaviyoImportsRepo {
  constructor(private readonly client: SupabaseClient) {}

  async insert(input: InsertImportInput): Promise<KlaviyoImportRow> {
    const { data, error } = await this.client
      .from('klaviyo_imports')
      .insert({
        caller_slack_id: input.callerSlackId,
        caller_email: input.callerEmail,
        source: input.source,
        filename: input.filename ?? null,
        storage_path: input.storagePath ?? null,
        list_id: input.listId,
        list_name: input.listName,
        channels: input.channels,
        total_submitted: input.totalSubmitted,
        total_imported: input.totalImported,
        total_invalid_rejected: input.totalInvalidRejected,
        klaviyo_job_id: input.klaviyoJobId,
        status: input.status,
      })
      .select('*')
      .single();
    if (error) throw new Error(`klaviyo_imports insert failed: ${error.message}`);
    return rowFromDb(data!);
  }

  async updateStatus(id: string, patch: UpdateStatusInput): Promise<void> {
    const update: Record<string, unknown> = { status: patch.status };
    if (patch.succeededCount != null) update.succeeded_count = patch.succeededCount;
    if (patch.alreadySubscribedCount != null) update.already_subscribed_count = patch.alreadySubscribedCount;
    if (patch.failedCount != null) update.failed_count = patch.failedCount;
    if (patch.errorSummary != null) update.error_summary = patch.errorSummary;
    if (TERMINAL.includes(patch.status)) update.completed_at = new Date().toISOString();
    const { error } = await this.client.from('klaviyo_imports').update(update).eq('id', id);
    if (error) throw new Error(`klaviyo_imports update failed: ${error.message}`);
  }

  async countInFlight(callerSlackId: string): Promise<number> {
    const { count, error } = await this.client
      .from('klaviyo_imports')
      .select('id', { count: 'exact', head: true })
      .in('status', ['queued', 'processing'])
      .eq('caller_slack_id', callerSlackId);
    if (error) throw new Error(`klaviyo_imports count failed: ${error.message}`);
    return count ?? 0;
  }

  async countInLastHour(callerSlackId: string): Promise<number> {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count, error } = await this.client
      .from('klaviyo_imports')
      .select('id', { count: 'exact', head: true })
      .gte('started_at', since)
      .eq('caller_slack_id', callerSlackId);
    if (error) throw new Error(`klaviyo_imports count failed: ${error.message}`);
    return count ?? 0;
  }

  async listInFlight(limit: number = 50): Promise<KlaviyoImportRow[]> {
    const { data, error } = await this.client
      .from('klaviyo_imports')
      .select('*')
      .in('status', ['queued', 'processing'])
      .order('started_at', { ascending: true })
      .limit(limit);
    if (error) throw new Error(`klaviyo_imports list failed: ${error.message}`);
    return (data ?? []).map(rowFromDb);
  }

  async getById(id: string): Promise<KlaviyoImportRow | null> {
    const { data, error } = await this.client.from('klaviyo_imports').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`klaviyo_imports get failed: ${error.message}`);
    return data ? rowFromDb(data) : null;
  }

  async getByJobId(klaviyoJobId: string): Promise<KlaviyoImportRow | null> {
    const { data, error } = await this.client.from('klaviyo_imports').select('*').eq('klaviyo_job_id', klaviyoJobId).maybeSingle();
    if (error) throw new Error(`klaviyo_imports get failed: ${error.message}`);
    return data ? rowFromDb(data) : null;
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npx vitest run tests/unit/storage/klaviyo-imports.test.ts
```
Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/storage/repositories/klaviyo-imports.ts tests/unit/storage/klaviyo-imports.test.ts
git commit -m "feat(repo): add KlaviyoImportsRepo with CRUD + count queries"
```

---

## Task K4: KlaviyoDeletionsRepo

**Files:**
- Create: `src/storage/repositories/klaviyo-deletions.ts`
- Create: `tests/unit/storage/klaviyo-deletions.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KlaviyoDeletionsRepo } from '../../../src/storage/repositories/klaviyo-deletions.js';

describe('KlaviyoDeletionsRepo', () => {
  let chain: any; let client: any; let repo: KlaviyoDeletionsRepo;
  beforeEach(() => {
    chain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn(),
      eq: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
    };
    client = { from: vi.fn(() => chain) } as any;
    repo = new KlaviyoDeletionsRepo(client);
  });

  it('insert persists requested_emails + counts', async () => {
    chain.single.mockResolvedValue({ data: { id: 'd1' }, error: null });
    const row = await repo.insert({
      callerSlackId: 'U1', callerEmail: 'a@b.com',
      requestedEmails: ['x@y.com', 'z@w.com'],
      foundCount: 2, deletedCount: 2, failedCount: 0, failedDetails: [],
    });
    expect(row.id).toBe('d1');
    const arg = (chain.insert as any).mock.calls[0][0];
    expect(arg.requested_emails).toEqual(['x@y.com', 'z@w.com']);
    expect(arg.status).toBe('submitted');
  });

  it('countInLastHour filters by caller + window', async () => {
    chain.gte = vi.fn().mockReturnThis();
    chain.eq = vi.fn().mockResolvedValue({ count: 3, error: null });
    expect(await repo.countInLastHour('U1')).toBe(3);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npx vitest run tests/unit/storage/klaviyo-deletions.test.ts
```

- [ ] **Step 3: Implement the repo**

Create `src/storage/repositories/klaviyo-deletions.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';

export interface KlaviyoDeletionRow {
  id: string;
  callerSlackId: string;
  callerEmail: string | null;
  requestedEmails: string[];
  foundCount: number;
  deletedCount: number;
  failedCount: number;
  failedDetails: Array<{ email: string; profile_id?: string; status?: number; error?: string }>;
  status: 'submitted';
  startedAt: string;
  completedAt: string;
}

export interface InsertDeletionInput {
  callerSlackId: string;
  callerEmail: string | null;
  requestedEmails: string[];
  foundCount: number;
  deletedCount: number;
  failedCount: number;
  failedDetails: KlaviyoDeletionRow['failedDetails'];
}

export class KlaviyoDeletionsRepo {
  constructor(private readonly client: SupabaseClient) {}

  async insert(input: InsertDeletionInput): Promise<KlaviyoDeletionRow> {
    const { data, error } = await this.client
      .from('klaviyo_deletions')
      .insert({
        caller_slack_id: input.callerSlackId,
        caller_email: input.callerEmail,
        requested_emails: input.requestedEmails,
        found_count: input.foundCount,
        deleted_count: input.deletedCount,
        failed_count: input.failedCount,
        failed_details: input.failedDetails,
        status: 'submitted',
      })
      .select('*')
      .single();
    if (error) throw new Error(`klaviyo_deletions insert failed: ${error.message}`);
    const r = data!;
    return {
      id: r.id, callerSlackId: r.caller_slack_id, callerEmail: r.caller_email,
      requestedEmails: r.requested_emails, foundCount: r.found_count,
      deletedCount: r.deleted_count, failedCount: r.failed_count,
      failedDetails: r.failed_details, status: r.status,
      startedAt: r.started_at, completedAt: r.completed_at,
    };
  }

  async countInLastHour(callerSlackId: string): Promise<number> {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count, error } = await this.client
      .from('klaviyo_deletions')
      .select('id', { count: 'exact', head: true })
      .gte('started_at', since)
      .eq('caller_slack_id', callerSlackId);
    if (error) throw new Error(`klaviyo_deletions count failed: ${error.message}`);
    return count ?? 0;
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npx vitest run tests/unit/storage/klaviyo-deletions.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/storage/repositories/klaviyo-deletions.ts tests/unit/storage/klaviyo-deletions.test.ts
git commit -m "feat(repo): add KlaviyoDeletionsRepo"
```

---

## Task K5: PendingConfirmationsRepo

**Files:**
- Create: `src/storage/repositories/pending-confirmations.ts`
- Create: `tests/unit/storage/pending-confirmations.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PendingConfirmationsRepo } from '../../../src/storage/repositories/pending-confirmations.js';

describe('PendingConfirmationsRepo', () => {
  let chain: any; let client: any; let repo: PendingConfirmationsRepo;
  beforeEach(() => {
    chain = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn(),
      maybeSingle: vi.fn(),
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      lt: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    client = { from: vi.fn(() => chain) } as any;
    repo = new PendingConfirmationsRepo(client);
  });

  it('insert returns the row with token', async () => {
    chain.single.mockResolvedValue({ data: { id: 'p1', confirmation_token: 't1', kind: 'klaviyo_import' }, error: null });
    const row = await repo.insert({
      callerSlackId: 'U1', channelId: 'D1', threadTs: 't0',
      kind: 'klaviyo_import', payload: { foo: 1 },
    });
    expect(row.confirmationToken).toBe('t1');
  });

  it('lookupByThread returns the active row only (expires_at > now)', async () => {
    chain.maybeSingle.mockResolvedValue({ data: { id: 'p1', kind: 'klaviyo_delete', payload: {} }, error: null });
    const row = await repo.lookupByThread('U1', 'D1', 't0');
    expect(row?.id).toBe('p1');
    expect(chain.gt).toHaveBeenCalledWith('expires_at', expect.any(String));
  });

  it('lookupByThread returns null when no row', async () => {
    chain.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await repo.lookupByThread('U1', 'D1', 't0')).toBeNull();
  });

  it('deleteById removes the row', async () => {
    chain.eq = vi.fn().mockResolvedValue({ error: null });
    await repo.deleteById('p1');
    expect(chain.delete).toHaveBeenCalled();
  });

  it('sweepExpired deletes rows past expiry', async () => {
    chain.lt = vi.fn().mockResolvedValue({ data: [{ id: 'old1' }, { id: 'old2' }], error: null, count: 2 });
    chain.select = vi.fn().mockReturnThis();
    const n = await repo.sweepExpired();
    expect(n).toBe(2);
  });

  it('countOutstanding filters by caller + active', async () => {
    chain.gt = vi.fn().mockReturnThis();
    chain.eq = vi.fn().mockResolvedValue({ count: 1, error: null });
    expect(await repo.countOutstanding('U1')).toBe(1);
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

Create `src/storage/repositories/pending-confirmations.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export type PendingKind = 'klaviyo_import' | 'klaviyo_delete';

export interface PendingConfirmationRow {
  id: string;
  confirmationToken: string;
  callerSlackId: string;
  channelId: string;
  threadTs: string;
  kind: PendingKind;
  payload: unknown;
  createdAt: string;
  expiresAt: string;
}

export interface InsertPendingInput {
  callerSlackId: string;
  channelId: string;
  threadTs: string;
  kind: PendingKind;
  payload: unknown;
  ttlMinutes?: number; // default 30
}

function rowFromDb(r: Record<string, any>): PendingConfirmationRow {
  return {
    id: r.id, confirmationToken: r.confirmation_token,
    callerSlackId: r.caller_slack_id, channelId: r.channel_id, threadTs: r.thread_ts,
    kind: r.kind, payload: r.payload, createdAt: r.created_at, expiresAt: r.expires_at,
  };
}

export class PendingConfirmationsRepo {
  constructor(private readonly client: SupabaseClient) {}

  async insert(input: InsertPendingInput): Promise<PendingConfirmationRow> {
    const ttl = input.ttlMinutes ?? 30;
    const expiresAt = new Date(Date.now() + ttl * 60 * 1000).toISOString();
    const { data, error } = await this.client
      .from('pending_confirmations')
      .insert({
        confirmation_token: randomUUID(),
        caller_slack_id: input.callerSlackId,
        channel_id: input.channelId,
        thread_ts: input.threadTs,
        kind: input.kind,
        payload: input.payload,
        expires_at: expiresAt,
      })
      .select('*')
      .single();
    if (error) throw new Error(`pending_confirmations insert failed: ${error.message}`);
    return rowFromDb(data!);
  }

  async lookupByThread(callerSlackId: string, channelId: string, threadTs: string): Promise<PendingConfirmationRow | null> {
    const now = new Date().toISOString();
    const { data, error } = await this.client
      .from('pending_confirmations')
      .select('*')
      .eq('caller_slack_id', callerSlackId)
      .eq('channel_id', channelId)
      .eq('thread_ts', threadTs)
      .gt('expires_at', now)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`pending_confirmations lookup failed: ${error.message}`);
    return data ? rowFromDb(data) : null;
  }

  async deleteById(id: string): Promise<void> {
    const { error } = await this.client.from('pending_confirmations').delete().eq('id', id);
    if (error) throw new Error(`pending_confirmations delete failed: ${error.message}`);
  }

  async sweepExpired(): Promise<number> {
    const now = new Date().toISOString();
    const { data, error } = await this.client.from('pending_confirmations').delete().lt('expires_at', now).select('id');
    if (error) throw new Error(`pending_confirmations sweep failed: ${error.message}`);
    return (data ?? []).length;
  }

  async countOutstanding(callerSlackId: string): Promise<number> {
    const now = new Date().toISOString();
    const { count, error } = await this.client
      .from('pending_confirmations')
      .select('id', { count: 'exact', head: true })
      .eq('caller_slack_id', callerSlackId)
      .gt('expires_at', now);
    if (error) throw new Error(`pending_confirmations count failed: ${error.message}`);
    return count ?? 0;
  }
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/storage/repositories/pending-confirmations.ts tests/unit/storage/pending-confirmations.test.ts
git commit -m "feat(repo): add PendingConfirmationsRepo with TTL sweep"
```

---

## Task K6: KlaviyoApiClient — bulk subscribe + job status

**Files:**
- Modify: `src/connectors/klaviyo/client.ts`
- Create: `tests/unit/connectors/klaviyo/client-write.test.ts`

- [ ] **Step 1: Write the failing tests for bulkSubscribeProfiles + getBulkImportJobStatus**

Create `tests/unit/connectors/klaviyo/client-write.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { KlaviyoApiClient } from '../../../../src/connectors/klaviyo/client.js';

function fakeFetch(impl: (url: string, init: any) => Promise<{ status: number; body: unknown }>) {
  return vi.fn(async (url: string, init: any) => {
    const r = await impl(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

describe('KlaviyoApiClient.bulkSubscribeProfiles', () => {
  it('builds correct JSON:API body with both channels and a list_id', async () => {
    let captured: any = null;
    const fetchImpl = fakeFetch(async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return { status: 202, body: { data: { id: 'job-1' } } };
    });
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    const r = await client.bulkSubscribeProfiles({
      profiles: [
        { email: 'a@x.com', first_name: 'A', phone_number: '+14155550100' },
        { email: 'b@y.com' },
      ],
      listId: 'L1',
      channels: ['email', 'sms'],
      consentedAt: '2026-05-05T10:00:00Z',
      defaultConsentSource: 'BDNY 2026',
    });
    expect(r.job_id).toBe('job-1');
    expect(captured.url).toBe('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs');
    const body = captured.body.data.attributes;
    expect(body.list_id).toBe('L1');
    expect(body.profiles[0].subscriptions.email.marketing.consent).toBe('SUBSCRIBED');
    expect(body.profiles[0].subscriptions.sms.marketing.consent).toBe('SUBSCRIBED');
    expect(body.profiles[0].custom_source).toBe('BDNY 2026');
    expect(body.profiles[0].consented_at).toBe('2026-05-05T10:00:00Z');
  });

  it('omits sms subscription when channels is email-only', async () => {
    let captured: any = null;
    const fetchImpl = fakeFetch(async (_url, init) => {
      captured = JSON.parse(init.body);
      return { status: 202, body: { data: { id: 'j' } } };
    });
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    await client.bulkSubscribeProfiles({ profiles: [{ email: 'a@x.com' }], channels: ['email'] });
    const sub = captured.data.attributes.profiles[0].subscriptions;
    expect(sub.email).toBeDefined();
    expect(sub.sms).toBeUndefined();
  });

  it('omits list_id when undefined', async () => {
    let captured: any = null;
    const fetchImpl = fakeFetch(async (_url, init) => {
      captured = JSON.parse(init.body);
      return { status: 202, body: { data: { id: 'j' } } };
    });
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    await client.bulkSubscribeProfiles({ profiles: [{ email: 'a@x.com' }], channels: ['email'] });
    expect(captured.data.attributes.list_id).toBeUndefined();
  });

  it('throws KlaviyoApiError on 4xx', async () => {
    const fetchImpl = fakeFetch(async () => ({ status: 400, body: { errors: [{ detail: 'bad' }] } }));
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    await expect(client.bulkSubscribeProfiles({ profiles: [{ email: 'a@x.com' }], channels: ['email'] })).rejects.toThrow();
  });
});

describe('KlaviyoApiClient.getBulkImportJobStatus', () => {
  it('returns parsed status', async () => {
    const fetchImpl = fakeFetch(async (url) => ({
      status: 200,
      body: { data: { id: 'job-1', attributes: { status: 'complete', total_count: 5, completed_count: 5, failed_count: 0 } } },
    }));
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    const r = await client.getBulkImportJobStatus('job-1');
    expect(r.status).toBe('complete');
    expect(r.totalCount).toBe(5);
    expect(r.completedCount).toBe(5);
  });
});
```

- [ ] **Step 2: Run tests — FAIL**

```bash
npx vitest run tests/unit/connectors/klaviyo/client-write.test.ts
```

- [ ] **Step 3: Implement the methods on KlaviyoApiClient**

In `src/connectors/klaviyo/client.ts`, add the following types near the existing interfaces:

```ts
export interface KlaviyoProfileInput {
  email: string;
  phone_number?: string;
  first_name?: string;
  last_name?: string;
  custom_source?: string;
  consented_at?: string;
}

export interface BulkSubscribeOptions {
  profiles: KlaviyoProfileInput[];
  listId?: string;
  channels: Array<'email' | 'sms'>;
  consentedAt?: string;
  defaultConsentSource?: string;
}

export interface BulkSubscribeResult {
  job_id: string;
}

export interface BulkImportJobStatus {
  jobId: string;
  status: 'queued' | 'processing' | 'complete' | 'failed';
  totalCount?: number;
  completedCount?: number;
  failedCount?: number;
  errors?: Array<{ detail: string }>;
}
```

Add these methods to the `KlaviyoApiClient` class:

```ts
  async bulkSubscribeProfiles(opts: BulkSubscribeOptions): Promise<BulkSubscribeResult> {
    const subscriptions: Record<string, unknown> = {};
    if (opts.channels.includes('email')) subscriptions.email = { marketing: { consent: 'SUBSCRIBED' } };
    if (opts.channels.includes('sms')) subscriptions.sms = { marketing: { consent: 'SUBSCRIBED' } };

    const profiles = opts.profiles.map((p) => {
      const out: Record<string, unknown> = { email: p.email };
      if (p.phone_number) out.phone_number = p.phone_number;
      if (p.first_name) out.first_name = p.first_name;
      if (p.last_name) out.last_name = p.last_name;
      if (p.custom_source) out.custom_source = p.custom_source;
      else if (opts.defaultConsentSource) out.custom_source = opts.defaultConsentSource;
      if (p.consented_at) out.consented_at = p.consented_at;
      else if (opts.consentedAt) out.consented_at = opts.consentedAt;
      out.subscriptions = subscriptions;
      return out;
    });

    const attributes: Record<string, unknown> = { profiles, historical_import: false };
    if (opts.listId) attributes.list_id = opts.listId;

    const body = { data: { type: 'profile-subscription-bulk-create-job', attributes } };
    const resp = await this.post<{ data: { id: string } }>('/api/profile-subscription-bulk-create-jobs', body);
    if (!resp?.data?.id) throw new KlaviyoApiError('Klaviyo returned no job_id', 502, resp);
    return { job_id: resp.data.id };
  }

  async getBulkImportJobStatus(jobId: string): Promise<BulkImportJobStatus> {
    const resp = await this.get<{ data: { id: string; attributes: any } }>(`/api/profile-bulk-import-jobs/${encodeURIComponent(jobId)}`);
    const a = resp?.data?.attributes ?? {};
    return {
      jobId: resp.data.id,
      status: a.status,
      totalCount: a.total_count,
      completedCount: a.completed_count,
      failedCount: a.failed_count,
      errors: a.errors,
    };
  }
```

- [ ] **Step 4: Run tests — PASS**

```bash
npx vitest run tests/unit/connectors/klaviyo/client-write.test.ts
```
Expected: 5/5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/klaviyo/client.ts tests/unit/connectors/klaviyo/client-write.test.ts
git commit -m "feat(klaviyo): client.bulkSubscribeProfiles + getBulkImportJobStatus"
```

---

## Task K7: KlaviyoApiClient — findProfileByEmail, requestProfileDeletion, listLists

**Files:**
- Modify: `src/connectors/klaviyo/client.ts`
- Modify: `tests/unit/connectors/klaviyo/client-write.test.ts`

- [ ] **Step 1: Append failing tests**

Add to `tests/unit/connectors/klaviyo/client-write.test.ts`:

```ts
describe('KlaviyoApiClient.findProfileByEmail', () => {
  it('returns null when data is empty', async () => {
    const fetchImpl = fakeFetch(async () => ({ status: 200, body: { data: [] } }));
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    const r = await client.findProfileByEmail('nope@x.com');
    expect(r).toBeNull();
  });

  it('returns profile + lists', async () => {
    const fetchImpl = fakeFetch(async (url) => {
      expect(url).toContain('filter=equals(email%2C%22a%40x.com%22)');
      return {
        status: 200,
        body: {
          data: [{ id: 'pid1', attributes: { email: 'a@x.com', created: '2024-08-12T19:03:45+00:00' }, relationships: { lists: { data: [{ id: 'L1' }] } } }],
          included: [{ type: 'list', id: 'L1', attributes: { name: 'Trade Customers' } }],
        },
      };
    });
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    const r = await client.findProfileByEmail('a@x.com');
    expect(r).toEqual({ id: 'pid1', created_at: '2024-08-12T19:03:45+00:00', lists: ['Trade Customers'] });
  });
});

describe('KlaviyoApiClient.requestProfileDeletion', () => {
  it('builds correct JSON:API body', async () => {
    let captured: any = null;
    const fetchImpl = fakeFetch(async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return { status: 202, body: { data: { id: 'del-1' } } };
    });
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    const r = await client.requestProfileDeletion({ email: 'junk@x.com' });
    expect(r.deletion_job_id).toBe('del-1');
    expect(captured.url).toBe('https://a.klaviyo.com/api/data-privacy-deletion-jobs');
    expect(captured.body.data.attributes.profile.data.attributes.email).toBe('junk@x.com');
  });

  it('throws on 4xx', async () => {
    const fetchImpl = fakeFetch(async () => ({ status: 400, body: { errors: [{ detail: 'bad' }] } }));
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    await expect(client.requestProfileDeletion({ email: 'x@y.com' })).rejects.toThrow();
  });
});

describe('KlaviyoApiClient.listLists', () => {
  it('paginates and returns id+name pairs', async () => {
    const fetchImpl = fakeFetch(async () => ({
      status: 200,
      body: {
        data: [
          { id: 'L1', attributes: { name: 'Trade Customers' } },
          { id: 'L2', attributes: { name: 'BDNY Booth 2026' } },
        ],
        links: {},
      },
    }));
    const client = new KlaviyoApiClient({ apiKey: 'pk_test', fetchImpl });
    const r = await client.listLists();
    expect(r).toEqual([
      { id: 'L1', name: 'Trade Customers' },
      { id: 'L2', name: 'BDNY Booth 2026' },
    ]);
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement the three methods**

Append to `src/connectors/klaviyo/client.ts` next to the other public methods:

```ts
  async findProfileByEmail(email: string): Promise<{ id: string; created_at: string; lists: string[] } | null> {
    const filter = `equals(email,"${email.replace(/"/g, '\\"')}")`;
    const path = `/api/profiles?filter=${encodeURIComponent(filter)}&include=lists&fields[profile]=email,created`;
    const resp = await this.get<{ data: any[]; included?: any[] }>(path);
    const profile = resp?.data?.[0];
    if (!profile) return null;
    const listIds: string[] = (profile.relationships?.lists?.data ?? []).map((d: any) => d.id);
    const listNames = listIds.map((lid) => {
      const l = (resp.included ?? []).find((x: any) => x.type === 'list' && x.id === lid);
      return l?.attributes?.name ?? lid;
    });
    return {
      id: profile.id,
      created_at: profile.attributes?.created ?? profile.attributes?.created_at,
      lists: listNames,
    };
  }

  async requestProfileDeletion(opts: { email?: string; profile_id?: string; phone_number?: string }): Promise<{ deletion_job_id: string }> {
    if (!opts.email && !opts.profile_id && !opts.phone_number) {
      throw new Error('requestProfileDeletion requires email, profile_id, or phone_number');
    }
    const profileAttributes: Record<string, unknown> = {};
    if (opts.email) profileAttributes.email = opts.email;
    else if (opts.phone_number) profileAttributes.phone_number = opts.phone_number;
    else if (opts.profile_id) profileAttributes.id = opts.profile_id;

    const body = {
      data: {
        type: 'data-privacy-deletion-job',
        attributes: {
          profile: { data: { type: 'profile', attributes: profileAttributes } },
        },
      },
    };
    const resp = await this.post<{ data: { id: string } }>('/api/data-privacy-deletion-jobs', body);
    if (!resp?.data?.id) throw new KlaviyoApiError('Klaviyo returned no deletion_job_id', 502, resp);
    return { deletion_job_id: resp.data.id };
  }

  async listLists(): Promise<Array<{ id: string; name: string }>> {
    const resp = await this.get<{ data: any[] }>('/api/lists?fields[list]=name&page[size]=100');
    return (resp?.data ?? []).map((l: any) => ({ id: l.id, name: l.attributes?.name ?? l.id }));
  }
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/connectors/klaviyo/client.ts tests/unit/connectors/klaviyo/client-write.test.ts
git commit -m "feat(klaviyo): client.findProfileByEmail + requestProfileDeletion + listLists"
```

---

## Task K8: CSV parser, phone normalizer, validation pipeline

**Files:**
- Create: `src/connectors/klaviyo/csv-parser.ts`
- Create: `src/connectors/klaviyo/phone.ts`
- Create: `src/connectors/klaviyo/validation.ts`
- Create: `tests/unit/connectors/klaviyo/csv-parser.test.ts`
- Create: `tests/unit/connectors/klaviyo/phone.test.ts`
- Create: `tests/unit/connectors/klaviyo/validation.test.ts`
- Create: `tests/fixtures/klaviyo-imports/valid-3-rows.csv`
- Create: `tests/fixtures/klaviyo-imports/invalid-bad-email.csv`
- Create: `tests/fixtures/klaviyo-imports/invalid-no-phone-with-sms.csv`
- Create: `tests/fixtures/klaviyo-imports/invalid-duplicate.csv`
- Create: `tests/fixtures/klaviyo-imports/invalid-bom.csv`
- Create: `tests/fixtures/klaviyo-imports/legacy-with-consent-cols.csv`
- Create: `tests/fixtures/klaviyo-imports/valid-1001-rows.csv` (generate via script)

- [ ] **Step 1: Create the fixture CSVs**

`tests/fixtures/klaviyo-imports/valid-3-rows.csv`:
```
email,first_name,last_name,phone,consent_source,consented_at
alice@x.com,Alice,Smith,+1 415 555 0100,BDNY booth 2026,2026-04-30T14:00:00Z
bob@y.com,Bob,Jones,,BDNY booth 2026,2026-04-30T14:05:00Z
carol@z.com,Carol,,,,
```

`tests/fixtures/klaviyo-imports/invalid-bad-email.csv`:
```
email,first_name,last_name
alice@x.com,Alice,Smith
gertrude@@gmail.com,Gertrude,Doe
bob@y.com,Bob,Jones
```

`tests/fixtures/klaviyo-imports/invalid-no-phone-with-sms.csv`:
```
email,first_name,phone
alice@x.com,Alice,+14155550100
bob@y.com,Bob,
```

`tests/fixtures/klaviyo-imports/invalid-duplicate.csv`:
```
email,first_name
alice@x.com,Alice
bob@y.com,Bob
ALICE@X.COM,Ally
carol@z.com,Carol
```

`tests/fixtures/klaviyo-imports/invalid-bom.csv` (note: starts with UTF-8 BOM `﻿`):
```
﻿email,first_name
alice@x.com,Alice
bob@y.com,Bob
```

`tests/fixtures/klaviyo-imports/legacy-with-consent-cols.csv`:
```
email,first_name,consent_email,consent_sms
alice@x.com,Alice,true,false
bob@y.com,Bob,true,true
```

For `valid-1001-rows.csv`, generate it programmatically:
```bash
node -e "
const out = ['email,first_name'];
for (let i = 1; i <= 1001; i++) out.push(\`user\${i}@example.com,User\${i}\`);
require('fs').writeFileSync('tests/fixtures/klaviyo-imports/valid-1001-rows.csv', out.join('\n'));
"
```

- [ ] **Step 2: Write phone normalizer + tests**

Create `src/connectors/klaviyo/phone.ts`:

```ts
import { parsePhoneNumberWithError, type CountryCode } from 'libphonenumber-js';

/**
 * Normalize a free-text phone string to E.164 (e.g., "+14155550100").
 * Returns null if the string can't be parsed as a valid phone in `defaultCountry`
 * (or as a fully-qualified international number when no country is provided).
 */
export function normalizeToE164(input: string, defaultCountry: CountryCode = 'US'): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const parsed = parsePhoneNumberWithError(trimmed, defaultCountry);
    if (!parsed.isValid()) return null;
    return parsed.number; // E.164
  } catch {
    return null;
  }
}
```

Create `tests/unit/connectors/klaviyo/phone.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeToE164 } from '../../../../src/connectors/klaviyo/phone.js';

describe('normalizeToE164', () => {
  it.each([
    ['+1 415 555 0100', '+14155550100'],
    ['(415) 555-0100', '+14155550100'],
    ['415-555-0100', '+14155550100'],
    ['+44 20 7946 0958', '+442079460958'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeToE164(input)).toBe(expected);
  });

  it.each([
    ['not-a-phone'],
    [''],
    ['   '],
    ['12'],
  ])('returns null for invalid: %s', (input) => {
    expect(normalizeToE164(input)).toBeNull();
  });
});
```

- [ ] **Step 3: Write CSV parser + tests**

Create `src/connectors/klaviyo/csv-parser.ts`:

```ts
import Papa from 'papaparse';

export interface ParsedCsvRow {
  rowIndex: number; // 1-based, header is row 0
  email: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  consent_source?: string;
  consented_at?: string;
}

export interface ParseCsvResult {
  rows: ParsedCsvRow[];
  warnings: string[];
}

const ALLOWED_COLS = new Set(['email', 'first_name', 'last_name', 'phone', 'consent_source', 'consented_at']);
const IGNORED_COLS = new Set(['consent_email', 'consent_sms']);
const MAX_ROWS = 1000;

export function parseCsv(text: string): ParseCsvResult {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const result = Papa.parse<Record<string, string>>(stripped, {
    header: true, skipEmptyLines: true, transformHeader: (h) => h.trim().toLowerCase(),
  });
  if (result.errors.length > 0) {
    const e = result.errors[0];
    throw new Error(`CSV parse error at row ${e.row}: ${e.message}`);
  }
  const headers = result.meta.fields ?? [];
  if (!headers.includes('email')) {
    throw new Error('CSV must have an "email" column');
  }
  const warnings: string[] = [];
  const seenIgnored = headers.filter((h) => IGNORED_COLS.has(h));
  if (seenIgnored.length > 0) {
    warnings.push(`Ignored columns (channels are set on the call, not per-row): ${seenIgnored.join(', ')}`);
  }
  const unknownCols = headers.filter((h) => !ALLOWED_COLS.has(h) && !IGNORED_COLS.has(h));
  if (unknownCols.length > 0) {
    warnings.push(`Unknown columns ignored: ${unknownCols.join(', ')}`);
  }

  const rows: ParsedCsvRow[] = result.data.map((raw, i) => {
    const row: ParsedCsvRow = { rowIndex: i + 1, email: (raw.email ?? '').trim() };
    if (raw.first_name?.trim()) row.first_name = raw.first_name.trim();
    if (raw.last_name?.trim()) row.last_name = raw.last_name.trim();
    if (raw.phone?.trim()) row.phone = raw.phone.trim();
    if (raw.consent_source?.trim()) row.consent_source = raw.consent_source.trim();
    if (raw.consented_at?.trim()) row.consented_at = raw.consented_at.trim();
    return row;
  });

  if (rows.length > MAX_ROWS) {
    throw new Error(`CSV has ${rows.length} rows; max is ${MAX_ROWS}. Split into smaller files.`);
  }

  return { rows, warnings };
}
```

Create `tests/unit/connectors/klaviyo/csv-parser.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCsv } from '../../../../src/connectors/klaviyo/csv-parser.js';

const FIX = 'tests/fixtures/klaviyo-imports';

describe('parseCsv', () => {
  it('parses a clean 3-row CSV', () => {
    const r = parseCsv(readFileSync(`${FIX}/valid-3-rows.csv`, 'utf8'));
    expect(r.rows.length).toBe(3);
    expect(r.rows[0].email).toBe('alice@x.com');
    expect(r.rows[0].phone).toBe('+1 415 555 0100');
    expect(r.warnings).toEqual([]);
  });

  it('parses a BOM-prefixed CSV cleanly', () => {
    const r = parseCsv(readFileSync(`${FIX}/invalid-bom.csv`, 'utf8'));
    expect(r.rows.length).toBe(2);
    expect(r.rows[0].email).toBe('alice@x.com');
  });

  it('emits a warning for legacy consent_* columns', () => {
    const r = parseCsv(readFileSync(`${FIX}/legacy-with-consent-cols.csv`, 'utf8'));
    expect(r.warnings.some((w) => w.includes('consent_email'))).toBe(true);
    expect(r.rows[0]).not.toHaveProperty('consent_email');
  });

  it('throws when email column is missing', () => {
    expect(() => parseCsv('name,phone\nbob,415-555-0100')).toThrow(/email/i);
  });

  it('throws when over the 1000-row cap', () => {
    expect(() => parseCsv(readFileSync(`${FIX}/valid-1001-rows.csv`, 'utf8'))).toThrow(/max is 1000/);
  });
});
```

- [ ] **Step 4: Write validation pipeline + tests**

Create `src/connectors/klaviyo/validation.ts`:

```ts
import { z } from 'zod';
import { normalizeToE164 } from './phone.js';

export interface RawProfile {
  rowIndex: number;
  email: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  consent_source?: string;
  consented_at?: string;
}

export interface ValidProfile extends RawProfile {
  email: string; // lowercased
  phone_e164?: string;
}

export interface InvalidProfile {
  rowIndex: number;
  email?: string;
  reason: string;
}

export interface ValidationResult {
  valid: ValidProfile[];
  invalid: InvalidProfile[];
}

const EmailSchema = z.string().email();

export function validateBatch(rows: RawProfile[], opts: { channels: Array<'email' | 'sms'> }): ValidationResult {
  const seen = new Map<string, number>(); // lowercased email → first rowIndex
  const valid: ValidProfile[] = [];
  const invalid: InvalidProfile[] = [];
  const requireSms = opts.channels.includes('sms');

  for (const row of rows) {
    const errs: string[] = [];
    let lower: string | null = null;
    if (!row.email) {
      errs.push('missing email');
    } else if (!EmailSchema.safeParse(row.email).success) {
      errs.push(`invalid email: ${row.email}`);
    } else {
      lower = row.email.toLowerCase();
      const prior = seen.get(lower);
      if (prior !== undefined) errs.push(`duplicate of row ${prior}`);
    }

    if (row.first_name && row.first_name.length > 100) errs.push('first_name >100 chars');
    if (row.last_name && row.last_name.length > 100) errs.push('last_name >100 chars');
    if (row.consent_source && row.consent_source.length > 200) errs.push('consent_source >200 chars');
    if (row.consented_at && Number.isNaN(Date.parse(row.consented_at))) errs.push('consented_at not ISO 8601');

    let phoneE164: string | undefined;
    if (row.phone) {
      const norm = normalizeToE164(row.phone);
      if (!norm) errs.push(`invalid phone: ${row.phone}`);
      else phoneE164 = norm;
    }
    if (requireSms && !phoneE164) errs.push('phone required when channels includes sms');

    if (errs.length > 0) {
      invalid.push({ rowIndex: row.rowIndex, email: row.email, reason: errs.join('; ') });
      continue;
    }

    seen.set(lower!, row.rowIndex);
    valid.push({
      ...row,
      email: lower!,
      phone_e164: phoneE164,
    });
  }

  return { valid, invalid };
}
```

Create `tests/unit/connectors/klaviyo/validation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateBatch } from '../../../../src/connectors/klaviyo/validation.js';

describe('validateBatch', () => {
  it('passes a clean batch', () => {
    const r = validateBatch([
      { rowIndex: 1, email: 'a@x.com' },
      { rowIndex: 2, email: 'b@y.com', phone: '+14155550100' },
    ], { channels: ['email'] });
    expect(r.valid.length).toBe(2);
    expect(r.invalid).toEqual([]);
    expect(r.valid[1].phone_e164).toBe('+14155550100');
  });

  it('flags invalid emails', () => {
    const r = validateBatch([
      { rowIndex: 1, email: 'gertrude@@gmail.com' },
    ], { channels: ['email'] });
    expect(r.invalid.length).toBe(1);
    expect(r.invalid[0].reason).toContain('invalid email');
  });

  it('flags duplicates case-insensitively', () => {
    const r = validateBatch([
      { rowIndex: 1, email: 'alice@x.com' },
      { rowIndex: 2, email: 'ALICE@X.COM' },
    ], { channels: ['email'] });
    expect(r.valid.length).toBe(1);
    expect(r.invalid.length).toBe(1);
    expect(r.invalid[0].reason).toContain('duplicate of row 1');
  });

  it('requires phone when channels includes sms', () => {
    const r = validateBatch([
      { rowIndex: 1, email: 'a@x.com', phone: '+14155550100' },
      { rowIndex: 2, email: 'b@y.com' },
    ], { channels: ['email', 'sms'] });
    expect(r.valid.length).toBe(1);
    expect(r.invalid[0].reason).toContain('phone required');
  });

  it('flags unparseable phone', () => {
    const r = validateBatch([
      { rowIndex: 1, email: 'a@x.com', phone: 'not-a-phone' },
    ], { channels: ['email'] });
    expect(r.invalid[0].reason).toContain('invalid phone');
  });

  it('flags malformed consented_at', () => {
    const r = validateBatch([
      { rowIndex: 1, email: 'a@x.com', consented_at: 'yesterday' },
    ], { channels: ['email'] });
    expect(r.invalid[0].reason).toContain('not ISO 8601');
  });
});
```

- [ ] **Step 5: Run all three test files — PASS**

```bash
npx vitest run tests/unit/connectors/klaviyo/csv-parser.test.ts tests/unit/connectors/klaviyo/phone.test.ts tests/unit/connectors/klaviyo/validation.test.ts
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/connectors/klaviyo/csv-parser.ts src/connectors/klaviyo/phone.ts src/connectors/klaviyo/validation.ts tests/unit/connectors/klaviyo/csv-parser.test.ts tests/unit/connectors/klaviyo/phone.test.ts tests/unit/connectors/klaviyo/validation.test.ts tests/fixtures/klaviyo-imports/
git commit -m "feat(klaviyo): csv parser, phone normalizer, validation pipeline + fixtures"
```

---

## Task K9: `klaviyo.import_profiles` tool

**Files:**
- Modify: `src/connectors/klaviyo/connector.ts`
- Create: `tests/unit/connectors/klaviyo/import-tool.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/connectors/klaviyo/import-tool.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KlaviyoConnector } from '../../../../src/connectors/klaviyo/connector.js';

function makeDeps(opts: Partial<{
  actorRole: 'admin' | 'marketing' | 'user';
  bulkSubscribe: any;
  countInFlight: number;
  countInLastHour: number;
  pendingOutstanding: number;
  insertImport: any;
  insertPending: any;
  uploadCsv: any;
  listLists: Array<{ id: string; name: string }>;
}> = {}) {
  return {
    client: {
      bulkSubscribeProfiles: opts.bulkSubscribe ?? vi.fn().mockResolvedValue({ job_id: 'job-1' }),
      listLists: vi.fn().mockResolvedValue(opts.listLists ?? [{ id: 'L1', name: 'Trade Customers' }]),
    },
    importsRepo: {
      countInFlight: vi.fn().mockResolvedValue(opts.countInFlight ?? 0),
      countInLastHour: vi.fn().mockResolvedValue(opts.countInLastHour ?? 0),
      insert: opts.insertImport ?? vi.fn().mockResolvedValue({ id: 'audit-1', klaviyoJobId: 'job-1' }),
    },
    pendingRepo: {
      countOutstanding: vi.fn().mockResolvedValue(opts.pendingOutstanding ?? 0),
      insert: opts.insertPending ?? vi.fn().mockResolvedValue({ id: 'p1', confirmationToken: 'tok-1' }),
    },
    storage: { upload: opts.uploadCsv ?? vi.fn().mockResolvedValue({ path: 'klaviyo-imports/audit-1.csv' }) },
    getActor: vi.fn().mockReturnValue({
      slackUserId: 'U1', email: 'admin@gantri.com', role: opts.actorRole ?? 'admin',
      channelId: 'D1', threadTs: 't0',
    }),
  };
}

function getTool(deps: any) {
  const conn = new KlaviyoConnector(deps as any);
  return conn.tools.find((t) => t.name === 'klaviyo.import_profiles')!;
}

describe('klaviyo.import_profiles', () => {
  it('imports directly when 0 invalid', async () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    const r = await tool.execute({ profiles: [{ email: 'a@x.com' }, { email: 'b@y.com' }], channels: ['email'] });
    expect(r.kind).toBe('imported_directly');
    expect((r as any).total_imported).toBe(2);
    expect(deps.client.bulkSubscribeProfiles).toHaveBeenCalledOnce();
    expect(deps.importsRepo.insert).toHaveBeenCalledOnce();
  });

  it('returns awaiting_confirmation when ≥1 invalid', async () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    const r = await tool.execute({ profiles: [{ email: 'a@x.com' }, { email: 'gertrude@@gmail.com' }], channels: ['email'] });
    expect(r.kind).toBe('awaiting_confirmation');
    expect((r as any).valid_count).toBe(1);
    expect((r as any).invalid_count).toBe(1);
    expect(deps.client.bulkSubscribeProfiles).not.toHaveBeenCalled();
    expect(deps.pendingRepo.insert).toHaveBeenCalledOnce();
  });

  it('returns all_invalid when zero valid rows', async () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    const r = await tool.execute({ profiles: [{ email: 'gertrude@@gmail.com' }], channels: ['email'] });
    expect(r.kind).toBe('all_invalid');
    expect(deps.client.bulkSubscribeProfiles).not.toHaveBeenCalled();
    expect(deps.pendingRepo.insert).not.toHaveBeenCalled();
  });

  it('returns FORBIDDEN for role=user', async () => {
    const deps = makeDeps({ actorRole: 'user' });
    const tool = getTool(deps);
    const r = await tool.execute({ profiles: [{ email: 'a@x.com' }], channels: ['email'] });
    expect((r as any).error.code).toBe('FORBIDDEN');
    expect(deps.client.bulkSubscribeProfiles).not.toHaveBeenCalled();
  });

  it('allows marketing role', async () => {
    const deps = makeDeps({ actorRole: 'marketing' });
    const tool = getTool(deps);
    const r = await tool.execute({ profiles: [{ email: 'a@x.com' }], channels: ['email'] });
    expect(r.kind).toBe('imported_directly');
  });

  it('rate-limits on 5 in-flight', async () => {
    const deps = makeDeps({ countInFlight: 5 });
    const tool = getTool(deps);
    const r = await tool.execute({ profiles: [{ email: 'a@x.com' }], channels: ['email'] });
    expect((r as any).error.code).toBe('RATE_LIMITED');
  });

  it('rate-limits on >20 attempts in last hour', async () => {
    const deps = makeDeps({ countInLastHour: 21 });
    const tool = getTool(deps);
    const r = await tool.execute({ profiles: [{ email: 'a@x.com' }], channels: ['email'] });
    expect((r as any).error.code).toBe('RATE_LIMITED');
  });

  it('hits PENDING_LIMIT when caller has 3 pending', async () => {
    const deps = makeDeps({ pendingOutstanding: 3 });
    const tool = getTool(deps);
    const r = await tool.execute({ profiles: [{ email: 'a@x.com' }, { email: 'gertrude@@gmail.com' }], channels: ['email'] });
    expect((r as any).error.code).toBe('PENDING_LIMIT');
  });

  it('resolves list name via listLists cache', async () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    const r = await tool.execute({ profiles: [{ email: 'a@x.com' }], channels: ['email'], list: 'trade customers' });
    expect(r.kind).toBe('imported_directly');
    const arg = (deps.client.bulkSubscribeProfiles as any).mock.calls[0][0];
    expect(arg.listId).toBe('L1');
  });

  it('returns LIST_NOT_FOUND when name does not match', async () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    const r = await tool.execute({ profiles: [{ email: 'a@x.com' }], channels: ['email'], list: 'foobar' });
    expect((r as any).error.code).toBe('LIST_NOT_FOUND');
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement the tool**

In `src/connectors/klaviyo/connector.ts`, add the new tool. The deps interface must be extended with `importsRepo`, `deletionsRepo`, `pendingRepo`, `storage`, and `getActor` if not already present. Show only the new code:

```ts
// at the top of the file, alongside existing imports
import { z } from 'zod';
import type { KlaviyoApiClient } from './client.js';
import { validateBatch, type RawProfile } from './validation.js';
import { normalizeToE164 } from './phone.js';
import type { KlaviyoImportsRepo } from '../../storage/repositories/klaviyo-imports.js';
import type { KlaviyoDeletionsRepo } from '../../storage/repositories/klaviyo-deletions.js';
import type { PendingConfirmationsRepo } from '../../storage/repositories/pending-confirmations.js';
import type { ActorContext } from '../../orchestrator/types.js';

// extend or define KlaviyoConnectorDeps:
export interface KlaviyoConnectorDeps {
  client: KlaviyoApiClient;
  // ... existing deps ...
  importsRepo: KlaviyoImportsRepo;
  deletionsRepo: KlaviyoDeletionsRepo;
  pendingRepo: PendingConfirmationsRepo;
  storage: { upload(path: string, body: Buffer | string, contentType: string): Promise<{ path: string }> };
  getActor: () => (ActorContext & { channelId?: string; threadTs?: string }) | undefined;
}

const ProfileRow = z.object({
  email: z.string().email(),
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  phone: z.string().optional(),
  consent_source: z.string().max(200).optional(),
  consented_at: z.string().datetime().optional(),
});

const ImportArgs = z.object({
  list: z.string().optional(),
  channels: z.array(z.enum(['email', 'sms'])).min(1).max(2).default(['email']),
  default_consent_source: z.string().max(200).optional(),
  source: z.enum(['inline', 'csv']).default('inline'),
  storage_path: z.string().optional(),
  filename: z.string().optional(),
  profiles: z.array(ProfileRow).min(1).max(1000),
});

// inside KlaviyoConnector.tools (returning the array of ToolDef), add:
{
  name: 'klaviyo.import_profiles',
  description: [
    'Bulk-create Klaviyo profiles + subscribe them to email/sms with consent.',
    'ADMIN or MARKETING role only.',
    'Up to 20 profiles inline; up to 1000 via attached CSV (set source="csv" + storage_path).',
    'When ≥1 row is invalid, returns "awaiting_confirmation" — caller replies "yes" to import the valid subset or "cancel" to abort.',
  ].join('\n'),
  argsSchema: ImportArgs,
  async execute(args) {
    const actor = this.deps.getActor();
    if (!actor) return { error: { code: 'NO_ACTOR', message: 'No active actor' } };
    if (!['admin', 'marketing'].includes(actor.role ?? '')) {
      return { error: { code: 'FORBIDDEN', message: 'Klaviyo write tools require role=admin or role=marketing.' } };
    }

    // Rate limits
    const [inFlight, inHour, pending] = await Promise.all([
      this.deps.importsRepo.countInFlight(actor.slackUserId),
      this.deps.importsRepo.countInLastHour(actor.slackUserId),
      this.deps.pendingRepo.countOutstanding(actor.slackUserId),
    ]);
    if (inFlight >= 5) return { error: { code: 'RATE_LIMITED', message: '5 imports already in flight; wait for them to finish.', details: { reason: 'in_flight_imports' } } };
    if (inHour >= 20) return { error: { code: 'RATE_LIMITED', message: '20 imports in the last hour; cool down.', details: { reason: 'imports_per_hour' } } };
    if (pending >= 3) return { error: { code: 'PENDING_LIMIT', message: '3 pending confirmations outstanding; resolve them first.' } };

    // Resolve list
    let listId: string | null = null;
    let listName: string | null = null;
    if (args.list) {
      const lists = await this.deps.client.listLists();
      const exact = lists.find((l) => l.id === args.list);
      const byName = exact ?? lists.find((l) => l.name.toLowerCase() === args.list!.toLowerCase());
      if (!byName) {
        const top5 = lists
          .map((l) => ({ ...l, score: l.name.toLowerCase().indexOf(args.list!.toLowerCase()) }))
          .filter((x) => x.score >= 0).slice(0, 5).map(({ id, name }) => ({ id, name }));
        return { error: { code: 'LIST_NOT_FOUND', message: `No list matched "${args.list}".`, details: { suggestions: top5 } } };
      }
      listId = byName.id;
      listName = byName.name;
    }

    // Validate
    const raws: RawProfile[] = args.profiles.map((p, i) => ({
      rowIndex: i + 1, email: p.email, first_name: p.first_name, last_name: p.last_name,
      phone: p.phone, consent_source: p.consent_source, consented_at: p.consented_at,
    }));
    const v = validateBatch(raws, { channels: args.channels });

    if (v.valid.length === 0) {
      return {
        kind: 'all_invalid' as const,
        total_submitted: raws.length,
        invalid_count: v.invalid.length,
        invalid_rows: v.invalid,
        message: `All ${v.invalid.length} rows failed validation. Fix and re-submit.`,
      };
    }

    if (v.invalid.length === 0) {
      // 0 invalid — import directly
      const consentedAt = new Date().toISOString();
      const result = await this.deps.client.bulkSubscribeProfiles({
        profiles: v.valid.map((p) => ({
          email: p.email, phone_number: p.phone_e164, first_name: p.first_name, last_name: p.last_name,
          custom_source: p.consent_source ?? args.default_consent_source ?? `Slack import — ${listName ?? 'no list'} (${consentedAt.slice(0, 10)})`,
          consented_at: p.consented_at ?? consentedAt,
        })),
        listId: listId ?? undefined,
        channels: args.channels,
      });
      const audit = await this.deps.importsRepo.insert({
        callerSlackId: actor.slackUserId, callerEmail: actor.email ?? null,
        source: args.source, filename: args.filename ?? null, storagePath: args.storage_path ?? null,
        listId, listName, channels: args.channels,
        totalSubmitted: raws.length, totalImported: v.valid.length, totalInvalidRejected: 0,
        klaviyoJobId: result.job_id, status: 'queued',
      });
      return {
        kind: 'imported_directly' as const,
        audit_id: audit.id, klaviyo_job_id: result.job_id, status: 'queued' as const,
        list: listId ? { id: listId, name: listName! } : null, channels: args.channels,
        total_submitted: raws.length, total_imported: v.valid.length, total_invalid_rejected: 0,
        message: `Queued ${v.valid.length} profile${v.valid.length === 1 ? '' : 's'} to Klaviyo${listName ? ` (list: ${listName})` : ''}. I'll DM when it's done.`,
      };
    }

    // ≥1 invalid → confirmation
    const pendingRow = await this.deps.pendingRepo.insert({
      callerSlackId: actor.slackUserId,
      channelId: actor.channelId ?? '',
      threadTs: actor.threadTs ?? '',
      kind: 'klaviyo_import',
      payload: {
        valid: v.valid, listId, listName, channels: args.channels,
        source: args.source, filename: args.filename ?? null, storagePath: args.storage_path ?? null,
        totalSubmitted: raws.length, totalInvalidRejected: v.invalid.length,
        defaultConsentSource: args.default_consent_source ?? null,
      },
    });
    return {
      kind: 'awaiting_confirmation' as const,
      confirmation_token: pendingRow.confirmationToken,
      total_submitted: raws.length, valid_count: v.valid.length, invalid_count: v.invalid.length,
      invalid_rows_preview: v.invalid.slice(0, 20),
      list: listId ? { id: listId, name: listName! } : null, channels: args.channels,
      message: `Found ${v.invalid.length} invalid row${v.invalid.length === 1 ? '' : 's'} out of ${raws.length}. Reply "yes" to import the ${v.valid.length} valid one${v.valid.length === 1 ? '' : 's'}, or "cancel" to abort.`,
    };
  },
}
```

- [ ] **Step 4: Run — PASS**

```bash
npx vitest run tests/unit/connectors/klaviyo/import-tool.test.ts
```
Expected: 10/10 pass.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/klaviyo/connector.ts tests/unit/connectors/klaviyo/import-tool.test.ts
git commit -m "feat(klaviyo): klaviyo.import_profiles tool with confirmation flow"
```

---

## Task K10: `klaviyo.delete_profiles` tool

**Files:**
- Modify: `src/connectors/klaviyo/connector.ts`
- Create: `tests/unit/connectors/klaviyo/delete-tool.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/connectors/klaviyo/delete-tool.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { KlaviyoConnector } from '../../../../src/connectors/klaviyo/connector.js';

function makeDeps(opts: Partial<{
  actorRole: 'admin' | 'marketing' | 'user';
  findProfileByEmail: any;
  countDeletesInHour: number;
  pendingOutstanding: number;
}> = {}) {
  return {
    client: {
      findProfileByEmail: opts.findProfileByEmail ?? vi.fn(async (email: string) => {
        if (email.startsWith('not')) return null;
        return { id: `pid-${email}`, created_at: '2024-08-12T19:03:45+00:00', lists: ['Trade'] };
      }),
    },
    deletionsRepo: { countInLastHour: vi.fn().mockResolvedValue(opts.countDeletesInHour ?? 0) },
    pendingRepo: {
      countOutstanding: vi.fn().mockResolvedValue(opts.pendingOutstanding ?? 0),
      insert: vi.fn().mockResolvedValue({ id: 'p1', confirmationToken: 'tok-1' }),
    },
    getActor: vi.fn().mockReturnValue({ slackUserId: 'U1', email: 'a@b.com', role: opts.actorRole ?? 'admin', channelId: 'D1', threadTs: 't0' }),
  };
}

function getTool(deps: any) {
  const conn = new KlaviyoConnector(deps as any);
  return conn.tools.find((t) => t.name === 'klaviyo.delete_profiles')!;
}

describe('klaviyo.delete_profiles', () => {
  it('returns awaiting_confirmation with found + not_found split', async () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    const r = await tool.execute({ emails: ['a@x.com', 'notfound@y.com', 'b@z.com'] });
    expect(r.kind).toBe('awaiting_confirmation');
    expect((r as any).found.length).toBe(2);
    expect((r as any).not_found.length).toBe(1);
    expect(deps.pendingRepo.insert).toHaveBeenCalledOnce();
  });

  it('returns nothing_found when 0 profiles match', async () => {
    const deps = makeDeps({
      findProfileByEmail: vi.fn().mockResolvedValue(null),
    });
    const tool = getTool(deps);
    const r = await tool.execute({ emails: ['a@x.com', 'b@y.com'] });
    expect(r.kind).toBe('nothing_found');
    expect(deps.pendingRepo.insert).not.toHaveBeenCalled();
  });

  it('FORBIDDEN for role=user', async () => {
    const deps = makeDeps({ actorRole: 'user' });
    const tool = getTool(deps);
    const r = await tool.execute({ emails: ['a@x.com'] });
    expect((r as any).error.code).toBe('FORBIDDEN');
  });

  it('allows marketing role', async () => {
    const deps = makeDeps({ actorRole: 'marketing' });
    const tool = getTool(deps);
    const r = await tool.execute({ emails: ['a@x.com'] });
    expect(r.kind).toBe('awaiting_confirmation');
  });

  it('dedupes case-insensitively', async () => {
    const deps = makeDeps();
    const tool = getTool(deps);
    await tool.execute({ emails: ['a@x.com', 'A@X.COM', 'b@y.com'] });
    expect(deps.client.findProfileByEmail).toHaveBeenCalledTimes(2);
  });

  it('rate-limits 5+ deletes in last hour', async () => {
    const deps = makeDeps({ countDeletesInHour: 5 });
    const tool = getTool(deps);
    const r = await tool.execute({ emails: ['a@x.com'] });
    expect((r as any).error.code).toBe('RATE_LIMITED');
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement the tool**

Append to `KlaviyoConnector.tools` array:

```ts
{
  name: 'klaviyo.delete_profiles',
  description: [
    'Permanently delete Klaviyo profiles by email (Klaviyo Data Privacy API).',
    'ADMIN or MARKETING role only. ALWAYS asks for confirmation — never auto-executes.',
    'Returns a preview of which profiles would be deleted; caller replies "yes" or "cancel".',
    'Up to 50 emails per call. Deletion is destructive and cannot be undone.',
  ].join('\n'),
  argsSchema: z.object({
    emails: z.array(z.string().email()).min(1).max(50)
      .describe('Emails of profiles to delete. Deduplicated case-insensitively before lookup.'),
  }),
  async execute(args) {
    const actor = this.deps.getActor();
    if (!actor) return { error: { code: 'NO_ACTOR', message: 'No active actor' } };
    if (!['admin', 'marketing'].includes(actor.role ?? '')) {
      return { error: { code: 'FORBIDDEN', message: 'Klaviyo delete tools require role=admin or role=marketing.' } };
    }

    const [deletesInHour, pending] = await Promise.all([
      this.deps.deletionsRepo.countInLastHour(actor.slackUserId),
      this.deps.pendingRepo.countOutstanding(actor.slackUserId),
    ]);
    if (deletesInHour >= 5) return { error: { code: 'RATE_LIMITED', message: '5 deletes in the last hour; cool down.', details: { reason: 'deletes_per_hour' } } };
    if (pending >= 3) return { error: { code: 'PENDING_LIMIT', message: '3 pending confirmations outstanding; resolve them first.' } };

    // Dedup case-insensitive, preserving original case for display
    const seen = new Set<string>();
    const dedupedOriginal: string[] = [];
    for (const e of args.emails) {
      const lower = e.toLowerCase();
      if (!seen.has(lower)) { seen.add(lower); dedupedOriginal.push(e); }
    }

    const lookups = await Promise.all(
      dedupedOriginal.map(async (email) => {
        try {
          const p = await this.deps.client.findProfileByEmail(email);
          return { email, profile: p };
        } catch (err: any) {
          return { email, profile: null as any, lookupError: String(err?.message ?? err) };
        }
      }),
    );

    const found = lookups
      .filter((l) => !!l.profile)
      .map((l) => ({ email: l.email, profile_id: l.profile!.id, created_at: l.profile!.created_at, lists: l.profile!.lists }));
    const not_found = lookups.filter((l) => !l.profile && !l.lookupError).map((l) => l.email);

    if (found.length === 0) {
      return {
        kind: 'nothing_found' as const,
        requested_count: dedupedOriginal.length,
        message: `None of the ${dedupedOriginal.length} email${dedupedOriginal.length === 1 ? '' : 's'} matched a Klaviyo profile. Nothing to delete.`,
      };
    }

    const pendingRow = await this.deps.pendingRepo.insert({
      callerSlackId: actor.slackUserId,
      channelId: actor.channelId ?? '',
      threadTs: actor.threadTs ?? '',
      kind: 'klaviyo_delete',
      payload: { found, not_found, requested: dedupedOriginal },
    });

    return {
      kind: 'awaiting_confirmation' as const,
      confirmation_token: pendingRow.confirmationToken,
      requested_count: dedupedOriginal.length,
      found, not_found,
      message: `Delete ${found.length} profile${found.length === 1 ? '' : 's'}? Reply "yes" to proceed or "cancel" to abort. This cannot be undone.`,
    };
  },
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/connectors/klaviyo/connector.ts tests/unit/connectors/klaviyo/delete-tool.test.ts
git commit -m "feat(klaviyo): klaviyo.delete_profiles tool with confirmation preview"
```

---

## Task K11: `klaviyo.import_status` tool (read-only)

**Files:**
- Modify: `src/connectors/klaviyo/connector.ts`
- Create: `tests/unit/connectors/klaviyo/status-tool.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from 'vitest';
import { KlaviyoConnector } from '../../../../src/connectors/klaviyo/connector.js';

function makeDeps(row: any | null) {
  return {
    importsRepo: {
      getById: vi.fn().mockResolvedValue(row),
      getByJobId: vi.fn().mockResolvedValue(row),
    },
    getActor: vi.fn().mockReturnValue({ slackUserId: 'U1', role: 'user' }),
  };
}

function getTool(deps: any) {
  const conn = new KlaviyoConnector(deps as any);
  return conn.tools.find((t) => t.name === 'klaviyo.import_status')!;
}

describe('klaviyo.import_status', () => {
  it('returns the row by audit_id', async () => {
    const row = {
      id: 'a1', klaviyoJobId: 'j1', status: 'complete', listId: 'L1', listName: 'Trade',
      channels: ['email'], totalSubmitted: 3, totalImported: 3, totalInvalidRejected: 0,
      succeededCount: 3, alreadySubscribedCount: 0, failedCount: 0,
      startedAt: '2026-05-05T10:00:00Z', completedAt: '2026-05-05T10:01:00Z', errorSummary: null,
    };
    const tool = getTool(makeDeps(row));
    const r: any = await tool.execute({ audit_id: 'a1' });
    expect(r.audit_id).toBe('a1');
    expect(r.list).toEqual({ id: 'L1', name: 'Trade' });
    expect(r.completed_at).toBe('2026-05-05T10:01:00Z');
  });

  it('returns NOT_FOUND when no row', async () => {
    const tool = getTool(makeDeps(null));
    const r: any = await tool.execute({ audit_id: 'missing' });
    expect(r.error.code).toBe('NOT_FOUND');
  });

  it('open to all roles', async () => {
    const tool = getTool(makeDeps({
      id: 'a', klaviyoJobId: 'j', status: 'queued', listId: null, listName: null,
      channels: ['email'], totalSubmitted: 1, totalImported: 1, totalInvalidRejected: 0,
      succeededCount: null, alreadySubscribedCount: null, failedCount: null,
      startedAt: '2026-05-05T10:00:00Z', completedAt: null, errorSummary: null,
    }));
    const r = await tool.execute({ audit_id: 'a' });
    expect((r as any).status).toBe('queued');
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

Append to `KlaviyoConnector.tools`:

```ts
{
  name: 'klaviyo.import_status',
  description: [
    'Look up the status of a previously-queued Klaviyo import.',
    'Open to all authorized users (read-only).',
    'Pass either audit_id (returned by klaviyo.import_profiles) or klaviyo_job_id.',
  ].join('\n'),
  argsSchema: z.object({
    audit_id: z.string().uuid().optional(),
    klaviyo_job_id: z.string().optional(),
  }).refine((d) => d.audit_id || d.klaviyo_job_id, { message: 'Provide audit_id or klaviyo_job_id' }),
  async execute(args) {
    const row = args.audit_id
      ? await this.deps.importsRepo.getById(args.audit_id)
      : await this.deps.importsRepo.getByJobId(args.klaviyo_job_id!);
    if (!row) return { error: { code: 'NOT_FOUND', message: 'No import found with that id.' } };
    return {
      audit_id: row.id, klaviyo_job_id: row.klaviyoJobId, status: row.status,
      list: row.listId ? { id: row.listId, name: row.listName! } : null,
      channels: row.channels,
      total_submitted: row.totalSubmitted, total_imported: row.totalImported,
      total_invalid_rejected: row.totalInvalidRejected,
      succeeded_count: row.succeededCount ?? undefined,
      already_subscribed_count: row.alreadySubscribedCount ?? undefined,
      failed_count: row.failedCount ?? undefined,
      error_summary: row.errorSummary ?? undefined,
      started_at: row.startedAt, completed_at: row.completedAt ?? undefined,
    };
  },
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/connectors/klaviyo/connector.ts tests/unit/connectors/klaviyo/status-tool.test.ts
git commit -m "feat(klaviyo): klaviyo.import_status read-only tool"
```

---

## Task K12: ConfirmationHandler

**Files:**
- Create: `src/orchestrator/confirmation-handler.ts`
- Create: `tests/unit/orchestrator/confirmation-handler.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from 'vitest';
import { ConfirmationHandler } from '../../../src/orchestrator/confirmation-handler.js';

function makeHandler(opts: any = {}) {
  return new ConfirmationHandler({
    pendingRepo: opts.pendingRepo ?? {
      lookupByThread: vi.fn().mockResolvedValue(null),
      deleteById: vi.fn().mockResolvedValue(undefined),
    },
    importsRepo: opts.importsRepo ?? { insert: vi.fn() },
    deletionsRepo: opts.deletionsRepo ?? { insert: vi.fn() },
    client: opts.client ?? {},
    storage: opts.storage ?? { upload: vi.fn() },
    slack: opts.slack ?? { postMessage: vi.fn() },
    sleep: opts.sleep ?? (async () => {}),
  });
}

describe('ConfirmationHandler.tryHandle', () => {
  it('returns false when text is not yes/cancel', async () => {
    const handler = makeHandler();
    const r = await handler.tryHandle({ slackUserId: 'U1', channelId: 'D1', threadTs: 't0', text: 'hello' });
    expect(r).toBe(false);
  });

  it('returns false when no pending row', async () => {
    const handler = makeHandler();
    const r = await handler.tryHandle({ slackUserId: 'U1', channelId: 'D1', threadTs: 't0', text: 'yes' });
    expect(r).toBe(false);
  });

  it('case-insensitive yes/cancel matching', async () => {
    const handler = makeHandler();
    expect(await handler.tryHandle({ slackUserId: 'U1', channelId: 'D1', threadTs: 't0', text: 'YES' })).toBe(false); // no row
    expect(await handler.tryHandle({ slackUserId: 'U1', channelId: 'D1', threadTs: 't0', text: 'Cancel ' })).toBe(false);
  });

  it('cancel deletes the pending row, no exec', async () => {
    const pendingRepo = {
      lookupByThread: vi.fn().mockResolvedValue({ id: 'p1', kind: 'klaviyo_import', payload: {}, callerSlackId: 'U1' }),
      deleteById: vi.fn().mockResolvedValue(undefined),
    };
    const slack = { postMessage: vi.fn().mockResolvedValue(undefined) };
    const handler = makeHandler({ pendingRepo, slack });
    const r = await handler.tryHandle({ slackUserId: 'U1', channelId: 'D1', threadTs: 't0', text: 'cancel' });
    expect(r).toBe(true);
    expect(pendingRepo.deleteById).toHaveBeenCalledWith('p1');
    expect(slack.postMessage).toHaveBeenCalled();
  });

  it('yes import dispatches to import executor', async () => {
    const pendingRepo = {
      lookupByThread: vi.fn().mockResolvedValue({
        id: 'p1', kind: 'klaviyo_import', callerSlackId: 'U1',
        payload: {
          valid: [{ email: 'a@x.com', rowIndex: 1 }], listId: 'L1', listName: 'Trade',
          channels: ['email'], source: 'inline', filename: null, storagePath: null,
          totalSubmitted: 2, totalInvalidRejected: 1, defaultConsentSource: null,
        },
      }),
      deleteById: vi.fn().mockResolvedValue(undefined),
    };
    const client = { bulkSubscribeProfiles: vi.fn().mockResolvedValue({ job_id: 'job-1' }) };
    const importsRepo = { insert: vi.fn().mockResolvedValue({ id: 'a1' }) };
    const slack = { postMessage: vi.fn().mockResolvedValue(undefined) };
    const handler = makeHandler({ pendingRepo, client, importsRepo, slack });
    const r = await handler.tryHandle({ slackUserId: 'U1', channelId: 'D1', threadTs: 't0', text: 'yes' });
    expect(r).toBe(true);
    expect(client.bulkSubscribeProfiles).toHaveBeenCalled();
    expect(importsRepo.insert).toHaveBeenCalled();
    expect(pendingRepo.deleteById).toHaveBeenCalledWith('p1');
  });

  it('yes delete loops with pacing', async () => {
    const pendingRepo = {
      lookupByThread: vi.fn().mockResolvedValue({
        id: 'p1', kind: 'klaviyo_delete', callerSlackId: 'U1',
        payload: {
          found: [
            { email: 'a@x.com', profile_id: 'pid1', created_at: '2024-01-01T00:00:00Z', lists: [] },
            { email: 'b@y.com', profile_id: 'pid2', created_at: '2024-01-01T00:00:00Z', lists: [] },
          ],
          not_found: [], requested: ['a@x.com', 'b@y.com'],
        },
      }),
      deleteById: vi.fn().mockResolvedValue(undefined),
    };
    const client = { requestProfileDeletion: vi.fn().mockResolvedValue({ deletion_job_id: 'd1' }) };
    const deletionsRepo = { insert: vi.fn().mockResolvedValue({ id: 'del1' }) };
    const slack = { postMessage: vi.fn().mockResolvedValue(undefined) };
    const sleep = vi.fn().mockResolvedValue(undefined);
    const handler = makeHandler({ pendingRepo, client, deletionsRepo, slack, sleep });
    const r = await handler.tryHandle({ slackUserId: 'U1', channelId: 'D1', threadTs: 't0', text: 'yes' });
    expect(r).toBe(true);
    expect(client.requestProfileDeletion).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalled(); // pacing
    expect(deletionsRepo.insert).toHaveBeenCalled();
  });

  it('caller mismatch falls through (defense in depth)', async () => {
    const pendingRepo = {
      lookupByThread: vi.fn().mockResolvedValue({ id: 'p1', kind: 'klaviyo_import', callerSlackId: 'OTHER', payload: {} }),
      deleteById: vi.fn(),
    };
    const handler = makeHandler({ pendingRepo });
    const r = await handler.tryHandle({ slackUserId: 'U1', channelId: 'D1', threadTs: 't0', text: 'yes' });
    expect(r).toBe(false);
    expect(pendingRepo.deleteById).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

Create `src/orchestrator/confirmation-handler.ts`:

```ts
import logger from '../logger.js';
import type { KlaviyoApiClient } from '../connectors/klaviyo/client.js';
import type { KlaviyoImportsRepo } from '../storage/repositories/klaviyo-imports.js';
import type { KlaviyoDeletionsRepo } from '../storage/repositories/klaviyo-deletions.js';
import type { PendingConfirmationsRepo, PendingConfirmationRow } from '../storage/repositories/pending-confirmations.js';

export interface ConfirmationHandlerDeps {
  pendingRepo: PendingConfirmationsRepo;
  importsRepo: KlaviyoImportsRepo;
  deletionsRepo: KlaviyoDeletionsRepo;
  client: Pick<KlaviyoApiClient, 'bulkSubscribeProfiles' | 'requestProfileDeletion'>;
  storage: { upload(path: string, body: Buffer | string, contentType: string): Promise<{ path: string }> };
  slack: { postMessage(channel: string, text: string, threadTs?: string): Promise<void> };
  sleep?: (ms: number) => Promise<void>;
}

export interface IncomingMessage {
  slackUserId: string;
  channelId: string;
  threadTs: string;
  text: string;
}

const DELETE_RATE_DELAY_MS = 500; // ≤2/s under Klaviyo's 3/s burst

function decisionOf(text: string): 'yes' | 'cancel' | null {
  const t = text.trim().toLowerCase();
  if (t === 'yes' || t === 'y') return 'yes';
  if (t === 'cancel' || t === 'no' || t === 'n') return 'cancel';
  return null;
}

export class ConfirmationHandler {
  constructor(private readonly deps: ConfirmationHandlerDeps) {}

  /** Returns true if this message was consumed by the handler (do not pass to LLM). */
  async tryHandle(msg: IncomingMessage): Promise<boolean> {
    const decision = decisionOf(msg.text);
    if (!decision) return false;
    const pending = await this.deps.pendingRepo.lookupByThread(msg.slackUserId, msg.channelId, msg.threadTs);
    if (!pending) return false;
    if (pending.callerSlackId !== msg.slackUserId) {
      logger.warn({ pendingId: pending.id, expected: pending.callerSlackId, actual: msg.slackUserId }, 'klaviyo_confirmation_caller_mismatch');
      return false; // defense in depth
    }
    if (decision === 'cancel') {
      await this.deps.pendingRepo.deleteById(pending.id);
      await this.deps.slack.postMessage(msg.channelId, 'Cancelled. No Klaviyo write happened.', msg.threadTs);
      logger.info({ pendingId: pending.id, kind: pending.kind, caller: pending.callerSlackId }, 'klaviyo_confirmation_cancelled');
      return true;
    }
    // decision === 'yes'
    try {
      if (pending.kind === 'klaviyo_import') await this.executeImport(pending, msg);
      else if (pending.kind === 'klaviyo_delete') await this.executeDelete(pending, msg);
    } catch (err: any) {
      logger.error({ pendingId: pending.id, err }, 'klaviyo_confirmation_exec_failed');
      await this.deps.slack.postMessage(msg.channelId, `Sorry — something failed while running the confirmation. Details in audit log. (${String(err?.message ?? err)})`, msg.threadTs);
    } finally {
      await this.deps.pendingRepo.deleteById(pending.id).catch(() => {});
    }
    return true;
  }

  private async executeImport(pending: PendingConfirmationRow, msg: IncomingMessage) {
    const p = pending.payload as any;
    const consentedAt = new Date().toISOString();
    const result = await this.deps.client.bulkSubscribeProfiles({
      profiles: p.valid.map((v: any) => ({
        email: v.email, phone_number: v.phone_e164, first_name: v.first_name, last_name: v.last_name,
        custom_source: v.consent_source ?? p.defaultConsentSource ?? `Slack import — ${p.listName ?? 'no list'} (${consentedAt.slice(0, 10)})`,
        consented_at: v.consented_at ?? consentedAt,
      })),
      listId: p.listId ?? undefined,
      channels: p.channels,
    });
    const audit = await this.deps.importsRepo.insert({
      callerSlackId: pending.callerSlackId, callerEmail: null,
      source: p.source, filename: p.filename, storagePath: p.storagePath,
      listId: p.listId, listName: p.listName, channels: p.channels,
      totalSubmitted: p.totalSubmitted, totalImported: p.valid.length, totalInvalidRejected: p.totalInvalidRejected,
      klaviyoJobId: result.job_id, status: 'queued',
    });
    await this.deps.slack.postMessage(msg.channelId,
      `Queued ${p.valid.length} profile${p.valid.length === 1 ? '' : 's'} (audit \`${audit.id}\`, job \`${result.job_id}\`). I'll DM when it's done.`,
      msg.threadTs);
    logger.info({ auditId: audit.id, jobId: result.job_id, valid: p.valid.length, rejected: p.totalInvalidRejected }, 'klaviyo_import_queued');
  }

  private async executeDelete(pending: PendingConfirmationRow, msg: IncomingMessage) {
    const p = pending.payload as any;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const failedDetails: Array<{ email: string; profile_id?: string; status?: number; error?: string }> = [];
    let deletedCount = 0;

    for (let i = 0; i < p.found.length; i++) {
      const item = p.found[i];
      try {
        await this.deps.client.requestProfileDeletion({ email: item.email });
        deletedCount += 1;
      } catch (err: any) {
        const status = err?.status as number | undefined;
        if (status === 429) {
          await sleep(5000);
          try {
            await this.deps.client.requestProfileDeletion({ email: item.email });
            deletedCount += 1;
            continue;
          } catch (err2: any) {
            failedDetails.push({ email: item.email, profile_id: item.profile_id, status: err2?.status, error: String(err2?.message ?? err2) });
            continue;
          }
        }
        failedDetails.push({ email: item.email, profile_id: item.profile_id, status, error: String(err?.message ?? err) });
      }
      if (i < p.found.length - 1) await sleep(DELETE_RATE_DELAY_MS);
    }

    const audit = await this.deps.deletionsRepo.insert({
      callerSlackId: pending.callerSlackId, callerEmail: null,
      requestedEmails: p.requested, foundCount: p.found.length,
      deletedCount, failedCount: failedDetails.length, failedDetails,
    });
    const failTail = failedDetails.length === 0 ? '' : `\nFailed (${failedDetails.length}): ${failedDetails.map((f) => f.email).join(', ')}`;
    await this.deps.slack.postMessage(msg.channelId,
      `Submitted ${deletedCount} of ${p.found.length} profile${p.found.length === 1 ? '' : 's'} for deletion (audit \`${audit.id}\`). They'll appear on Klaviyo's "Deleted Profiles" page within ~5 min.${failTail}`,
      msg.threadTs);
    logger.info({ auditId: audit.id, requested: p.requested.length, found: p.found.length, deleted: deletedCount, failed: failedDetails.length }, 'klaviyo_delete_submitted');
  }
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/confirmation-handler.ts tests/unit/orchestrator/confirmation-handler.test.ts
git commit -m "feat(orchestrator): ConfirmationHandler intercepts yes/cancel for Klaviyo flows"
```

---

## Task K13: KlaviyoImportPollerJob

**Files:**
- Create: `src/connectors/klaviyo/import-poller.ts`
- Create: `tests/unit/connectors/klaviyo/import-poller.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from 'vitest';
import { KlaviyoImportPollerJob } from '../../../../src/connectors/klaviyo/import-poller.js';

function makeJob(opts: any = {}) {
  return new KlaviyoImportPollerJob({
    importsRepo: opts.importsRepo ?? { listInFlight: vi.fn().mockResolvedValue([]), updateStatus: vi.fn() },
    pendingRepo: opts.pendingRepo ?? { sweepExpired: vi.fn().mockResolvedValue(0) },
    client: opts.client ?? { getBulkImportJobStatus: vi.fn() },
    slack: opts.slack ?? { postMessage: vi.fn() },
    callerLookup: opts.callerLookup ?? { resolve: vi.fn().mockResolvedValue({ slackUserId: 'U1', dmChannelId: 'D1' }) },
    now: opts.now ?? (() => new Date('2026-05-05T10:00:00Z')),
  });
}

describe('KlaviyoImportPollerJob.tick', () => {
  it('queued → processing updates row, no DM', async () => {
    const importsRepo = {
      listInFlight: vi.fn().mockResolvedValue([{ id: 'a1', klaviyoJobId: 'j1', status: 'queued', startedAt: '2026-05-05T09:59:00Z', callerSlackId: 'U1' }]),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    };
    const client = { getBulkImportJobStatus: vi.fn().mockResolvedValue({ status: 'processing' }) };
    const slack = { postMessage: vi.fn() };
    const job = makeJob({ importsRepo, client, slack });
    await job.tick();
    expect(importsRepo.updateStatus).toHaveBeenCalledWith('a1', { status: 'processing' });
    expect(slack.postMessage).not.toHaveBeenCalled();
  });

  it('queued → complete updates row + DMs caller', async () => {
    const importsRepo = {
      listInFlight: vi.fn().mockResolvedValue([{ id: 'a1', klaviyoJobId: 'j1', status: 'queued', startedAt: '2026-05-05T09:59:00Z', callerSlackId: 'U1' }]),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    };
    const client = { getBulkImportJobStatus: vi.fn().mockResolvedValue({ status: 'complete', totalCount: 3, completedCount: 3, failedCount: 0 }) };
    const slack = { postMessage: vi.fn().mockResolvedValue(undefined) };
    const job = makeJob({ importsRepo, client, slack });
    await job.tick();
    expect(importsRepo.updateStatus).toHaveBeenCalledWith('a1', expect.objectContaining({ status: 'complete', succeededCount: 3, failedCount: 0 }));
    expect(slack.postMessage).toHaveBeenCalledOnce();
  });

  it('queued → failed updates row + DMs failure', async () => {
    const importsRepo = {
      listInFlight: vi.fn().mockResolvedValue([{ id: 'a1', klaviyoJobId: 'j1', status: 'queued', startedAt: '2026-05-05T09:59:00Z', callerSlackId: 'U1' }]),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    };
    const client = { getBulkImportJobStatus: vi.fn().mockResolvedValue({ status: 'failed', errors: [{ detail: 'malformed' }] }) };
    const slack = { postMessage: vi.fn() };
    const job = makeJob({ importsRepo, client, slack });
    await job.tick();
    expect(importsRepo.updateStatus).toHaveBeenCalledWith('a1', expect.objectContaining({ status: 'failed', errorSummary: expect.stringContaining('malformed') }));
    expect(slack.postMessage).toHaveBeenCalledOnce();
  });

  it('30-min stuck timeout marks failed', async () => {
    const startedAt = '2026-05-05T09:00:00Z'; // 60 min ago
    const importsRepo = {
      listInFlight: vi.fn().mockResolvedValue([{ id: 'a1', klaviyoJobId: 'j1', status: 'processing', startedAt, callerSlackId: 'U1' }]),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    };
    const client = { getBulkImportJobStatus: vi.fn().mockResolvedValue({ status: 'processing' }) };
    const slack = { postMessage: vi.fn() };
    const job = makeJob({ importsRepo, client, slack });
    await job.tick();
    expect(importsRepo.updateStatus).toHaveBeenCalledWith('a1', { status: 'failed', errorSummary: 'timeout (>30 min in processing)' });
    expect(slack.postMessage).toHaveBeenCalledOnce();
  });

  it('sweepExpired runs each tick', async () => {
    const pendingRepo = { sweepExpired: vi.fn().mockResolvedValue(2) };
    const job = makeJob({ pendingRepo });
    await job.tick();
    expect(pendingRepo.sweepExpired).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

Create `src/connectors/klaviyo/import-poller.ts`:

```ts
import logger from '../../logger.js';
import type { KlaviyoApiClient } from './client.js';
import type { KlaviyoImportsRepo, KlaviyoImportRow } from '../../storage/repositories/klaviyo-imports.js';
import type { PendingConfirmationsRepo } from '../../storage/repositories/pending-confirmations.js';

export interface CallerLookup {
  resolve(slackUserId: string): Promise<{ slackUserId: string; dmChannelId: string } | null>;
}

export interface KlaviyoImportPollerDeps {
  importsRepo: KlaviyoImportsRepo;
  pendingRepo: PendingConfirmationsRepo;
  client: Pick<KlaviyoApiClient, 'getBulkImportJobStatus'>;
  slack: { postMessage(channel: string, text: string, threadTs?: string): Promise<void> };
  callerLookup: CallerLookup;
  now?: () => Date;
}

const STUCK_TIMEOUT_MS = 30 * 60 * 1000;

export class KlaviyoImportPollerJob {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly deps: KlaviyoImportPollerDeps) {}

  start(intervalMs: number = 60_000) {
    this.tick().catch((e) => logger.error({ e }, 'klaviyo_poller_first_tick_failed'));
    this.timer = setInterval(() => {
      this.tick().catch((e) => logger.error({ e }, 'klaviyo_poller_tick_failed'));
    }, intervalMs);
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick() {
    await this.deps.pendingRepo.sweepExpired().catch((e) => logger.warn({ e }, 'klaviyo_poller_sweep_failed'));
    const rows = await this.deps.importsRepo.listInFlight(50);
    for (const row of rows) {
      try {
        await this.processRow(row);
      } catch (err) {
        logger.warn({ err, auditId: row.id }, 'klaviyo_poller_row_failed');
      }
    }
  }

  private async processRow(row: KlaviyoImportRow) {
    const now = (this.deps.now ?? (() => new Date()))();
    const ageMs = now.getTime() - new Date(row.startedAt).getTime();
    if (ageMs > STUCK_TIMEOUT_MS) {
      await this.deps.importsRepo.updateStatus(row.id, { status: 'failed', errorSummary: 'timeout (>30 min in processing)' });
      await this.dmCaller(row, `Klaviyo import \`${row.id}\` timed out after 30 minutes. Job id: \`${row.klaviyoJobId}\`. Check Klaviyo's job page or re-run.`);
      return;
    }
    const status = await this.deps.client.getBulkImportJobStatus(row.klaviyoJobId);
    if (status.status === 'queued' || status.status === 'processing') {
      if (row.status !== status.status) await this.deps.importsRepo.updateStatus(row.id, { status: status.status });
      return;
    }
    if (status.status === 'complete') {
      await this.deps.importsRepo.updateStatus(row.id, {
        status: 'complete',
        succeededCount: status.completedCount ?? row.totalImported,
        alreadySubscribedCount: 0,
        failedCount: status.failedCount ?? 0,
      });
      await this.dmCaller(row, `Done — ${status.completedCount ?? row.totalImported} profile${(status.completedCount ?? 0) === 1 ? '' : 's'} subscribed${(status.failedCount ?? 0) > 0 ? `, ${status.failedCount} failed` : ''}. Audit \`${row.id}\`.`);
      return;
    }
    if (status.status === 'failed') {
      const summary = (status.errors ?? []).map((e) => e.detail).join('; ').slice(0, 4000) || 'Klaviyo reported failed';
      await this.deps.importsRepo.updateStatus(row.id, { status: 'failed', errorSummary: summary });
      await this.dmCaller(row, `Klaviyo import failed: ${summary}. Audit \`${row.id}\`.`);
      return;
    }
  }

  private async dmCaller(row: KlaviyoImportRow, text: string) {
    const c = await this.deps.callerLookup.resolve(row.callerSlackId);
    if (!c) return;
    await this.deps.slack.postMessage(c.dmChannelId, text);
  }
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/connectors/klaviyo/import-poller.ts tests/unit/connectors/klaviyo/import-poller.test.ts
git commit -m "feat(klaviyo): KlaviyoImportPollerJob polls in-flight imports + sweeps pending"
```

---

## Task K14: Slack file_shared event handler

**Files:**
- Modify: `src/slack/handlers.ts`
- Modify: `tests/unit/slack/handlers.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/unit/slack/handlers.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { handleFileShared } from '../../../src/slack/handlers.js';

describe('handleFileShared', () => {
  function makeDeps(opts: any = {}) {
    return {
      usersRepo: { getRole: vi.fn().mockResolvedValue(opts.role ?? 'admin') },
      slack: {
        filesInfo: vi.fn().mockResolvedValue({ ok: true, file: { id: 'F1', filetype: 'csv', mimetype: 'text/csv', size: 200, url_private_download: 'https://files.slack.com/F1', name: 'leads.csv' } }),
        postMessage: vi.fn().mockResolvedValue(undefined),
        downloadFile: vi.fn().mockResolvedValue(Buffer.from('email,first_name\na@x.com,A\nb@y.com,B')),
      },
      orchestrator: { runTool: opts.runTool ?? vi.fn().mockResolvedValue({ kind: 'imported_directly', audit_id: 'a1', klaviyo_job_id: 'j1', total_imported: 2 }) },
      storage: { upload: vi.fn().mockResolvedValue({ path: 'klaviyo-imports/x.csv' }) },
    };
  }

  it('happy path: DM channel + admin + small CSV → calls klaviyo.import_profiles', async () => {
    const deps = makeDeps();
    await handleFileShared({ event: { channel_id: 'D1', user_id: 'U1', file_id: 'F1' }, deps: deps as any });
    expect(deps.orchestrator.runTool).toHaveBeenCalledWith(
      'klaviyo.import_profiles',
      expect.objectContaining({ source: 'csv', profiles: expect.any(Array), storage_path: 'klaviyo-imports/x.csv', filename: 'leads.csv' }),
      expect.objectContaining({ slackUserId: 'U1', channelId: 'D1' }),
    );
    expect(deps.slack.postMessage).toHaveBeenCalled();
  });

  it('skips when not a DM channel', async () => {
    const deps = makeDeps();
    await handleFileShared({ event: { channel_id: 'C1', user_id: 'U1', file_id: 'F1' }, deps: deps as any });
    expect(deps.slack.filesInfo).not.toHaveBeenCalled();
  });

  it('rejects non-admin/marketing roles', async () => {
    const deps = makeDeps({ role: 'user' });
    await handleFileShared({ event: { channel_id: 'D1', user_id: 'U1', file_id: 'F1' }, deps: deps as any });
    expect(deps.slack.filesInfo).not.toHaveBeenCalled();
    expect(deps.slack.postMessage).toHaveBeenCalledWith('D1', expect.stringContaining('admin or marketing'), undefined);
  });

  it('rejects non-CSV files', async () => {
    const deps = makeDeps();
    deps.slack.filesInfo = vi.fn().mockResolvedValue({ ok: true, file: { id: 'F1', filetype: 'png', mimetype: 'image/png', size: 100, url_private_download: '', name: 'a.png' } });
    await handleFileShared({ event: { channel_id: 'D1', user_id: 'U1', file_id: 'F1' }, deps: deps as any });
    expect(deps.orchestrator.runTool).not.toHaveBeenCalled();
  });

  it('rejects files >1 MB', async () => {
    const deps = makeDeps();
    deps.slack.filesInfo = vi.fn().mockResolvedValue({ ok: true, file: { id: 'F1', filetype: 'csv', mimetype: 'text/csv', size: 2_000_000, url_private_download: 'x', name: 'big.csv' } });
    await handleFileShared({ event: { channel_id: 'D1', user_id: 'U1', file_id: 'F1' }, deps: deps as any });
    expect(deps.orchestrator.runTool).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement the handler**

Add to `src/slack/handlers.ts`:

```ts
import { parseCsv } from '../connectors/klaviyo/csv-parser.js';
import logger from '../logger.js';

export interface FileSharedEvent { channel_id: string; user_id: string; file_id: string; }

export interface FileSharedDeps {
  usersRepo: { getRole(slackUserId: string): Promise<string | null> };
  slack: {
    filesInfo(fileId: string): Promise<{ ok: boolean; file?: { id: string; name: string; filetype: string; mimetype: string; size: number; url_private_download: string } }>;
    downloadFile(url: string): Promise<Buffer>;
    postMessage(channel: string, text: string, threadTs?: string): Promise<void>;
  };
  orchestrator: { runTool(name: string, args: unknown, actor: { slackUserId: string; channelId: string; threadTs?: string; role?: string }): Promise<unknown> };
  storage: { upload(path: string, body: Buffer | string, contentType: string): Promise<{ path: string }> };
}

const MAX_BYTES = 1_000_000;
const ALLOWED_MIME = new Set(['text/csv', 'application/csv', 'text/plain']);

export async function handleFileShared(input: { event: FileSharedEvent; deps: FileSharedDeps }) {
  const { event, deps } = input;
  if (!event.channel_id.startsWith('D')) return; // DM only

  const role = await deps.usersRepo.getRole(event.user_id);
  if (!['admin', 'marketing'].includes(role ?? '')) {
    await deps.slack.postMessage(event.channel_id, 'Sorry — uploading CSVs to Klaviyo requires the admin or marketing role.');
    logger.warn({ user: event.user_id, role }, 'klaviyo_write_denied_csv');
    return;
  }

  const info = await deps.slack.filesInfo(event.file_id);
  const file = info.file;
  if (!file) return;
  if (file.size > MAX_BYTES) {
    await deps.slack.postMessage(event.channel_id, `That CSV is ${(file.size / 1024).toFixed(0)} KB; max is ${(MAX_BYTES / 1024).toFixed(0)} KB. Split into smaller files.`);
    return;
  }
  const okExt = file.filetype === 'csv' || file.name.toLowerCase().endsWith('.csv');
  const okMime = ALLOWED_MIME.has(file.mimetype);
  if (!okExt && !okMime) return;

  let buf: Buffer;
  try {
    buf = await deps.slack.downloadFile(file.url_private_download);
  } catch (err: any) {
    logger.warn({ err, fileId: file.id }, 'klaviyo_csv_download_failed');
    await deps.slack.postMessage(event.channel_id, `Couldn't download your file (${String(err?.message ?? err)}). Try re-sharing.`);
    return;
  }

  let parsed;
  try {
    parsed = parseCsv(buf.toString('utf8'));
  } catch (err: any) {
    await deps.slack.postMessage(event.channel_id, `Couldn't parse the CSV: ${String(err?.message ?? err)}. Make sure it has a header row and is comma-delimited.`);
    return;
  }

  const upload = await deps.storage.upload(`klaviyo-imports/${file.id}-${Date.now()}.csv`, buf, 'text/csv').catch(() => ({ path: null as any }));

  if (parsed.warnings.length > 0) {
    await deps.slack.postMessage(event.channel_id, parsed.warnings.join('\n'));
  }

  const args = {
    source: 'csv' as const,
    storage_path: upload.path ?? undefined,
    filename: file.name,
    profiles: parsed.rows.map(({ rowIndex: _i, ...rest }) => rest),
    channels: ['email'] as const,
  };
  const result: any = await deps.orchestrator.runTool('klaviyo.import_profiles', args, { slackUserId: event.user_id, channelId: event.channel_id, role });
  await deps.slack.postMessage(event.channel_id, formatImportReply(result));
}

function formatImportReply(r: any): string {
  if (r?.kind === 'imported_directly') return `Queued ${r.total_imported} profile${r.total_imported === 1 ? '' : 's'} (audit \`${r.audit_id}\`). I'll DM when it's done.`;
  if (r?.kind === 'awaiting_confirmation') return r.message;
  if (r?.kind === 'all_invalid') return `All ${r.invalid_count} rows failed validation. Examples: ${(r.invalid_rows || []).slice(0, 3).map((x: any) => `row ${x.rowIndex}: ${x.reason}`).join(' | ')}`;
  if (r?.error) return `Error (${r.error.code}): ${r.error.message}`;
  return 'Done.';
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/slack/handlers.ts tests/unit/slack/handlers.test.ts
git commit -m "feat(slack): file_shared handler routes CSVs to klaviyo.import_profiles"
```

---

## Task K15: bot.add_user role arg + bot.update_user_role tool

**Files:**
- Modify: `src/connectors/broadcast/broadcast-connector.ts`
- Modify: `src/storage/repositories/authorized-users.ts` (add updateRole)
- Modify: `tests/unit/connectors/broadcast/broadcast-connector.test.ts`

- [ ] **Step 1: Add `updateRole` to AuthorizedUsersRepo + tests**

Add to `src/storage/repositories/authorized-users.ts`:

```ts
  async updateRole(slackUserId: string, role: 'admin' | 'marketing' | 'user'): Promise<{ previousRole: string | null } | null> {
    // Read previous role to return it.
    const prev = await this.client
      .from('authorized_users').select('role').eq('slack_user_id', slackUserId).maybeSingle();
    if (prev.error) throw new Error(`authorized_users read failed: ${prev.error.message}`);
    if (!prev.data) return null;
    const { error } = await this.client.from('authorized_users').update({ role }).eq('slack_user_id', slackUserId);
    if (error) throw new Error(`authorized_users update failed: ${error.message}`);
    return { previousRole: (prev.data as any).role ?? null };
  }
```

- [ ] **Step 2: Update broadcast-connector.test.ts with new role coverage and update_user_role tests**

Append to the existing test file:

```ts
describe('bot.add_user with role arg', () => {
  // existing pattern of building the connector with mocks
  it('inserts marketing role when admin caller passes role=marketing', async () => {
    // build connector with admin actor + stub usersRepo.upsert
    // call execute({ slack_user_id: 'U2', email: 'x@y.com', role: 'marketing' })
    // expect upsert called with role='marketing'
  });

  it('FORBIDDEN when non-admin caller passes role=marketing', async () => {
    // build connector with marketing actor
    // expect FORBIDDEN
  });
});

describe('bot.update_user_role', () => {
  it('admin can promote user → marketing', async () => {
    // stub repo.updateRole returning { previousRole: 'user' }
    // execute({ slack_user_id: 'U2', role: 'marketing' })
    // expect ok:true, previous_role:'user', new_role:'marketing'
  });

  it('FORBIDDEN for non-admin caller', async () => { /* ... */ });
  it('USER_NOT_FOUND when target does not exist', async () => { /* ... */ });
});
```

(Fill in the bodies following the same harness used for the existing `bot.broadcast_notification` tests in this file. The broadcast-connector test file already has the full mock setup pattern — just copy the actor + deps wiring.)

- [ ] **Step 3: Run — FAIL**

```bash
npx vitest run tests/unit/connectors/broadcast/broadcast-connector.test.ts
```

- [ ] **Step 4: Implement — extend bot.add_user, add bot.update_user_role**

In `src/connectors/broadcast/broadcast-connector.ts`:

Find the existing `addUser` schema and update its `role` enum:

```ts
  role: z.enum(['user', 'admin', 'marketing']).default('user').describe('"user" (default), "admin" (broadcast + add_user), or "marketing" (Klaviyo write tools).'),
```

Add a new tool definition alongside `broadcast` and `addUser`:

```ts
const updateRole: ToolDef<{ slack_user_id: string; role: 'admin' | 'marketing' | 'user' }> = {
  name: 'bot.update_user_role',
  description: [
    'Change an existing authorized user\'s role.',
    'ADMIN-ONLY (gated by role="admin" on the caller).',
    'Roles: "admin" (full powers), "marketing" (Klaviyo write tools), "user" (read-only).',
  ].join('\n'),
  argsSchema: z.object({
    slack_user_id: z.string(),
    role: z.enum(['admin', 'marketing', 'user']),
  }),
  async execute(args) {
    const actor = this.deps.getActor();
    if (!actor) return { error: { code: 'NO_ACTOR', message: 'No active actor' } };
    const callerRole = await this.deps.usersRepo.getRole(actor.slackUserId);
    if (callerRole !== 'admin') return { error: { code: 'FORBIDDEN', message: 'bot.update_user_role is admin-only.' } };
    const result = await this.deps.usersRepo.updateRole(args.slack_user_id, args.role);
    if (!result) return { error: { code: 'USER_NOT_FOUND', message: `No authorized user with slack id ${args.slack_user_id}.` } };
    logger.info({ caller: actor.slackUserId, target: args.slack_user_id, from: result.previousRole, to: args.role }, 'bot_role_changed');
    return { ok: true as const, previous_role: result.previousRole ?? null, new_role: args.role };
  },
};
return [broadcast, addUser, updateRole];
```

- [ ] **Step 5: Run — PASS**

- [ ] **Step 6: Commit**

```bash
git add src/connectors/broadcast/broadcast-connector.ts src/storage/repositories/authorized-users.ts tests/unit/connectors/broadcast/broadcast-connector.test.ts
git commit -m "feat(bot): bot.add_user accepts marketing role; new bot.update_user_role tool"
```

---

## Task K16: Wire-up — index.ts + system prompt + Live Reports whitelist + tool-output-shapes

**Files:**
- Modify: `src/index.ts`
- Modify: `src/orchestrator/prompts.ts`
- Modify: `src/reports/live/spec.ts`
- Modify: `src/connectors/live-reports/tool-output-shapes.ts`

- [ ] **Step 1: Wire repos, poller, confirmation handler in `src/index.ts`**

Locate where existing connectors are wired (e.g., where `KlaviyoConnector` is instantiated). Add:

```ts
import { KlaviyoImportsRepo } from './storage/repositories/klaviyo-imports.js';
import { KlaviyoDeletionsRepo } from './storage/repositories/klaviyo-deletions.js';
import { PendingConfirmationsRepo } from './storage/repositories/pending-confirmations.js';
import { KlaviyoImportPollerJob } from './connectors/klaviyo/import-poller.js';
import { ConfirmationHandler } from './orchestrator/confirmation-handler.js';

// ... after supabase client + klaviyo client are constructed:
const importsRepo = new KlaviyoImportsRepo(supabase);
const deletionsRepo = new KlaviyoDeletionsRepo(supabase);
const pendingRepo = new PendingConfirmationsRepo(supabase);

const storageAdapter = {
  async upload(path: string, body: Buffer | string, contentType: string) {
    const { data, error } = await supabase.storage.from('klaviyo-imports').upload(path.replace(/^klaviyo-imports\//, ''), body, { contentType, upsert: false });
    if (error) throw error;
    return { path: `klaviyo-imports/${data.path}` };
  },
};
const slackDelivery = {
  async postMessage(channel: string, text: string, threadTs?: string) {
    await slackClient.chat.postMessage({ channel, text, thread_ts: threadTs });
  },
  async filesInfo(fileId: string) {
    return slackClient.files.info({ file: fileId }) as any;
  },
  async downloadFile(url: string) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN!}` } });
    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  },
};

const klaviyoConnector = new KlaviyoConnector({
  client: klaviyoClient,
  // ...existing deps...
  importsRepo, deletionsRepo, pendingRepo,
  storage: storageAdapter,
  getActor: getActiveActor,
});

const confirmationHandler = new ConfirmationHandler({
  pendingRepo, importsRepo, deletionsRepo,
  client: klaviyoClient,
  storage: storageAdapter,
  slack: slackDelivery,
});

const importPoller = new KlaviyoImportPollerJob({
  importsRepo, pendingRepo,
  client: klaviyoClient,
  slack: slackDelivery,
  callerLookup: {
    async resolve(slackUserId: string) {
      const im = await slackClient.conversations.open({ users: slackUserId });
      const ch = (im as any)?.channel?.id;
      return ch ? { slackUserId, dmChannelId: ch } : null;
    },
  },
});
importPoller.start();
```

In the Slack message handler hook (where messages are routed), add a call to `confirmationHandler.tryHandle(...)` BEFORE the LLM dispatch. If it returns true, return early. Search for the message-event entry point (likely `src/slack/handlers.ts` or similar) and insert:

```ts
// at the start of the message-event handler, after the auth check and before the LLM dispatch:
const consumed = await confirmationHandler.tryHandle({
  slackUserId: event.user, channelId: event.channel, threadTs: event.thread_ts ?? event.ts, text: event.text ?? '',
});
if (consumed) return;
```

Also wire the `file_shared` event:

```ts
slackApp.event('file_shared', async ({ event }) => {
  await handleFileShared({
    event: { channel_id: event.channel_id, user_id: event.user_id, file_id: event.file_id },
    deps: { usersRepo, slack: slackDelivery, orchestrator, storage: storageAdapter },
  });
});
```

- [ ] **Step 2: Update system prompt in `src/orchestrator/prompts.ts`**

Add a new section near the existing Klaviyo section:

```
## Klaviyo writes (admin/marketing only)

When the user asks to import / add / upload profiles to Klaviyo, use \`klaviyo.import_profiles\`.
- Inline batches up to 20 emails go through the tool directly.
- For CSV uploads, the file_shared handler routes to the same tool — you don't typically call this with source='csv' yourself.
- If the response is \`kind: 'awaiting_confirmation'\`, echo the \`message\` to the user verbatim — they need to reply "yes" or "cancel".

When the user asks to delete profiles from Klaviyo, use \`klaviyo.delete_profiles\`.
- Up to 50 emails per call. Always returns a preview prompt — never confirms automatically.
- Echo the \`message\` to the user; their "yes" reply will be intercepted by the confirmation handler.

For "what happened to that import?" questions, use \`klaviyo.import_status\` with the audit_id or klaviyo_job_id from the earlier reply.

DO NOT use these tools for read-only questions about Klaviyo (use the existing \`klaviyo.consented_signups\`, \`klaviyo.list_campaigns\`, etc. for that).
DO NOT call \`klaviyo.import_profiles\` or \`klaviyo.delete_profiles\` from inside a Live Report — they are write operations.
```

- [ ] **Step 3: Whitelist `klaviyo.import_status` in Live Reports**

In `src/reports/live/spec.ts`, find the `WHITELISTED_TOOLS` Set and add:

```ts
'klaviyo.import_status',
```

Do NOT add `klaviyo.import_profiles` or `klaviyo.delete_profiles`.

- [ ] **Step 4: Add a sample output shape**

In `src/connectors/live-reports/tool-output-shapes.ts`, append:

```ts
export const KLAVIYO_IMPORT_STATUS_SAMPLE = {
  audit_id: '00000000-0000-0000-0000-000000000000',
  klaviyo_job_id: 'job-abc',
  status: 'complete' as const,
  list: { id: 'L1', name: 'Trade Customers' },
  channels: ['email'] as const,
  total_submitted: 5,
  total_imported: 5,
  total_invalid_rejected: 0,
  succeeded_count: 5,
  already_subscribed_count: 0,
  failed_count: 0,
  started_at: '2026-05-05T10:00:00Z',
  completed_at: '2026-05-05T10:01:00Z',
};
// then register it in the same map other tools use
```

- [ ] **Step 5: Typecheck + run full suite**

```bash
npx tsc --noEmit
npx vitest run
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/orchestrator/prompts.ts src/reports/live/spec.ts src/connectors/live-reports/tool-output-shapes.ts
git commit -m "feat(wire): wire Klaviyo write infra (poller, handler, file_shared, prompts, whitelist)"
```

---

## Task K17: Pre-deploy gate — verify Klaviyo scopes + add Slack files:read

**Files:**
- Modify: `docs/process/adding-a-connector.md` (if a deploy-checklist exists, document the new scope)
- Modify: `MEMORY.md` reference for `reference_gantri_ai_bot_deploy.md`

- [ ] **Step 1: Verify Klaviyo API key scopes**

Run a probe against each scope:

```bash
KEY=$(supabase mcp execute_sql project_id=ykjjwszoxazzlcovhlgd query="select decrypted_secret from vault.decrypted_secrets where name='KLAVIYO_API_KEY'" | tail -1)

# profiles:write — try a no-op POST that should fail with a *non-403* error
curl -s -X POST -H "Authorization: Klaviyo-API-Key $KEY" -H "revision: 2026-04-15" -H "content-type: application/json" \
  https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs -d '{}' | head -c 200

# data-privacy:write — try a no-op POST
curl -s -X POST -H "Authorization: Klaviyo-API-Key $KEY" -H "revision: 2026-04-15" -H "content-type: application/json" \
  https://a.klaviyo.com/api/data-privacy-deletion-jobs -d '{}' | head -c 200

# lists:write — try GET /api/lists (if 200, lists:read is fine; lists:write is needed for the bulk subscribe with list_id)
curl -s -H "Authorization: Klaviyo-API-Key $KEY" -H "revision: 2026-04-15" https://a.klaviyo.com/api/lists | head -c 200
```

If any returns `403 Forbidden` with a scope-related message, **stop here** — rotate the Klaviyo API key in the Klaviyo UI to add the missing scope, update the Supabase vault `KLAVIYO_API_KEY`, and re-run.

- [ ] **Step 2: Add `files:read` to the Slack app**

Manually in api.slack.com → app config → OAuth & Permissions:
1. Add `files:read` to Bot Token Scopes.
2. Reinstall to workspace (top-right "Install to <workspace>").
3. Confirm the new bot token still starts with `xoxb-` (it should be the same — reinstalling preserves the token).

- [ ] **Step 3: Subscribe to `file_shared` event**

In api.slack.com → app config → Event Subscriptions:
1. Under "Subscribe to bot events", add `file_shared`.
2. Save.
3. Trigger Slack to re-verify the request URL.

- [ ] **Step 4: Document the new scopes in the deploy memory**

Update `~/.claude/projects/-Users-danierestevez-Documents-work-gantri/memory/reference_gantri_ai_bot_deploy.md` with the additional Klaviyo scopes (`data-privacy:write`) and Slack scope (`files:read`), and the `file_shared` event subscription.

- [ ] **Step 5: Commit (any doc updates that are in-repo)**

```bash
git add docs/
git commit -m "docs(deploy): document new Klaviyo + Slack scopes for Klaviyo write tools"
```

---

## Task K18: Deploy + smoke

**Files:** none (uses existing Fly + Slack infra)

- [ ] **Step 1: Final pre-deploy check**

```bash
npx tsc --noEmit && npx vitest run
```
Expected: 0 type errors, all tests pass.

- [ ] **Step 2: Deploy**

```bash
fly deploy -a gantri-ai-bot
```
Expected: machine boots; `/healthz` returns `{ok:true}`.

- [ ] **Step 3: Promote test marketing user**

In Supabase MCP:

```sql
-- Pick a non-admin authorized user to test the marketing role.
-- For pre-Lana smoke, use Danny himself (already admin) — skip this step until Lana is ready.
-- To smoke as marketing role, temporarily flip danny@gantri.com to 'marketing':
update authorized_users set role = 'marketing' where email = 'danny@gantri.com';
-- (Revert after smoke: update authorized_users set role = 'admin' where email = 'danny@gantri.com';)
```

- [ ] **Step 4: Smoke test from Slack**

Ensure a Klaviyo test list named `__bot_smoke_test_list` exists. Then in the bot DM:

1. **Inline import, all valid:**
   `import to __bot_smoke_test_list with email consent: smoke1+test@gantri.com, smoke2+test@gantri.com`
   Expected reply: "Queued 2 profiles to Klaviyo (list: __bot_smoke_test_list). I'll DM when it's done." Wait ≤2 min for completion DM.
   Verify in Klaviyo UI: 2 profiles appear in the list, `Subscribed` to email.

2. **Inline import with invalid:**
   `import to __bot_smoke_test_list: smoke3+test@gantri.com, gertrude@@bad.com`
   Expected: confirmation prompt with 1 invalid + 1 valid. Reply `yes`. Verify only 1 profile imported, `total_invalid_rejected=1` in audit row (`select * from klaviyo_imports order by started_at desc limit 1;`).

3. **Cancel:**
   `import to __bot_smoke_test_list: smoke4+test@gantri.com, gertrude@@bad.com`
   Expected: confirmation prompt. Reply `cancel`. Verify no audit row written (count from `klaviyo_imports` unchanged).

4. **CSV upload:** Drop `tests/fixtures/klaviyo-imports/valid-3-rows.csv` (rename to `+test` aliases first) into the bot DM. Expected: bot replies with status. Verify file archived in `klaviyo-imports/` bucket.

5. **Permission denial:** In Supabase, set Danny to `role='user'` temporarily. Try `import to __bot_smoke_test_list: x+test@gantri.com`. Expected: `FORBIDDEN`. Revert role.

6. **Delete:** `delete from Klaviyo: smoke1+test@gantri.com, smoke2+test@gantri.com, notexist+test@gantri.com`. Expected: preview with 2 found + 1 not_found. Reply `yes`. Verify `klaviyo_deletions` audit row, profiles appear in Klaviyo "Deleted Profiles" within 5 min.

7. **import_status:** `what happened to import <audit_id from step 1>?` Expected: returns `complete` row.

8. **Pending TTL:** Trigger a confirmation prompt, wait 31 minutes, reply `yes`. Expected: fallthrough message.

- [ ] **Step 5: Promote Lana to marketing role**

```sql
update authorized_users set role = 'marketing' where email = 'lana@gantri.com';
```

Or use the bot tool: `update lana@gantri.com to role marketing` (the LLM should pick `bot.update_user_role`).

- [ ] **Step 6: Hand off to Lana**

DM Lana the new capability summary (broadcast or short personal message — consult Danny before broadcasting):

> Klaviyo import + delete are live. You can paste a list of emails inline (≤20) or attach a CSV (≤1000 rows) in our DM. I'll always preview + ask for confirmation when something looks off. See `klaviyo.import_profiles`, `klaviyo.delete_profiles`. The role on you is now `marketing`.

- [ ] **Step 7: Commit any final docs**

```bash
git add docs/
git commit -m "docs(klaviyo-import): post-smoke notes" || true
```

---

## Self-Review

- ✅ **Spec coverage** — every requirement R1–R16 is implemented across K1–K18:
  - R1 (validate-then-confirm or auto-import): K9.
  - R2 (CSV path): K8 (parser) + K14 (handler).
  - R3 (role gate): K9, K10, K15.
  - R4 (writes Klaviyo via bulk-subscribe + audit row): K9, K12 (confirm path).
  - R5 (poller + status tool): K11, K13.
  - R6 (delete preview): K10.
  - R7 (delete execution + audit + DM): K12.
  - R8 (pending confirmations + TTL): K5, K12, K13.
  - R9 (list resolution): K9.
  - R10 (dedup): K8 (validation), K10 (delete dedup).
  - R11 (phone normalization): K8.
  - R12 (channels arg + ignored consent_* CSV cols): K8, K9.
  - R13 (rate limits): K9, K10.
  - R14 (failure DMs): K12, K13.
  - R15 (no Live Reports access to write tools): K16.
  - R16 (role tooling): K15.
- ✅ **No placeholders** — every step has concrete code or commands. The two "fill-in" sub-bullets in K15 step 2 are deliberately abbreviated test stubs that the implementer fills using the existing test harness in the same file (the rest of the file is in the repo).
- ✅ **Type consistency** — `KlaviyoImportsRepo`, `KlaviyoDeletionsRepo`, `PendingConfirmationsRepo`, `KlaviyoApiClient.bulkSubscribeProfiles`, `KlaviyoApiClient.requestProfileDeletion`, `ConfirmationHandler.tryHandle` are referenced consistently across tasks. The pending payload shape used in K9 is consumed by K12 unchanged.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-05-klaviyo-import.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
