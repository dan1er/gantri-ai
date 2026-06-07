# Slack dev-ops orchestrator — Plan 1: substrate + `/preview` (Phase 1, dumb workflows)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an on-demand `/preview` Slack command in `gantri-ai-bot` that spins up Backend / Frontend / Full-stack previews, reports live progress in one dev-ops channel, and tears them down — with **dumb GitHub Actions** (no AWS) so the whole bot→GitHub→Slack path is real and demoable.

**Architecture:** A reusable substrate (a Supabase `jobs` table + an in-process poller, a GitHub workflow-dispatcher, a Slack-message renderer) plus the `/preview` command (slash → buttons → modals → job). The bot *dispatches* a Porter workflow and *polls the run*; in Phase 1 that workflow just sleeps and echoes the deterministic URL. Provisioning sits behind a `Provisioner` so the real §6 steps drop in later with no bot change.

**Tech Stack:** Node 20 + TypeScript (ESM, `.js` import suffixes), `@slack/bolt` (ExpressReceiver), Supabase (`@supabase/supabase-js`), Octokit-free GitHub REST via `fetch`, Zod, vitest (manual mocks). Spec: `docs/superpowers/specs/2026-06-06-slack-preview-command-design.md`.

---

## File structure (Plan 1)

**New files (`gantri-ai-bot`):**
- `migrations/0030_devops_jobs.sql` — the `jobs` table.
- `src/devops/types.ts` — `Job`, `JobTarget`, `JobStatus`, `JobSpec`, `FrontendRepo`.
- `src/devops/slug.ts` — `slugFromRef`, `backendUrl` (pure fns).
- `src/devops/jobs-repo.ts` — `DevopsJobsRepo` (Supabase CRUD).
- `src/devops/github.ts` — `GithubDispatcher` (dispatch workflow + poll run via REST).
- `src/devops/provisioner.ts` — `advancePreviewJob` (the dumb-Phase-1 state machine).
- `src/devops/messages.ts` — `renderJobBlocks` (Slack Block Kit for a job).
- `src/devops/jobs-runner.ts` — `JobsRunner` (the poller; advances jobs + updates Slack).
- `src/slack/devops/preview-command.ts` — `registerPreviewCommand` (command + buttons + modals + tear-down).

**Modified:**
- `src/config/env.ts` — add `OPS_CHANNEL_ID`, `GITHUB_TOKEN`, `GITHUB_OWNER`.
- `src/slack/app.ts` — accept + register the dev-ops command.
- `src/index.ts` — load new env/secrets, build deps, register the command, start `JobsRunner`.
- `.env.example` — new vars.

**Porter repo (`gantri/porter`):**
- `.github/workflows/preview-create.yml` — dumb (sleep + echo).
- `.github/workflows/preview-teardown.yml` — dumb (sleep + echo).

**Manual (Slack app dashboard, documented in Task 13):** add the `/preview` slash command, enable Interactivity, invite the bot to the channel.

---

## Task 1: `jobs` table migration

**Files:**
- Create: `migrations/0030_devops_jobs.sql`

- [ ] **Step 1: Write the migration** (follow the `migrations/0023_gantri_writes.sql` style)

```sql
-- One row per dev-ops job (preview/deploy) triggered from Slack.
CREATE TABLE IF NOT EXISTS devops_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('preview', 'deploy')),
  target text NOT NULL CHECK (target IN ('backend', 'frontend', 'fullstack')),
  status text NOT NULL CHECK (status IN (
    'pending', 'backend_running', 'frontend_running', 'ready', 'failed', 'torn_down'
  )),
  spec jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by text NOT NULL,
  channel_id text NOT NULL,
  message_ts text,
  run_id bigint,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The poller scans non-terminal jobs.
CREATE INDEX IF NOT EXISTS devops_jobs_active_idx
  ON devops_jobs (status, updated_at)
  WHERE status NOT IN ('ready', 'failed', 'torn_down');
```

- [ ] **Step 2: Apply it**

Apply with the Supabase MCP tool `apply_migration` (project `ykjjwszoxazzlcovhlgd`, name `0030_devops_jobs`, the SQL above). Verify with `list_tables` that `devops_jobs` exists.

- [ ] **Step 3: Commit**

```bash
git add migrations/0030_devops_jobs.sql
git commit -m "feat(devops): add devops_jobs table"
```

---

## Task 2: Job types

**Files:**
- Create: `src/devops/types.ts`

- [ ] **Step 1: Write the types** (no test — types only)

```typescript
export type JobKind = 'preview' | 'deploy';
export type JobTarget = 'backend' | 'frontend' | 'fullstack';
export type FrontendRepo = 'mantle' | 'core' | 'made';

export type JobStatus =
  | 'pending'
  | 'backend_running'
  | 'frontend_running'
  | 'ready'
  | 'failed'
  | 'torn_down';

export interface JobSpec {
  backend?: { ref: string; slug: string; url?: string };
  frontend?: { repo: FrontendRepo; ref: string; url?: string };
}

export interface Job {
  id: string;
  kind: JobKind;
  target: JobTarget;
  status: JobStatus;
  spec: JobSpec;
  requestedBy: string;
  channelId: string;
  messageTs: string | null;
  runId: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export const TERMINAL_STATUSES: readonly JobStatus[] = ['ready', 'failed', 'torn_down'];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/devops/types.ts
git commit -m "feat(devops): job types"
```

---

## Task 3: Slug derivation (pure function, TDD)

**Files:**
- Create: `src/devops/slug.ts`
- Test: `tests/unit/devops/slug.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { slugFromRef, backendUrl } from '../../../src/devops/slug.js';

describe('slugFromRef', () => {
  it('extracts the AS ticket, lowercased', () => {
    expect(slugFromRef('feat/AS-2215-cool-thing')).toBe('as-2215');
    expect(slugFromRef('AS-2215')).toBe('as-2215');
  });

  it('falls back to a dns-safe slug of the branch tail', () => {
    expect(slugFromRef('feature/Cool_Thing!!')).toBe('cool-thing');
    expect(slugFromRef('bugfix/weird   spaces')).toBe('weird-spaces');
  });

  it('never returns an empty slug', () => {
    expect(slugFromRef('---')).toBe('preview');
  });
});

describe('backendUrl', () => {
  it('builds the deterministic preview URL', () => {
    expect(backendUrl('as-2215')).toBe('https://as-2215.api.preview.gantri.com');
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run tests/unit/devops/slug.test.ts`
Expected: FAIL — cannot find module `slug.js`.

- [ ] **Step 3: Implement**

```typescript
export function slugFromRef(ref: string): string {
  const ticket = ref.match(/as-\d+/i);
  if (ticket) return ticket[0].toLowerCase();
  const tail = ref
    .toLowerCase()
    .replace(/^.*\//, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return tail || 'preview';
}

export function backendUrl(slug: string): string {
  return `https://${slug}.api.preview.gantri.com`;
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run tests/unit/devops/slug.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/devops/slug.ts tests/unit/devops/slug.test.ts
git commit -m "feat(devops): slug + backend url derivation"
```

---

## Task 4: Jobs repository (Supabase CRUD, TDD)

**Files:**
- Create: `src/devops/jobs-repo.ts`
- Test: `tests/unit/devops/jobs-repo.test.ts`

- [ ] **Step 1: Write the failing test** (mock the Supabase client like `tests/unit/storage/repositories.test.ts`)

```typescript
import { describe, it, expect, vi } from 'vitest';
import { DevopsJobsRepo } from '../../../src/devops/jobs-repo.js';

const ROW = {
  id: 'j1', kind: 'preview', target: 'backend', status: 'pending',
  spec: { backend: { ref: 'feat/as-1', slug: 'as-1' } },
  requested_by: 'U1', channel_id: 'C1', message_ts: null,
  run_id: null, error: null, created_at: 't', updated_at: 't',
};

describe('DevopsJobsRepo', () => {
  it('create inserts and maps the row to a Job', async () => {
    const insert = vi.fn().mockReturnValue({
      select: () => ({ single: () => Promise.resolve({ data: ROW, error: null }) }),
    });
    const client = { from: () => ({ insert }) } as any;
    const repo = new DevopsJobsRepo(client);
    const job = await repo.create({
      kind: 'preview', target: 'backend',
      spec: { backend: { ref: 'feat/as-1', slug: 'as-1' } },
      requestedBy: 'U1', channelId: 'C1',
    });
    expect(job.id).toBe('j1');
    expect(job.spec.backend?.slug).toBe('as-1');
    expect(insert).toHaveBeenCalledOnce();
  });

  it('listActive returns only non-terminal jobs', async () => {
    const not = vi.fn().mockResolvedValue({ data: [ROW], error: null });
    const client = { from: () => ({ select: () => ({ not: () => ({ order: () => ({ limit: () => not() }) }) }) }) } as any;
    const repo = new DevopsJobsRepo(client);
    const jobs = await repo.listActive(10);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('pending');
  });

  it('update throws on a Supabase error', async () => {
    const eq = vi.fn().mockResolvedValue({ data: null, error: { message: 'denied' } });
    const client = { from: () => ({ update: () => ({ eq }) }) } as any;
    const repo = new DevopsJobsRepo(client);
    await expect(repo.update('j1', { status: 'ready' })).rejects.toThrow(/denied/);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run tests/unit/devops/jobs-repo.test.ts`
Expected: FAIL — cannot find module `jobs-repo.js`.

- [ ] **Step 3: Implement**

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Job, JobKind, JobTarget, JobStatus, JobSpec } from './types.js';
import { TERMINAL_STATUSES } from './types.js';

interface Row {
  id: string; kind: JobKind; target: JobTarget; status: JobStatus;
  spec: JobSpec; requested_by: string; channel_id: string;
  message_ts: string | null; run_id: number | null; error: string | null;
  created_at: string; updated_at: string;
}

function toJob(r: Row): Job {
  return {
    id: r.id, kind: r.kind, target: r.target, status: r.status,
    spec: r.spec ?? {}, requestedBy: r.requested_by, channelId: r.channel_id,
    messageTs: r.message_ts, runId: r.run_id, error: r.error,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export interface CreateJobInput {
  kind: JobKind;
  target: JobTarget;
  spec: JobSpec;
  requestedBy: string;
  channelId: string;
}

export interface UpdateJobInput {
  status?: JobStatus;
  spec?: JobSpec;
  messageTs?: string | null;
  runId?: number | null;
  error?: string | null;
}

export class DevopsJobsRepo {
  constructor(private readonly client: SupabaseClient) {}

  async create(input: CreateJobInput): Promise<Job> {
    const { data, error } = await this.client
      .from('devops_jobs')
      .insert({
        kind: input.kind, target: input.target, status: 'pending',
        spec: input.spec, requested_by: input.requestedBy, channel_id: input.channelId,
      })
      .select('*')
      .single();
    if (error) throw new Error(`devops_jobs insert failed: ${error.message}`);
    return toJob(data as Row);
  }

  async listActive(limit = 25): Promise<Job[]> {
    const terminal = `(${TERMINAL_STATUSES.join(',')})`;
    const { data, error } = await this.client
      .from('devops_jobs')
      .select('*')
      .not('status', 'in', terminal)
      .order('updated_at', { ascending: true })
      .limit(limit);
    if (error) throw new Error(`devops_jobs list failed: ${error.message}`);
    return (data as Row[]).map(toJob);
  }

  async update(id: string, patch: UpdateJobInput): Promise<void> {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.spec !== undefined) row.spec = patch.spec;
    if (patch.messageTs !== undefined) row.message_ts = patch.messageTs;
    if (patch.runId !== undefined) row.run_id = patch.runId;
    if (patch.error !== undefined) row.error = patch.error;
    const { error } = await this.client.from('devops_jobs').update(row).eq('id', id);
    if (error) throw new Error(`devops_jobs update failed: ${error.message}`);
  }
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run tests/unit/devops/jobs-repo.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/devops/jobs-repo.ts tests/unit/devops/jobs-repo.test.ts
git commit -m "feat(devops): jobs repository"
```

---

## Task 5: Env vars

**Files:**
- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Test: `tests/unit/devops/env-devops.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../../src/config/env.js';

const base = {
  SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k',
  ANTHROPIC_API_KEY: 'a', SLACK_BOT_TOKEN: 'xoxb', SLACK_SIGNING_SECRET: 's',
};

describe('devops env', () => {
  it('defaults GITHUB_OWNER to gantri and keeps OPS_CHANNEL_ID/GITHUB_TOKEN optional', () => {
    const env = loadEnv(base);
    expect(env.GITHUB_OWNER).toBe('gantri');
    expect(env.OPS_CHANNEL_ID).toBeUndefined();
  });

  it('reads provided dev-ops vars', () => {
    const env = loadEnv({ ...base, OPS_CHANNEL_ID: 'C0B8XD4LSLC', GITHUB_TOKEN: 'gho_x' });
    expect(env.OPS_CHANNEL_ID).toBe('C0B8XD4LSLC');
    expect(env.GITHUB_TOKEN).toBe('gho_x');
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run tests/unit/devops/env-devops.test.ts`
Expected: FAIL — `GITHUB_OWNER` is undefined.

- [ ] **Step 3: Add to the schema** in `src/config/env.ts` (inside `envSchema`, before the closing `})`)

```typescript
  OPS_CHANNEL_ID: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_OWNER: z.string().default('gantri'),
```

- [ ] **Step 4: Add to `.env.example`**

```
# Dev-ops orchestrator
OPS_CHANNEL_ID=C0B8XD4LSLC
GITHUB_TOKEN=gho_...
GITHUB_OWNER=gantri
```

- [ ] **Step 5: Run it, verify it passes**

Run: `npx vitest run tests/unit/devops/env-devops.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/config/env.ts .env.example tests/unit/devops/env-devops.test.ts
git commit -m "feat(devops): env vars (OPS_CHANNEL_ID, GITHUB_TOKEN, GITHUB_OWNER)"
```

---

## Task 6: GitHub workflow dispatcher (TDD with mocked fetch)

The bot dispatches a `workflow_dispatch` (which returns no run id), then finds the run by a per-job `run-name` marker, then polls it.

**Files:**
- Create: `src/devops/github.ts`
- Test: `tests/unit/devops/github.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GithubDispatcher } from '../../../src/devops/github.js';

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 300, status, json: async () => body } as Response;
}

describe('GithubDispatcher', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('dispatch POSTs to the workflow dispatches endpoint with inputs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 204));
    const gh = new GithubDispatcher({ token: 't', owner: 'gantri', fetch: fetchMock });
    await gh.dispatch('porter', 'preview-create.yml', 'master', { slug: 'as-1', job_id: 'j1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/gantri/porter/actions/workflows/preview-create.yml/dispatches');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      ref: 'master', inputs: { slug: 'as-1', job_id: 'j1' },
    });
  });

  it('findRunByMarker matches the run whose name contains the job id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      workflow_runs: [
        { id: 11, name: 'preview other', status: 'in_progress' },
        { id: 22, name: 'preview j1', status: 'in_progress' },
      ],
    }));
    const gh = new GithubDispatcher({ token: 't', owner: 'gantri', fetch: fetchMock });
    const runId = await gh.findRunByMarker('porter', 'preview-create.yml', 'j1');
    expect(runId).toBe(22);
  });

  it('getRunState maps GitHub run status/conclusion', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'in_progress', conclusion: null }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', conclusion: 'success' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', conclusion: 'failure' }));
    const gh = new GithubDispatcher({ token: 't', owner: 'gantri', fetch: fetchMock });
    expect(await gh.getRunState('porter', 22)).toBe('running');
    expect(await gh.getRunState('porter', 22)).toBe('success');
    expect(await gh.getRunState('porter', 22)).toBe('failed');
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run tests/unit/devops/github.test.ts`
Expected: FAIL — cannot find module `github.js`.

- [ ] **Step 3: Implement**

```typescript
export type RunState = 'running' | 'success' | 'failed';

export interface GithubDispatcherDeps {
  token: string;
  owner: string;
  fetch?: typeof fetch;
}

export class GithubDispatcher {
  private readonly fetch: typeof fetch;
  constructor(private readonly deps: GithubDispatcherDeps) {
    this.fetch = deps.fetch ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.deps.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
  }

  private base(repo: string): string {
    return `https://api.github.com/repos/${this.deps.owner}/${repo}`;
  }

  async dispatch(
    repo: string, workflow: string, ref: string, inputs: Record<string, string>,
  ): Promise<void> {
    const res = await this.fetch(
      `${this.base(repo)}/actions/workflows/${workflow}/dispatches`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify({ ref, inputs }) },
    );
    if (!res.ok) throw new Error(`workflow dispatch failed: ${res.status}`);
  }

  async findRunByMarker(repo: string, workflow: string, jobId: string): Promise<number | null> {
    const res = await this.fetch(
      `${this.base(repo)}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=20`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`list runs failed: ${res.status}`);
    const body = (await res.json()) as { workflow_runs: { id: number; name?: string }[] };
    const run = body.workflow_runs.find((r) => (r.name ?? '').includes(jobId));
    return run?.id ?? null;
  }

  async getRunState(repo: string, runId: number): Promise<RunState> {
    const res = await this.fetch(`${this.base(repo)}/actions/runs/${runId}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`get run failed: ${res.status}`);
    const body = (await res.json()) as { status: string; conclusion: string | null };
    if (body.status !== 'completed') return 'running';
    return body.conclusion === 'success' ? 'success' : 'failed';
  }
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run tests/unit/devops/github.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/devops/github.ts tests/unit/devops/github.test.ts
git commit -m "feat(devops): github workflow dispatcher"
```

---

## Task 7: Dumb Porter workflows

**Files (in the `gantri/porter` repo, on a feature branch):**
- Create: `.github/workflows/preview-create.yml`
- Create: `.github/workflows/preview-teardown.yml`

- [ ] **Step 1: Write `preview-create.yml`**

```yaml
name: preview-create
run-name: preview ${{ inputs.job_id }}
on:
  workflow_dispatch:
    inputs:
      ref:
        description: Branch/PR ref the preview is for
        required: true
      slug:
        description: Deterministic slug (e.g. as-2215)
        required: true
      job_id:
        description: Slack job id (used to match the run)
        required: true
jobs:
  provision:
    runs-on: ubuntu-latest
    steps:
      - name: Validate inputs
        run: |
          test -n "${{ inputs.slug }}" || { echo "missing slug"; exit 1; }
          test -n "${{ inputs.job_id }}" || { echo "missing job_id"; exit 1; }
      - name: Simulate provisioning (Phase 1 — no AWS)
        run: |
          echo "DUMB preview-create for slug=${{ inputs.slug }} ref=${{ inputs.ref }}"
          sleep 20
          echo "would expose https://${{ inputs.slug }}.api.preview.gantri.com"
```

- [ ] **Step 2: Write `preview-teardown.yml`**

```yaml
name: preview-teardown
run-name: teardown ${{ inputs.job_id }}
on:
  workflow_dispatch:
    inputs:
      slug:
        required: true
      job_id:
        required: true
jobs:
  teardown:
    runs-on: ubuntu-latest
    steps:
      - name: Simulate teardown (Phase 1 — no AWS)
        run: |
          echo "DUMB preview-teardown for slug=${{ inputs.slug }}"
          sleep 5
```

- [ ] **Step 3: Open a PR on porter** (use the `creating-pull-requests` skill; base `master`). These must land on `master` (the default branch) so `workflow_dispatch` can target them. Note the exact workflow file names — the bot references `preview-create.yml` / `preview-teardown.yml`.

---

## Task 8: Slack message renderer (TDD)

**Files:**
- Create: `src/devops/messages.ts`
- Test: `tests/unit/devops/messages.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { renderJobBlocks } from '../../../src/devops/messages.js';
import type { Job } from '../../../src/devops/types.js';

const baseJob: Job = {
  id: 'j1', kind: 'preview', target: 'backend', status: 'backend_running',
  spec: { backend: { ref: 'feat/as-2215', slug: 'as-2215' } },
  requestedBy: 'U1', channelId: 'C1', messageTs: null, runId: 5,
  error: null, createdAt: 't', updatedAt: 't',
};

describe('renderJobBlocks', () => {
  it('shows a building backend with the requester', () => {
    const blocks = renderJobBlocks(baseJob);
    const text = JSON.stringify(blocks);
    expect(text).toContain('<@U1>');
    expect(text).toContain('as-2215');
    expect(text).toContain('⏳');
  });

  it('shows the URL and a Tear down button when ready', () => {
    const blocks = renderJobBlocks({
      ...baseJob, status: 'ready',
      spec: { backend: { ref: 'feat/as-2215', slug: 'as-2215', url: 'https://as-2215.api.preview.gantri.com' } },
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain('https://as-2215.api.preview.gantri.com');
    expect(text).toContain('Tear down');
    expect(text).toContain('preview_teardown');
  });

  it('shows the error when failed', () => {
    const blocks = renderJobBlocks({ ...baseJob, status: 'failed', error: 'boom' });
    expect(JSON.stringify(blocks)).toContain('boom');
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run tests/unit/devops/messages.test.ts`
Expected: FAIL — cannot find module `messages.js`.

- [ ] **Step 3: Implement**

```typescript
import type { Job, JobStatus } from './types.js';

const ICON: Record<JobStatus, string> = {
  pending: '⏳', backend_running: '⏳', frontend_running: '⏳',
  ready: '✅', failed: '✗', torn_down: '🧹',
};

function line(label: string, url?: string): string {
  return url ? `${label}: ${url}` : label;
}

export function renderJobBlocks(job: Job): unknown[] {
  const icon = ICON[job.status];
  const titleTarget = job.target === 'fullstack' ? 'Full-stack' : job.target[0].toUpperCase() + job.target.slice(1);
  const header = `${icon} ${titleTarget} preview — requested by <@${job.requestedBy}>`;

  const lines: string[] = [];
  if (job.spec.backend) {
    const b = job.spec.backend;
    lines.push(line(`*Backend* (${b.slug})`, job.status === 'ready' ? b.url : undefined) +
      (job.status === 'backend_running' ? ' — provisioning…' : ''));
  }
  if (job.spec.frontend) {
    const f = job.spec.frontend;
    lines.push(line(`*Frontend* (${f.repo})`, job.status === 'ready' ? f.url : undefined) +
      (job.status === 'frontend_running' ? ' — building…' : ''));
  }
  if (job.status === 'failed' && job.error) lines.push(`*Error:* ${job.error}`);

  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: header } },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') || '_starting…_' } },
  ];

  if (job.status === 'ready') {
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Tear down' },
        style: 'danger',
        action_id: 'preview_teardown',
        value: job.id,
      }],
    });
  }
  return blocks;
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run tests/unit/devops/messages.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/devops/messages.ts tests/unit/devops/messages.test.ts
git commit -m "feat(devops): job message renderer"
```

---

## Task 9: Preview provisioner state machine (TDD)

`advancePreviewJob` takes a job + deps and returns the patch to persist (and whether the Slack message should refresh). Pure-ish — all side effects via injected `gh`.

**Files:**
- Create: `src/devops/provisioner.ts`
- Test: `tests/unit/devops/provisioner.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { advancePreviewJob } from '../../../src/devops/provisioner.js';
import type { Job } from '../../../src/devops/types.js';

const backendJob: Job = {
  id: 'j1', kind: 'preview', target: 'backend', status: 'pending',
  spec: { backend: { ref: 'feat/as-1', slug: 'as-1' } },
  requestedBy: 'U1', channelId: 'C1', messageTs: 'ts', runId: null,
  error: null, createdAt: 't', updatedAt: 't',
};

describe('advancePreviewJob', () => {
  it('pending backend → dispatches and moves to backend_running', async () => {
    const gh = { dispatch: vi.fn().mockResolvedValue(undefined), findRunByMarker: vi.fn(), getRunState: vi.fn() } as any;
    const patch = await advancePreviewJob(backendJob, { gh });
    expect(gh.dispatch).toHaveBeenCalledWith('porter', 'preview-create.yml', 'feat/as-1', { ref: 'feat/as-1', slug: 'as-1', job_id: 'j1' });
    expect(patch.status).toBe('backend_running');
  });

  it('backend_running with no runId → resolves the run id', async () => {
    const gh = { findRunByMarker: vi.fn().mockResolvedValue(42), getRunState: vi.fn() } as any;
    const patch = await advancePreviewJob({ ...backendJob, status: 'backend_running', runId: null }, { gh });
    expect(patch.runId).toBe(42);
  });

  it('backend_running success → sets url + ready', async () => {
    const gh = { getRunState: vi.fn().mockResolvedValue('success') } as any;
    const patch = await advancePreviewJob({ ...backendJob, status: 'backend_running', runId: 42 }, { gh });
    expect(patch.status).toBe('ready');
    expect(patch.spec?.backend?.url).toBe('https://as-1.api.preview.gantri.com');
  });

  it('backend_running failed → failed with error', async () => {
    const gh = { getRunState: vi.fn().mockResolvedValue('failed') } as any;
    const patch = await advancePreviewJob({ ...backendJob, status: 'backend_running', runId: 42 }, { gh });
    expect(patch.status).toBe('failed');
    expect(patch.error).toMatch(/workflow/i);
  });

  it('frontend job → reads the staging preview url and is ready', async () => {
    const gh = {} as any;
    const vercel = { previewUrlForBranch: vi.fn().mockResolvedValue('https://mantle-git-x.vercel.app') };
    const fe: Job = { ...backendJob, target: 'frontend', spec: { frontend: { repo: 'mantle', ref: 'feat/as-1' } } };
    const patch = await advancePreviewJob(fe, { gh, vercel } as any);
    expect(patch.status).toBe('ready');
    expect(patch.spec?.frontend?.url).toContain('vercel.app');
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run tests/unit/devops/provisioner.test.ts`
Expected: FAIL — cannot find module `provisioner.js`.

- [ ] **Step 3: Implement** (Full-stack = backend flow, then frontend; in Phase 1 the frontend half reads the Vercel URL — `vercel.previewUrlForBranch` returns the per-branch URL, e.g. `marketplace-git-<branch>-gantri.vercel.app`. The real Vercel client lands in Task 12 wiring; the interface is defined here.)

```typescript
import type { Job, JobSpec, JobStatus, FrontendRepo } from './types.js';
import { backendUrl } from './slug.js';
import type { GithubDispatcher } from './github.js';

export interface VercelReader {
  previewUrlForBranch(repo: FrontendRepo, ref: string): Promise<string>;
}

export interface ProvisionerDeps {
  gh: GithubDispatcher;
  vercel?: VercelReader;
}

export interface JobPatch {
  status?: JobStatus;
  spec?: JobSpec;
  runId?: number | null;
  error?: string | null;
}

const PORTER = 'porter';
const CREATE_WF = 'preview-create.yml';

export async function advancePreviewJob(job: Job, deps: ProvisionerDeps): Promise<JobPatch> {
  const b = job.spec.backend;
  const f = job.spec.frontend;

  // Backend half (backend + fullstack)
  if ((job.target === 'backend' || job.target === 'fullstack') && b && !b.url) {
    if (job.status === 'pending') {
      await deps.gh.dispatch(PORTER, CREATE_WF, b.ref, { ref: b.ref, slug: b.slug, job_id: job.id });
      return { status: 'backend_running' };
    }
    if (job.status === 'backend_running' && job.runId == null) {
      const runId = await deps.gh.findRunByMarker(PORTER, CREATE_WF, job.id);
      return runId == null ? {} : { runId };
    }
    if (job.status === 'backend_running' && job.runId != null) {
      const state = await deps.gh.getRunState(PORTER, job.runId);
      if (state === 'running') return {};
      if (state === 'failed') return { status: 'failed', error: 'backend workflow failed' };
      const spec: JobSpec = { ...job.spec, backend: { ...b, url: backendUrl(b.slug) } };
      // backend ready; if fullstack, hand off to the frontend half
      return job.target === 'fullstack'
        ? { status: 'frontend_running', spec }
        : { status: 'ready', spec };
    }
  }

  // Frontend half (frontend + fullstack after backend is up)
  if ((job.target === 'frontend' || job.target === 'fullstack') && f && !f.url) {
    if (!deps.vercel) return { status: 'failed', error: 'vercel reader not configured' };
    const url = await deps.vercel.previewUrlForBranch(f.repo, f.ref);
    const spec: JobSpec = { ...job.spec, frontend: { ...f, url } };
    return { status: 'ready', spec };
  }

  return {};
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run tests/unit/devops/provisioner.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/devops/provisioner.ts tests/unit/devops/provisioner.test.ts
git commit -m "feat(devops): preview provisioner state machine"
```

---

## Task 10: Jobs runner (poller, TDD)

`JobsRunner` ticks every ~8s: list active jobs → advance each → persist the patch → `chat.update` the Slack message. Mirrors `src/connectors/klaviyo/import-poller.ts`.

**Files:**
- Create: `src/devops/jobs-runner.ts`
- Test: `tests/unit/devops/jobs-runner.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { JobsRunner } from '../../../src/devops/jobs-runner.js';
import type { Job } from '../../../src/devops/types.js';

const job: Job = {
  id: 'j1', kind: 'preview', target: 'backend', status: 'pending',
  spec: { backend: { ref: 'feat/as-1', slug: 'as-1' } },
  requestedBy: 'U1', channelId: 'C1', messageTs: 'ts1', runId: null,
  error: null, createdAt: 't', updatedAt: 't',
};

describe('JobsRunner.tick', () => {
  it('advances each active job, persists the patch, and refreshes Slack', async () => {
    const repo = { listActive: vi.fn().mockResolvedValue([job]), update: vi.fn().mockResolvedValue(undefined) } as any;
    const advance = vi.fn().mockResolvedValue({ status: 'backend_running' });
    const slack = { chat: { update: vi.fn().mockResolvedValue({}) } } as any;
    const runner = new JobsRunner({ repo, advance, slack, gh: {} as any });
    await runner.tick();
    expect(repo.update).toHaveBeenCalledWith('j1', { status: 'backend_running' });
    expect(slack.chat.update).toHaveBeenCalledOnce();
  });

  it('does not update Slack when the patch is empty', async () => {
    const repo = { listActive: vi.fn().mockResolvedValue([job]), update: vi.fn() } as any;
    const advance = vi.fn().mockResolvedValue({});
    const slack = { chat: { update: vi.fn() } } as any;
    const runner = new JobsRunner({ repo, advance, slack, gh: {} as any });
    await runner.tick();
    expect(repo.update).not.toHaveBeenCalled();
    expect(slack.chat.update).not.toHaveBeenCalled();
  });

  it('marks a job failed when advance throws', async () => {
    const repo = { listActive: vi.fn().mockResolvedValue([job]), update: vi.fn().mockResolvedValue(undefined) } as any;
    const advance = vi.fn().mockRejectedValue(new Error('kaboom'));
    const slack = { chat: { update: vi.fn().mockResolvedValue({}) } } as any;
    const runner = new JobsRunner({ repo, advance, slack, gh: {} as any });
    await runner.tick();
    expect(repo.update).toHaveBeenCalledWith('j1', expect.objectContaining({ status: 'failed' }));
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run tests/unit/devops/jobs-runner.test.ts`
Expected: FAIL — cannot find module `jobs-runner.js`.

- [ ] **Step 3: Implement**

```typescript
import type { WebClient } from '@slack/web-api';
import type { Job } from './types.js';
import { isTerminal } from './types.js';
import type { DevopsJobsRepo } from './jobs-repo.js';
import type { JobPatch, ProvisionerDeps } from './provisioner.js';
import { renderJobBlocks } from './messages.js';
import { logger } from '../logger.js';

type Advance = (job: Job, deps: ProvisionerDeps) => Promise<JobPatch>;

export interface JobsRunnerDeps extends ProvisionerDeps {
  repo: DevopsJobsRepo;
  slack: WebClient;
  advance: Advance;
  tickIntervalMs?: number;
}

export class JobsRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(private readonly deps: JobsRunnerDeps) {}

  start(): void {
    if (this.timer) return;
    const interval = this.deps.tickIntervalMs ?? 8000;
    this.timer = setInterval(() => { void this.tick(); }, interval);
    logger.info({ intervalMs: interval }, 'devops jobs runner started');
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const jobs = await this.deps.repo.listActive(25);
      for (const job of jobs) {
        await this.advanceOne(job).catch((err) =>
          logger.warn({ jobId: job.id, err: String((err as Error)?.message ?? err) }, 'devops job advance failed'),
        );
      }
    } catch (err) {
      logger.error({ err: String((err as Error)?.message ?? err) }, 'devops jobs tick failed');
    } finally {
      this.running = false;
    }
  }

  private async advanceOne(job: Job): Promise<void> {
    let patch: JobPatch;
    try {
      patch = await this.deps.advance(job, { gh: this.deps.gh, vercel: this.deps.vercel });
    } catch (err) {
      patch = { status: 'failed', error: String((err as Error)?.message ?? err).slice(0, 300) };
    }
    if (Object.keys(patch).length === 0) return;
    await this.deps.repo.update(job.id, patch);
    const updated: Job = { ...job, ...patch, spec: patch.spec ?? job.spec };
    if (job.messageTs) {
      await this.deps.slack.chat.update({
        channel: job.channelId, ts: job.messageTs,
        text: `preview ${updated.status}`, blocks: renderJobBlocks(updated) as any,
      }).catch((err) => logger.warn({ jobId: job.id, err: String((err as Error)?.message ?? err) }, 'devops chat.update failed'));
    }
  }
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run tests/unit/devops/jobs-runner.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/devops/jobs-runner.ts tests/unit/devops/jobs-runner.test.ts
git commit -m "feat(devops): jobs runner poller"
```

---

## Task 11: `/preview` command + modals (Slack plumbing)

This is the Bolt wiring — first interactive components in the bot. Hard to unit-test (Bolt context), so test the **pure helpers** (channel guard, modal builders, parsing a submission) and wire the handlers thinly around them.

**Files:**
- Create: `src/slack/devops/preview-command.ts`
- Test: `tests/unit/devops/preview-command.test.ts`

- [ ] **Step 1: Write the failing test** (pure helpers only)

```typescript
import { describe, it, expect } from 'vitest';
import { isOpsChannel, buildTypeButtons, buildBackendModal, parseBackendSubmission } from '../../../src/slack/devops/preview-command.js';

describe('preview command helpers', () => {
  it('isOpsChannel gates to the configured channel', () => {
    expect(isOpsChannel('C1', 'C1')).toBe(true);
    expect(isOpsChannel('C2', 'C1')).toBe(false);
  });

  it('buildTypeButtons returns three actions', () => {
    const blocks = buildTypeButtons();
    const text = JSON.stringify(blocks);
    expect(text).toContain('preview_backend');
    expect(text).toContain('preview_frontend');
    expect(text).toContain('preview_fullstack');
  });

  it('buildBackendModal has a porter ref input + a known callback_id', () => {
    const view = buildBackendModal();
    expect(view.callback_id).toBe('preview_backend_submit');
    expect(JSON.stringify(view)).toContain('porter');
  });

  it('parseBackendSubmission pulls the ref out of view state', () => {
    const view = { state: { values: { ref_block: { ref_input: { value: 'feat/as-2215-x' } } } } };
    expect(parseBackendSubmission(view as any)).toEqual({ ref: 'feat/as-2215-x' });
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run tests/unit/devops/preview-command.test.ts`
Expected: FAIL — cannot find module `preview-command.js`.

- [ ] **Step 3: Implement** (helpers + the `register` function that wires `app.command`/`app.action`/`app.view`)

```typescript
import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { DevopsJobsRepo } from '../../devops/jobs-repo.js';
import type { JobTarget, FrontendRepo } from '../../devops/types.js';
import { slugFromRef } from '../../devops/slug.js';
import { renderJobBlocks } from '../../devops/messages.js';
import { logger } from '../../logger.js';

export function isOpsChannel(channelId: string, opsChannelId: string): boolean {
  return channelId === opsChannelId;
}

export function buildTypeButtons(): unknown[] {
  const btn = (text: string, action_id: string) => ({
    type: 'button', text: { type: 'plain_text', text }, action_id,
  });
  return [
    { type: 'section', text: { type: 'mrkdwn', text: '*Create a preview* — pick a type:' } },
    { type: 'actions', elements: [
      btn('Backend', 'preview_backend'),
      btn('Frontend', 'preview_frontend'),
      btn('Full stack', 'preview_fullstack'),
    ] },
  ];
}

function input(blockId: string, actionId: string, label: string, placeholder: string) {
  return {
    type: 'input', block_id: blockId, label: { type: 'plain_text', text: label },
    element: { type: 'plain_text_input', action_id: actionId, placeholder: { type: 'plain_text', text: placeholder } },
  };
}

function repoSelect(blockId: string, actionId: string) {
  const opt = (v: string) => ({ text: { type: 'plain_text', text: v }, value: v });
  return {
    type: 'input', block_id: blockId, label: { type: 'plain_text', text: 'Frontend repo' },
    element: { type: 'static_select', action_id: actionId, options: [opt('mantle'), opt('core'), opt('made')] },
  };
}

export function buildBackendModal() {
  return {
    type: 'modal' as const, callback_id: 'preview_backend_submit',
    title: { type: 'plain_text' as const, text: 'Backend preview' },
    submit: { type: 'plain_text' as const, text: 'Create' },
    blocks: [input('ref_block', 'ref_input', 'porter branch or PR#', 'feat/as-2215-…')],
  };
}

export function buildFrontendModal() {
  return {
    type: 'modal' as const, callback_id: 'preview_frontend_submit',
    title: { type: 'plain_text' as const, text: 'Frontend preview' },
    submit: { type: 'plain_text' as const, text: 'Create' },
    blocks: [repoSelect('repo_block', 'repo_input'), input('ref_block', 'ref_input', 'branch or PR#', 'feat/as-2300-…')],
  };
}

export function buildFullstackModal() {
  return {
    type: 'modal' as const, callback_id: 'preview_fullstack_submit',
    title: { type: 'plain_text' as const, text: 'Full-stack preview' },
    submit: { type: 'plain_text' as const, text: 'Create' },
    blocks: [
      input('be_ref_block', 'be_ref_input', 'porter branch or PR#', 'feat/as-2215-…'),
      repoSelect('repo_block', 'repo_input'),
      input('fe_ref_block', 'fe_ref_input', 'frontend branch or PR#', 'feat/as-2300-…'),
    ],
  };
}

type ViewState = { state: { values: Record<string, Record<string, { value?: string; selected_option?: { value: string } }>> } };
const val = (v: ViewState, block: string, action: string) =>
  v.state.values[block]?.[action]?.value ?? v.state.values[block]?.[action]?.selected_option?.value ?? '';

export function parseBackendSubmission(v: ViewState) {
  return { ref: val(v, 'ref_block', 'ref_input') };
}
export function parseFrontendSubmission(v: ViewState) {
  return { repo: val(v, 'repo_block', 'repo_input') as FrontendRepo, ref: val(v, 'ref_block', 'ref_input') };
}
export function parseFullstackSubmission(v: ViewState) {
  return {
    backendRef: val(v, 'be_ref_block', 'be_ref_input'),
    repo: val(v, 'repo_block', 'repo_input') as FrontendRepo,
    frontendRef: val(v, 'fe_ref_block', 'fe_ref_input'),
  };
}

export interface PreviewCommandDeps {
  repo: DevopsJobsRepo;
  slack: WebClient;
  opsChannelId: string;
}

async function createJobAndPost(
  deps: PreviewCommandDeps, target: JobTarget,
  spec: { backend?: { ref: string; slug: string }; frontend?: { repo: FrontendRepo; ref: string } },
  requestedBy: string,
) {
  const job = await deps.repo.create({ kind: 'preview', target, spec, requestedBy, channelId: deps.opsChannelId });
  const posted = await deps.slack.chat.postMessage({
    channel: deps.opsChannelId, text: `🛠️ ${target} preview starting…`, blocks: renderJobBlocks(job) as any,
  });
  if (posted.ts) await deps.repo.update(job.id, { messageTs: posted.ts });
}

export function registerPreviewCommand(app: App, deps: PreviewCommandDeps): void {
  app.command('/preview', async ({ ack, body, respond }) => {
    await ack();
    if (!isOpsChannel(body.channel_id, deps.opsChannelId)) {
      await respond({ response_type: 'ephemeral', text: `Run \`/preview\` in <#${deps.opsChannelId}>.` });
      return;
    }
    await respond({ response_type: 'ephemeral', blocks: buildTypeButtons() as any });
  });

  const openModal = (build: () => object) => async ({ ack, body, client }: any) => {
    await ack();
    await client.views.open({ trigger_id: body.trigger_id, view: build() });
  };
  app.action('preview_backend', openModal(buildBackendModal));
  app.action('preview_frontend', openModal(buildFrontendModal));
  app.action('preview_fullstack', openModal(buildFullstackModal));

  app.view('preview_backend_submit', async ({ ack, body, view }) => {
    await ack();
    const { ref } = parseBackendSubmission(view as any);
    await createJobAndPost(deps, 'backend', { backend: { ref, slug: slugFromRef(ref) } }, body.user.id);
  });
  app.view('preview_frontend_submit', async ({ ack, body, view }) => {
    await ack();
    const { repo, ref } = parseFrontendSubmission(view as any);
    await createJobAndPost(deps, 'frontend', { frontend: { repo, ref } }, body.user.id);
  });
  app.view('preview_fullstack_submit', async ({ ack, body, view }) => {
    await ack();
    const { backendRef, repo, frontendRef } = parseFullstackSubmission(view as any);
    await createJobAndPost(deps, 'fullstack', {
      backend: { ref: backendRef, slug: slugFromRef(backendRef) },
      frontend: { repo, ref: frontendRef },
    }, body.user.id);
  });

  app.action('preview_teardown', async ({ ack, body, action }: any) => {
    await ack();
    const jobId = action.value as string;
    await deps.repo.update(jobId, { status: 'torn_down' });
    logger.info({ jobId, by: body.user?.id }, 'devops preview torn down (Phase 1: status only)');
    // Phase 2: dispatch porter preview-teardown.yml here.
  });
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run tests/unit/devops/preview-command.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/slack/devops/preview-command.ts tests/unit/devops/preview-command.test.ts
git commit -m "feat(devops): /preview command + modals"
```

---

## Task 12: Wire everything into the app

**Files:**
- Modify: `src/slack/app.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Let `buildSlackApp` register the dev-ops command.** In `src/slack/app.ts`, accept an optional callback and call it after the app is built:

```typescript
export function buildSlackApp(deps: HandlerDeps & {
  fileSharedDeps: FileSharedDeps;
  registerExtra?: (app: InstanceType<typeof App>) => void;
}) {
  // ... existing receiver + app + event handlers ...
  deps.registerExtra?.(app);
  return { app, receiver };
}
```

- [ ] **Step 2: Build the dev-ops deps + register in `src/index.ts`.** After `env` is loaded and `supabase` exists, before `buildSlackApp`:

```typescript
import { DevopsJobsRepo } from './devops/jobs-repo.js';
import { GithubDispatcher } from './devops/github.js';
import { advancePreviewJob } from './devops/provisioner.js';
import { JobsRunner } from './devops/jobs-runner.js';
import { registerPreviewCommand } from './slack/devops/preview-command.js';

// GITHUB_TOKEN may come from Vault if not in env:
const githubToken = env.GITHUB_TOKEN ?? (await readVaultSecret(supabase, 'GITHUB_TOKEN').catch(() => null));
const devopsEnabled = !!(env.OPS_CHANNEL_ID && githubToken);
const jobsRepo = new DevopsJobsRepo(supabase);
const gh = devopsEnabled ? new GithubDispatcher({ token: githubToken!, owner: env.GITHUB_OWNER }) : null;
```

- [ ] **Step 3: Pass `registerExtra` to `buildSlackApp`:**

```typescript
const { app, receiver } = buildSlackApp({
  /* ...existing deps... */,
  registerExtra: (a) => {
    if (devopsEnabled) {
      registerPreviewCommand(a, { repo: jobsRepo, slack: a.client, opsChannelId: env.OPS_CHANNEL_ID! });
    }
  },
});
```

- [ ] **Step 4: Start the `JobsRunner` after `app.start()`** (next to where `reportsRunner.start()` is called). The Phase-1 `vercel` reader returns the per-branch URL; a minimal inline reader is fine until Phase 3:

```typescript
if (devopsEnabled && gh) {
  const vercel = {
    async previewUrlForBranch(repo: string, ref: string): Promise<string> {
      const project = repo === 'mantle' ? 'marketplace' : repo === 'core' ? 'factoryos' : 'made';
      const branch = ref.replace(/^.*\//, '').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
      return `https://${project}-git-${branch}-gantri.vercel.app`;
    },
  };
  const jobsRunner = new JobsRunner({ repo: jobsRepo, slack: app.client, gh, vercel, advance: advancePreviewJob });
  jobsRunner.start();
  logger.info('devops jobs runner started');
} else {
  logger.warn('devops disabled — set OPS_CHANNEL_ID + GITHUB_TOKEN to enable /preview');
}
```

- [ ] **Step 5: Typecheck + full test run**

Run: `npm run build && npm test`
Expected: build succeeds; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/slack/app.ts src/index.ts
git commit -m "feat(devops): wire /preview command + jobs runner into the app"
```

---

## Task 13: Slack app config + deploy (manual + deploy)

- [ ] **Step 1: Slack app dashboard (api.slack.com/apps → gantri-ai-bot):**
  - **Slash Commands** → Create `/preview`, Request URL `https://<bot-host>/slack/events`.
  - **Interactivity & Shortcuts** → toggle ON, Request URL `https://<bot-host>/slack/events`.
  - Reinstall the app to the workspace if prompted (new scopes are not required — `commands` is added by creating the slash command; modals/buttons need no extra scope).
  - **Invite the bot** to the dev-ops channel `C0B8XD4LSLC` (`/invite @gantri-ai-bot`).
- [ ] **Step 2: Vault/Fly secrets** — set `OPS_CHANNEL_ID=C0B8XD4LSLC` and `GITHUB_TOKEN` (a token with `actions:write` on `gantri/porter`) as Fly secrets (or in Supabase Vault for `GITHUB_TOKEN`). Update `reference_gantri_ai_bot_deploy.md` memory with the new vars.
- [ ] **Step 3: Deploy** the bot (the project's existing Fly deploy flow) and the porter workflow PR (Task 7) must be merged to `master` first so `workflow_dispatch` resolves.
- [ ] **Step 4: Smoke test in `#dev-ops`:** `/preview` → Backend → enter `feat/as-2215-test` → confirm the channel message appears, flips ⏳→✅ after the dumb workflow completes (~20s), shows `https://as-2215.api.preview.gantri.com`, and the **Tear down** button marks it torn down.

---

## Self-review notes

- **Spec coverage:** §2 channel binding (Task 11 `isOpsChannel` + ephemeral nudge); §3 UX slash→buttons→modal→message (Tasks 8, 11); §4 orchestration model A / dumb workflow (Tasks 6, 7, 9); §5 `jobs` table + poller (Tasks 1, 4, 10); §6 teardown button (Tasks 8, 11 — Phase-1 status-only, workflow dispatch noted for Phase 2); §7 code locations match `src/devops/*` + `src/slack/devops/*`; §8 dependency = dumb porter workflow (Task 7). **Deferred to later plans (per the scope split):** `/deploy`, the merge→prompt webhook, the pre-deploy drift check.
- **Frontend full URL (Phase 1):** the inline `vercel` reader returns the per-branch `*-git-<branch>-gantri.vercel.app` URL — real and correct for staging-pointed previews; the explicit branch-scoped env-var wiring for Full-stack lands in Plan-1b / Phase 3.
- **Type consistency:** `Job`/`JobSpec`/`JobPatch`/`JobStatus` are defined once (Task 2 / Task 9) and reused; `advancePreviewJob` signature matches `JobsRunner`'s `Advance` type and the `ProvisionerDeps` it passes.
