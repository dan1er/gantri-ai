# GA4 Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Google Analytics 4 (GA4) as a complementary data source to Northbeam, exposed via 2 tools (`ga4.run_report`, `ga4.realtime`). Default routing keeps Northbeam for any marketing/attribution question; GA4 only fires when the user explicitly mentions GA4 or asks for behavior/funnel/page-level/realtime metrics that NB doesn't track.

**Architecture:** Mirror the existing `NorthbeamApiConnector` pattern: split into a thin `Ga4Client` (REST wrapper + auth) and a `Ga4Connector` (Zod-validated tool definitions). Auth uses a service-account JSON key stored in Supabase Vault — `google-auth-library` signs the JWT and exchanges it for an OAuth2 access token; the access token is cached for ~50 min. Calls hit the GA4 Data API v1beta directly via `fetch`. The connector is registered in `src/index.ts` only when both vault secrets are present, so a missing GA4 setup degrades gracefully (the rest of the bot keeps working). Prompt is updated with an absolute routing rule: NB is the default for marketing questions; GA4 only fires on explicit triggers.

**Tech Stack:** TypeScript ESM, Node 20, `google-auth-library`, GA4 Data API v1beta REST, vitest, Supabase Vault.

---

## File Structure

**New files:**
- `src/connectors/ga4/client.ts` — `Ga4Client` class. Owns auth (service-account JWT → access token), exposes `runReport()` and `runRealtimeReport()` over the Data API. Mirrors `NorthbeamApiClient`.
- `src/connectors/ga4/connector.ts` — `Ga4Connector` class implementing `Connector`. Defines Zod schemas for tool args, registers tools `ga4.run_report` and `ga4.realtime`.
- `tests/unit/ga4/client.test.ts` — unit tests for `Ga4Client` with mocked fetch + mocked auth.
- `tests/unit/ga4/connector.test.ts` — unit tests for `Ga4Connector` (schema validation, tool dispatch, error mapping).

**Modified files:**
- `package.json` — add `google-auth-library` dep.
- `src/index.ts` — read `GA4_PROPERTY_ID` + `GA4_SERVICE_ACCOUNT_KEY` from vault; register `Ga4Connector` if both present.
- `src/orchestrator/prompts.ts` — add a GA4 section listing the 2 tools, common dimensions/metrics, examples; add an absolute-routing rule (NB default; GA4 only on explicit triggers).
- Supabase Vault — add `GA4_PROPERTY_ID` (string, e.g. `123456789`) and `GA4_SERVICE_ACCOUNT_KEY` (JSON string) secrets.

**Why this split:** The `Ga4Client` has zero dependency on the Connector framework — it's a plain HTTP wrapper that could be reused from a script. The `Ga4Connector` owns argument validation and the LLM-facing tool surface. This matches the NB pattern exactly so the codebase stays uniform.

---

## Task 1: Add dependency + GCP service account setup checklist

**Files:**
- Modify: `package.json:19-28`

- [ ] **Step 1: Add `google-auth-library` to dependencies**

Edit `package.json` to add the dep in alphabetical order with the others:

```json
  "dependencies": {
    "@anthropic-ai/sdk": "^0.91.0",
    "@slack/bolt": "^3.19.0",
    "@supabase/supabase-js": "^2.45.0",
    "cron-parser": "^4.9.0",
    "google-auth-library": "^9.14.0",
    "pg": "^8.20.0",
    "pino": "^9.4.0",
    "playwright": "^1.47.0",
    "zod": "^3.23.0"
  },
```

- [ ] **Step 2: Install + verify lockfile updates**

Run: `npm install`
Expected: `added 1 package` (or similar). `package-lock.json` modified.

- [ ] **Step 3: Verify build still passes**

Run: `npm run build`
Expected: `tsc` exits 0 with no output.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add google-auth-library for GA4 service-account auth"
```

- [ ] **Step 5: Out-of-band — service account creation (user does this, NOT the engineer)**

Document for the user in the PR description (do NOT block tasks 2-7 on this; the code is testable without real creds):

1. GCP Console → IAM → Service Accounts → "Create service account" → name `gantri-ai-bot-ga4`. No project-level roles needed.
2. On the new account, "Manage keys" → "Add key" → JSON → download.
3. GA4 Admin → Property → Property Access Management → "+" → paste the service account email (looks like `gantri-ai-bot-ga4@<project>.iam.gserviceaccount.com`) → role "Viewer".
4. GA4 Admin → Property → Property details → copy the numeric Property ID (e.g. `123456789`).
5. Hand off the JSON file + property ID to the maintainer; they will store both in Supabase Vault as `GA4_SERVICE_ACCOUNT_KEY` (the entire JSON as a string) and `GA4_PROPERTY_ID`.

---

## Task 2: `Ga4Client.getAccessToken()` — service-account auth

**Files:**
- Create: `src/connectors/ga4/client.ts`
- Test: `tests/unit/ga4/client.test.ts`

- [ ] **Step 1: Write failing test for token caching**

Create `tests/unit/ga4/client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Ga4Client } from '../../../src/connectors/ga4/client.js';

const FAKE_KEY = {
  type: 'service_account',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n',
  client_email: 'test@test.iam.gserviceaccount.com',
};

describe('Ga4Client.getAccessToken', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-04-26T00:00:00Z')); });

  it('caches the token until ~50 min after issue', async () => {
    const getRequestHeadersMock = vi.fn(async () => ({ Authorization: 'Bearer abc' }));
    const authFactory = () => ({ getRequestHeaders: getRequestHeadersMock });
    const client = new Ga4Client({
      propertyId: 'p1',
      serviceAccountKey: JSON.stringify(FAKE_KEY),
      authFactory: authFactory as never,
    });

    const h1 = await client.getAuthHeaders();
    const h2 = await client.getAuthHeaders();
    expect(h1).toEqual({ Authorization: 'Bearer abc' });
    expect(h2).toEqual({ Authorization: 'Bearer abc' });
    expect(getRequestHeadersMock).toHaveBeenCalledTimes(1);

    // Advance past the cache TTL
    vi.setSystemTime(new Date('2026-04-26T00:51:00Z'));
    await client.getAuthHeaders();
    expect(getRequestHeadersMock).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/ga4/client.test.ts`
Expected: FAIL — `Ga4Client` cannot be imported.

- [ ] **Step 3: Implement minimal `Ga4Client.getAuthHeaders()`**

Create `src/connectors/ga4/client.ts`:

```ts
import { GoogleAuth, type AuthClient } from 'google-auth-library';
import { logger } from '../../logger.js';

export interface Ga4ClientConfig {
  propertyId: string;
  /** The full service-account JSON, as a string. */
  serviceAccountKey: string;
  /** Defaults to the v1beta endpoint. */
  baseUrl?: string;
  /** Optional fetch override, for tests. */
  fetchImpl?: typeof fetch;
  /** Optional auth-client factory override, for tests. Production code lets it default. */
  authFactory?: (key: unknown) => Pick<AuthClient, 'getRequestHeaders'>;
}

const TOKEN_CACHE_TTL_MS = 50 * 60 * 1000; // 50 min — token expires in 60.

export class Ga4Client {
  private cachedHeaders: Record<string, string> | null = null;
  private cachedAt = 0;
  private readonly fetch: typeof fetch;

  constructor(private readonly cfg: Ga4ClientConfig) {
    this.fetch = cfg.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    if (this.cachedHeaders && Date.now() - this.cachedAt < TOKEN_CACHE_TTL_MS) {
      return this.cachedHeaders;
    }
    const credentials = JSON.parse(this.cfg.serviceAccountKey) as Record<string, unknown>;
    const factory = this.cfg.authFactory ?? ((c: unknown) =>
      new GoogleAuth({
        credentials: c as { client_email: string; private_key: string },
        scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
      }).getClient());
    const client = await Promise.resolve(factory(credentials));
    const headers = await client.getRequestHeaders();
    this.cachedHeaders = headers as Record<string, string>;
    this.cachedAt = Date.now();
    logger.debug({ propertyId: this.cfg.propertyId }, 'ga4 access token refreshed');
    return this.cachedHeaders;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/ga4/client.test.ts`
Expected: PASS — `1 passed`.

- [ ] **Step 5: Run full test suite to confirm nothing else broke**

Run: `npm test`
Expected: `Test Files 29 passed`, `Tests 157 passed` (one new test added).

- [ ] **Step 6: Commit**

```bash
git add src/connectors/ga4/client.ts tests/unit/ga4/client.test.ts
git commit -m "feat(ga4): client skeleton with cached service-account auth"
```

---

## Task 3: `Ga4Client.runReport()` — generic dimension × metric report

**Files:**
- Modify: `src/connectors/ga4/client.ts`
- Test: `tests/unit/ga4/client.test.ts`

- [ ] **Step 1: Add failing test for `runReport`**

Append to `tests/unit/ga4/client.test.ts`:

```ts
describe('Ga4Client.runReport', () => {
  it('POSTs to runReport with auth header and parses the response', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://analyticsdata.googleapis.com/v1beta/properties/12345:runReport');
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer abc');
      expect(headers.get('content-type')).toBe('application/json');
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({
        dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
        metrics: [{ name: 'sessions' }],
        limit: 100,
      });
      return new Response(JSON.stringify({
        dimensionHeaders: [{ name: 'sessionDefaultChannelGroup' }],
        metricHeaders: [{ name: 'sessions', type: 'TYPE_INTEGER' }],
        rows: [{ dimensionValues: [{ value: 'Direct' }], metricValues: [{ value: '1234' }] }],
        rowCount: 1,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = new Ga4Client({
      propertyId: '12345',
      serviceAccountKey: JSON.stringify(FAKE_KEY),
      authFactory: () => ({ getRequestHeaders: async () => ({ Authorization: 'Bearer abc' }) }) as never,
      fetchImpl: fetchMock as never,
    });
    const out = await client.runReport({
      dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }],
      limit: 100,
    });
    expect(out.rowCount).toBe(1);
    expect(out.rows[0].dimensionValues[0].value).toBe('Direct');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws Ga4ApiError with status + body on non-2xx', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('{"error":{"message":"PERMISSION_DENIED","code":403}}', { status: 403 }),
    );
    const client = new Ga4Client({
      propertyId: '12345',
      serviceAccountKey: JSON.stringify(FAKE_KEY),
      authFactory: () => ({ getRequestHeaders: async () => ({ Authorization: 'Bearer x' }) }) as never,
      fetchImpl: fetchMock as never,
    });
    await expect(
      client.runReport({ dateRanges: [{ startDate: 'today', endDate: 'today' }], metrics: [{ name: 'sessions' }] }),
    ).rejects.toThrow(/403.*PERMISSION_DENIED/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/ga4/client.test.ts`
Expected: FAIL — `client.runReport is not a function`.

- [ ] **Step 3: Add types + `runReport()` to client**

Append to `src/connectors/ga4/client.ts` (still inside the same file, types above the class, method on the class):

```ts
export interface Ga4DateRange { startDate: string; endDate: string; name?: string }
export interface Ga4Dimension { name: string }
export interface Ga4Metric { name: string }
export interface Ga4OrderBy {
  metric?: { metricName: string };
  dimension?: { dimensionName: string };
  desc?: boolean;
}

export interface Ga4ReportRequest {
  dateRanges: Ga4DateRange[];
  dimensions?: Ga4Dimension[];
  metrics: Ga4Metric[];
  limit?: number;
  offset?: number;
  orderBys?: Ga4OrderBy[];
  dimensionFilter?: Record<string, unknown>;
  metricFilter?: Record<string, unknown>;
}

export interface Ga4Row {
  dimensionValues: Array<{ value: string }>;
  metricValues: Array<{ value: string }>;
}

export interface Ga4ReportResponse {
  dimensionHeaders: Array<{ name: string }>;
  metricHeaders: Array<{ name: string; type: string }>;
  rows: Ga4Row[];
  rowCount: number;
  metadata?: Record<string, unknown>;
}

export class Ga4ApiError extends Error {
  constructor(public readonly status: number, public readonly body: unknown, message: string) {
    super(message);
    this.name = 'Ga4ApiError';
  }
}
```

Add method to the `Ga4Client` class:

```ts
  async runReport(req: Ga4ReportRequest): Promise<Ga4ReportResponse> {
    return this.post<Ga4ReportResponse>(`:runReport`, req);
  }

  private async post<T>(suffix: string, body: unknown): Promise<T> {
    const headers = await this.getAuthHeaders();
    const baseUrl = this.cfg.baseUrl ?? 'https://analyticsdata.googleapis.com/v1beta';
    const url = `${baseUrl}/properties/${this.cfg.propertyId}${suffix}`;
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!res.ok) {
      const msg = (parsed as { error?: { message?: string } } | null)?.error?.message ?? text.slice(0, 200);
      logger.warn({ status: res.status, body: parsed }, 'ga4 api error');
      throw new Ga4ApiError(res.status, parsed, `GA4 ${suffix} -> ${res.status}: ${msg}`);
    }
    return parsed as T;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/ga4/client.test.ts`
Expected: PASS — `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/ga4/client.ts tests/unit/ga4/client.test.ts
git commit -m "feat(ga4): runReport over Data API v1beta with typed request/response + error class"
```

---

## Task 4: `Ga4Client.runRealtimeReport()` — last 30 min activity

**Files:**
- Modify: `src/connectors/ga4/client.ts`
- Test: `tests/unit/ga4/client.test.ts`

- [ ] **Step 1: Add failing test**

Append to `tests/unit/ga4/client.test.ts`:

```ts
describe('Ga4Client.runRealtimeReport', () => {
  it('POSTs to runRealtimeReport endpoint', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://analyticsdata.googleapis.com/v1beta/properties/12345:runRealtimeReport');
      return new Response(JSON.stringify({
        dimensionHeaders: [{ name: 'country' }],
        metricHeaders: [{ name: 'activeUsers', type: 'TYPE_INTEGER' }],
        rows: [{ dimensionValues: [{ value: 'United States' }], metricValues: [{ value: '12' }] }],
        rowCount: 1,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = new Ga4Client({
      propertyId: '12345',
      serviceAccountKey: JSON.stringify(FAKE_KEY),
      authFactory: () => ({ getRequestHeaders: async () => ({ Authorization: 'Bearer x' }) }) as never,
      fetchImpl: fetchMock as never,
    });
    const out = await client.runRealtimeReport({
      dimensions: [{ name: 'country' }],
      metrics: [{ name: 'activeUsers' }],
    });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].metricValues[0].value).toBe('12');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/ga4/client.test.ts`
Expected: FAIL — `client.runRealtimeReport is not a function`.

- [ ] **Step 3: Add types + method**

Append types in `src/connectors/ga4/client.ts`:

```ts
export interface Ga4RealtimeReportRequest {
  dimensions?: Ga4Dimension[];
  metrics: Ga4Metric[];
  limit?: number;
}
```

Add method to the `Ga4Client` class:

```ts
  async runRealtimeReport(req: Ga4RealtimeReportRequest): Promise<Ga4ReportResponse> {
    return this.post<Ga4ReportResponse>(`:runRealtimeReport`, req);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/ga4/client.test.ts`
Expected: PASS — `4 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/ga4/client.ts tests/unit/ga4/client.test.ts
git commit -m "feat(ga4): runRealtimeReport for last-30-min metrics"
```

---

## Task 5: `Ga4Connector` with `ga4.run_report` tool

**Files:**
- Create: `src/connectors/ga4/connector.ts`
- Test: `tests/unit/ga4/connector.test.ts`

- [ ] **Step 1: Write failing test for the connector + `ga4.run_report`**

Create `tests/unit/ga4/connector.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { Ga4Connector } from '../../../src/connectors/ga4/connector.js';
import type { Ga4Client } from '../../../src/connectors/ga4/client.js';

function fakeClient(report: unknown): Ga4Client {
  return {
    runReport: vi.fn(async () => report),
    runRealtimeReport: vi.fn(),
  } as unknown as Ga4Client;
}

describe('Ga4Connector.ga4.run_report', () => {
  it('exposes the tool and validates args via Zod', async () => {
    const conn = new Ga4Connector({ client: fakeClient({}) });
    const tool = conn.tools.find((t) => t.name === 'ga4.run_report');
    expect(tool).toBeDefined();
    // missing required `metrics` should fail validation when called via the registry,
    // but here we exercise the schema directly:
    expect(tool!.schema.safeParse({}).success).toBe(false);
    expect(tool!.schema.safeParse({ metrics: ['sessions'] }).success).toBe(true);
  });

  it('reshapes the GA4 response into a flat rows array', async () => {
    const client = fakeClient({
      dimensionHeaders: [{ name: 'sessionDefaultChannelGroup' }],
      metricHeaders: [{ name: 'sessions', type: 'TYPE_INTEGER' }, { name: 'totalUsers', type: 'TYPE_INTEGER' }],
      rows: [
        { dimensionValues: [{ value: 'Direct' }], metricValues: [{ value: '120' }, { value: '95' }] },
        { dimensionValues: [{ value: 'Organic Search' }], metricValues: [{ value: '60' }, { value: '40' }] },
      ],
      rowCount: 2,
    });
    const conn = new Ga4Connector({ client });
    const tool = conn.tools.find((t) => t.name === 'ga4.run_report')!;
    const out = await tool.execute({
      dateRange: 'last_7_days',
      dimensions: ['sessionDefaultChannelGroup'],
      metrics: ['sessions', 'totalUsers'],
    }) as { rows: Array<Record<string, unknown>>; rowCount: number };
    expect(out.rowCount).toBe(2);
    expect(out.rows).toEqual([
      { sessionDefaultChannelGroup: 'Direct', sessions: 120, totalUsers: 95 },
      { sessionDefaultChannelGroup: 'Organic Search', sessions: 60, totalUsers: 40 },
    ]);
  });

  it('translates preset dateRange to GA4 relative-date strings', async () => {
    const client = { runReport: vi.fn(async () => ({ rows: [], rowCount: 0, dimensionHeaders: [], metricHeaders: [] })) } as unknown as Ga4Client;
    const conn = new Ga4Connector({ client });
    const tool = conn.tools.find((t) => t.name === 'ga4.run_report')!;
    await tool.execute({ dateRange: 'last_30_days', metrics: ['sessions'] });
    expect((client.runReport as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
      metrics: [{ name: 'sessions' }],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/ga4/connector.test.ts`
Expected: FAIL — `Ga4Connector` cannot be imported.

- [ ] **Step 3: Implement `Ga4Connector` with `ga4.run_report`**

Create `src/connectors/ga4/connector.ts`:

```ts
import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import type { Ga4Client, Ga4ReportRequest, Ga4ReportResponse } from './client.js';
import { Ga4ApiError } from './client.js';

export interface Ga4ConnectorDeps {
  client: Ga4Client;
}

const DateRange = z.union([
  z.enum(['yesterday', 'today', 'last_7_days', 'last_14_days', 'last_30_days', 'last_90_days', 'last_180_days', 'last_365_days', 'this_month', 'last_month'])
    .describe('Preset relative window. GA4 buckets in the property\'s reporting time zone.'),
  z.object({
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
    end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  }).describe('Fixed date range, both bounds inclusive.'),
]);

const RunReportArgs = z.object({
  dateRange: DateRange,
  metrics: z.array(z.string()).min(1).describe('GA4 metric names. Common: `sessions`, `totalUsers`, `newUsers`, `screenPageViews`, `conversions`, `userEngagementDuration`, `bounceRate`, `engagementRate`, `eventCount`, `purchaseRevenue`, `transactions`, `addToCarts`, `checkouts`.'),
  dimensions: z.array(z.string()).optional().describe('Optional GA4 dimension names. Common: `sessionDefaultChannelGroup`, `sessionSourceMedium`, `country`, `deviceCategory`, `pagePath`, `pageTitle`, `landingPage`, `eventName`, `date`, `hour`. Omit for a single roll-up row.'),
  limit: z.number().int().min(1).max(100_000).default(1000).describe('Row cap. GA4 max is 100 000 per request.'),
  orderBy: z.object({
    metric: z.string().optional(),
    dimension: z.string().optional(),
    desc: z.boolean().default(true),
  }).optional().describe('Sort. Pass either `metric` or `dimension` (not both).'),
});
type RunReportArgs = z.infer<typeof RunReportArgs>;

const RealtimeArgs = z.object({
  metrics: z.array(z.string()).min(1).default(['activeUsers']).describe('Realtime metrics. Most useful: `activeUsers`, `screenPageViews`, `eventCount`, `keyEvents`. Note: realtime is a separate endpoint with a smaller catalog than the standard report.'),
  dimensions: z.array(z.string()).optional().describe('Realtime dimensions. Common: `country`, `deviceCategory`, `unifiedScreenName`, `eventName`. Omit for a single number.'),
  limit: z.number().int().min(1).max(10_000).default(100),
});
type RealtimeArgs = z.infer<typeof RealtimeArgs>;

export class Ga4Connector implements Connector {
  readonly name = 'ga4';
  readonly tools: readonly ToolDef[];

  constructor(private readonly deps: Ga4ConnectorDeps) {
    this.tools = [this.runReportTool(), this.realtimeTool()];
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.deps.client.runReport({
        dateRanges: [{ startDate: 'today', endDate: 'today' }],
        metrics: [{ name: 'sessions' }],
        limit: 1,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private runReportTool(): ToolDef<RunReportArgs> {
    return {
      name: 'ga4.run_report',
      description: [
        'Run a Google Analytics 4 report over a date range with optional dimensions. Use ONLY when the user explicitly asks for GA4, Google Analytics, sessions, page views, funnel/drop-off, bounce rate, engagement, behavior, events, or any metric Northbeam does not track. For revenue/spend/ROAS/CAC/attribution, use Northbeam.',
        'Common dimensions: `sessionDefaultChannelGroup`, `sessionSourceMedium`, `country`, `deviceCategory`, `pagePath`, `pageTitle`, `landingPage`, `eventName`, `date`. Common metrics: `sessions`, `totalUsers`, `newUsers`, `screenPageViews`, `conversions`, `bounceRate`, `engagementRate`, `eventCount`, `purchaseRevenue`, `transactions`, `addToCarts`, `checkouts`.',
        'Examples: "Sessions last 7 days by channel" → `metrics:["sessions"], dimensions:["sessionDefaultChannelGroup"], dateRange:"last_7_days"`. "Add-to-cart rate by device this month" → `metrics:["addToCarts","sessions"], dimensions:["deviceCategory"], dateRange:"this_month"`, then divide client-side. "Top 20 landing pages last 30d" → `metrics:["sessions","engagementRate"], dimensions:["landingPage"], dateRange:"last_30_days", orderBy:{metric:"sessions"}, limit:20`.',
      ].join(' '),
      schema: RunReportArgs as z.ZodType<RunReportArgs>,
      jsonSchema: zodToJsonSchema(RunReportArgs),
      execute: (args) => this.runReport(args),
    };
  }

  private realtimeTool(): ToolDef<RealtimeArgs> {
    return {
      name: 'ga4.realtime',
      description: [
        'Active GA4 users in the last 30 minutes. Use for "how many users are on the site right now", "realtime traffic", "live activity" type questions.',
        'Optionally break down by `country`, `deviceCategory`, `unifiedScreenName`, or `eventName`. Returns one row per breakdown value with the requested metrics (defaults to `activeUsers`).',
      ].join(' '),
      schema: RealtimeArgs as z.ZodType<RealtimeArgs>,
      jsonSchema: zodToJsonSchema(RealtimeArgs),
      execute: (args) => this.realtime(args),
    };
  }

  private async runReport(args: RunReportArgs) {
    const req: Ga4ReportRequest = {
      dateRanges: [resolveDateRange(args.dateRange)],
      metrics: args.metrics.map((name) => ({ name })),
      ...(args.dimensions && args.dimensions.length ? { dimensions: args.dimensions.map((name) => ({ name })) } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
      ...(args.orderBy
        ? {
            orderBys: [{
              ...(args.orderBy.metric ? { metric: { metricName: args.orderBy.metric } } : {}),
              ...(args.orderBy.dimension ? { dimension: { dimensionName: args.orderBy.dimension } } : {}),
              desc: args.orderBy.desc,
            }],
          }
        : {}),
    };
    try {
      const res = await this.deps.client.runReport(req);
      return { period: args.dateRange, ...flattenReport(res) };
    } catch (err) {
      if (err instanceof Ga4ApiError) {
        return { error: { code: 'GA4_API_ERROR', status: err.status, message: err.message, body: err.body } };
      }
      throw err;
    }
  }

  private async realtime(args: RealtimeArgs) {
    try {
      const res = await this.deps.client.runRealtimeReport({
        metrics: args.metrics.map((name) => ({ name })),
        ...(args.dimensions && args.dimensions.length ? { dimensions: args.dimensions.map((name) => ({ name })) } : {}),
        ...(args.limit ? { limit: args.limit } : {}),
      });
      return flattenReport(res);
    } catch (err) {
      if (err instanceof Ga4ApiError) {
        return { error: { code: 'GA4_API_ERROR', status: err.status, message: err.message, body: err.body } };
      }
      throw err;
    }
  }
}

function resolveDateRange(input: RunReportArgs['dateRange']): { startDate: string; endDate: string } {
  if (typeof input === 'string') {
    switch (input) {
      case 'yesterday': return { startDate: 'yesterday', endDate: 'yesterday' };
      case 'today': return { startDate: 'today', endDate: 'today' };
      case 'last_7_days': return { startDate: '7daysAgo', endDate: 'today' };
      case 'last_14_days': return { startDate: '14daysAgo', endDate: 'today' };
      case 'last_30_days': return { startDate: '30daysAgo', endDate: 'today' };
      case 'last_90_days': return { startDate: '90daysAgo', endDate: 'today' };
      case 'last_180_days': return { startDate: '180daysAgo', endDate: 'today' };
      case 'last_365_days': return { startDate: '365daysAgo', endDate: 'today' };
      // GA4 doesn't ship "this_month"/"last_month" relative tokens — translate to fixed strings client-side.
      // Use the property's reporting timezone is fine; we approximate with UTC since GA4 also accepts YYYY-MM-DD literals.
      case 'this_month': {
        const now = new Date();
        const y = now.getUTCFullYear();
        const m = String(now.getUTCMonth() + 1).padStart(2, '0');
        return { startDate: `${y}-${m}-01`, endDate: 'today' };
      }
      case 'last_month': {
        const now = new Date();
        const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
        const y = last.getUTCFullYear();
        const m = String(last.getUTCMonth() + 1).padStart(2, '0');
        const endOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
        const eY = endOfMonth.getUTCFullYear();
        const eM = String(endOfMonth.getUTCMonth() + 1).padStart(2, '0');
        const eD = String(endOfMonth.getUTCDate()).padStart(2, '0');
        return { startDate: `${y}-${m}-01`, endDate: `${eY}-${eM}-${eD}` };
      }
    }
    throw new Error(`Unknown dateRange preset: ${input as string}`);
  }
  return { startDate: input.start, endDate: input.end };
}

function flattenReport(res: Ga4ReportResponse) {
  const dims = (res.dimensionHeaders ?? []).map((h) => h.name);
  const mets = (res.metricHeaders ?? []).map((h) => h.name);
  const rows = (res.rows ?? []).map((r) => {
    const o: Record<string, unknown> = {};
    dims.forEach((d, i) => { o[d] = r.dimensionValues[i]?.value ?? null; });
    mets.forEach((m, i) => {
      const v = r.metricValues[i]?.value;
      const n = v == null ? null : Number(v);
      o[m] = n != null && Number.isFinite(n) ? n : v;
    });
    return o;
  });
  return { rowCount: res.rowCount ?? rows.length, dimensions: dims, metrics: mets, rows };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/ga4/connector.test.ts`
Expected: PASS — `3 passed`.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: 28+ files passed, all tests green.

- [ ] **Step 6: Commit**

```bash
git add src/connectors/ga4/connector.ts tests/unit/ga4/connector.test.ts
git commit -m "feat(ga4): connector with ga4.run_report + ga4.realtime tools"
```

---

## Task 6: Wire `Ga4Connector` into `src/index.ts`

**Files:**
- Modify: `src/index.ts:39-56` (vault-secret reads), `src/index.ts:115-117` (registry registrations)

- [ ] **Step 1: Add the two GA4 vault reads**

Find the destructured `await Promise.all([...])` block near line 44 and append two reads. After this edit, the block looks like:

```ts
  const [
    email, password, dashboardId,
    nbApiKey, nbDataClientId,
    porterApiBaseUrl, porterBotEmail, porterBotPassword,
    grafanaUrl, grafanaToken, grafanaPostgresDsUid,
    ga4PropertyId, ga4ServiceAccountKey,
  ] = await Promise.all([
    readVaultSecret(supabase, 'NORTHBEAM_EMAIL'),
    readVaultSecret(supabase, 'NORTHBEAM_PASSWORD'),
    readVaultSecret(supabase, 'NORTHBEAM_DASHBOARD_ID'),
    readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
    readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
    readVaultSecret(supabase, 'PORTER_API_BASE_URL'),
    readVaultSecret(supabase, 'PORTER_BOT_EMAIL'),
    readVaultSecret(supabase, 'PORTER_BOT_PASSWORD'),
    readVaultSecret(supabase, 'GRAFANA_URL'),
    readVaultSecret(supabase, 'GRAFANA_TOKEN'),
    readVaultSecret(supabase, 'GRAFANA_POSTGRES_DS_UID'),
    readVaultSecret(supabase, 'GA4_PROPERTY_ID').catch(() => null),
    readVaultSecret(supabase, 'GA4_SERVICE_ACCOUNT_KEY').catch(() => null),
  ]);
```

The `.catch(() => null)` makes the secret-read non-fatal: if the secrets aren't set yet, we skip GA4 registration without crashing the bot.

- [ ] **Step 2: Add imports + conditional registration**

Add the import near the other connector imports (alphabetical with the others):

```ts
import { Ga4Client } from './connectors/ga4/client.js';
import { Ga4Connector } from './connectors/ga4/connector.js';
```

Find the `registry.register(new MarketingAnalysisConnector(...))` line. Right after the `LateOrdersConnector` registration, insert:

```ts
  if (ga4PropertyId && ga4ServiceAccountKey) {
    const ga4 = new Ga4Connector({
      client: new Ga4Client({ propertyId: ga4PropertyId, serviceAccountKey: ga4ServiceAccountKey }),
    });
    registry.register(ga4);
    logger.info({ propertyId: ga4PropertyId }, 'ga4 connector registered');
  } else {
    logger.warn('ga4 not configured (GA4_PROPERTY_ID and/or GA4_SERVICE_ACCOUNT_KEY missing) — skipping registration');
  }
```

- [ ] **Step 3: Build to confirm no TS errors**

Run: `npm run build`
Expected: `tsc` exits 0 with no output.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(ga4): wire Ga4Connector into bootstrap (gracefully skips if vault secrets absent)"
```

---

## Task 7: Update system prompt with GA4 routing rule + tool docs

**Files:**
- Modify: `src/orchestrator/prompts.ts` (the absolute-routing block + the tool docs section)

- [ ] **Step 1: Extend the absolute-routing block at the top**

Find the rule starting `🚨 ABSOLUTE TOOL ROUTING RULES` and add a new bullet after rule 3 (which talks about NB ↔ Porter compare):

```
4. **Behavior / funnel / page-level / realtime / event tracking → \`ga4.*\` ONLY when the user explicitly asks for it.** Trigger words (any language): GA4, Google Analytics, sessions, sesiones, page views, vistas de página, landing page, bounce rate, tasa de rebote, engagement rate, drop-off, funnel, embudo, add to cart, checkout, conversion rate, tasa de conversión, eventos, scroll depth, video plays, realtime, en vivo, active users, usuarios activos, dispositivos, países (when about traffic/audience). 🛑 **For revenue / spend / ROAS / CAC / LTV / channel-attributed performance, default to Northbeam — even if the user mentions "channel" or "campaign", that's a Northbeam question, NOT a GA4 question.** Only fire GA4 when the question is unambiguously about behavior or audience metrics that NB doesn't track.
```

- [ ] **Step 2: Add a GA4 tool docs section**

Find the `*1. Marketing attribution & spend (Northbeam REST API)*` section. After it (and before the next numbered section), insert:

```
*1b. Site behavior & realtime (Google Analytics 4 — GA4 Data API)* — \`ga4.run_report\`, \`ga4.realtime\`
  • Only registered when the GA4 service-account credentials are present in the bot's vault. If you don't see these tools in the available list, GA4 is not configured for this environment — answer with NB-only data and tell the user.
  • **\`ga4.run_report\`** — generic dimension × metric report over a date range. Args: \`dateRange\` (preset \`yesterday\` / \`last_7_days\` / \`last_30_days\` / \`last_90_days\` / \`last_180_days\` / \`last_365_days\` / \`this_month\` / \`last_month\` OR \`{start: 'YYYY-MM-DD', end: 'YYYY-MM-DD'}\`), \`metrics\` (array of GA4 metric names — required), \`dimensions\` (optional), \`limit\` (default 1000), \`orderBy\` (\`{metric|dimension, desc}\`). Returns \`{period, rowCount, dimensions, metrics, rows}\` where \`rows\` is a flat array of \`{<dimensionName>: string, <metricName>: number}\`.
  • **\`ga4.realtime\`** — last-30-min activity. Defaults to \`metrics:['activeUsers']\`. Optional \`dimensions\`: \`country\`, \`deviceCategory\`, \`unifiedScreenName\`, \`eventName\`.
  • **Common GA4 dimensions:** \`sessionDefaultChannelGroup\` (Direct/Organic Search/Paid Search/Email/etc.), \`sessionSourceMedium\` (e.g. \`google / cpc\`), \`country\`, \`deviceCategory\` (\`desktop\` / \`mobile\` / \`tablet\`), \`pagePath\`, \`pageTitle\`, \`landingPage\`, \`eventName\`, \`date\`, \`hour\`.
  • **Common GA4 metrics:** \`sessions\`, \`totalUsers\`, \`newUsers\`, \`screenPageViews\`, \`conversions\`, \`bounceRate\`, \`engagementRate\`, \`userEngagementDuration\`, \`eventCount\`, \`purchaseRevenue\`, \`transactions\`, \`addToCarts\`, \`checkouts\`.
  • **When to use GA4 vs NB (CRITICAL):**
    - "How many sessions / page views / unique visitors / bounce rate / engagement rate" → GA4
    - "Add to cart / checkout / conversion-rate funnel" → GA4
    - "Top landing pages / top product pages / top events" → GA4
    - "Realtime traffic / users on site right now" → \`ga4.realtime\`
    - "Revenue / spend / ROAS / CAC / LTV / attributed orders / channel performance for marketing decisions" → NB (\`northbeam.*\` and \`gantri.attribution_*\`)
    - "Compare native Meta/Google ROAS vs Northbeam attribution" → NB only — NB exposes \`metaROAS7DClick1DView\` etc.
  • **Example queries:**
    - "Sessions by channel last 7 days" → \`ga4.run_report({dateRange: 'last_7_days', dimensions: ['sessionDefaultChannelGroup'], metrics: ['sessions']})\`.
    - "Top 20 landing pages by sessions in April" → \`ga4.run_report({dateRange: {start:'2026-04-01', end:'2026-04-30'}, dimensions:['landingPage'], metrics:['sessions','engagementRate'], orderBy:{metric:'sessions'}, limit:20})\`.
    - "Add-to-cart rate by device this month" → \`ga4.run_report({dateRange:'this_month', dimensions:['deviceCategory'], metrics:['addToCarts','sessions']})\`, then compute \`addToCarts/sessions\` per row.
    - "How many users are on the site right now" → \`ga4.realtime({})\`.
  • **Gotchas:** GA4 metric/dimension names are case-sensitive and use camelCase (\`sessions\`, NOT \`Sessions\`; \`sessionDefaultChannelGroup\`, NOT \`session_default_channel_group\`). Always pass the exact name. If you're unsure of a name, default to the common ones above before guessing.
```

- [ ] **Step 3: Also extend the "What you can answer" canonical list (very top)**

Find `*1. Marketing attribution & spend (Northbeam REST API)*` in the top "What you can answer" canonical list and insert this line right below it:

```
*1b. Site behavior & realtime (GA4)* — \`ga4.run_report\` + \`ga4.realtime\`
```

- [ ] **Step 4: Build to confirm prompt syntax**

Run: `npm run build`
Expected: `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/prompts.ts
git commit -m "feat(ga4): system prompt — routing rule + tool docs (NB stays default for marketing)"
```

---

## Task 8: Smoke test from the orchestrator runner

**Files:**
- Modify: `scripts/test-30-questions.mjs` (add 3 GA4-flavored questions to the list)

Note: This task validates the integration end-to-end, including auth, against the real GA4 property. Skip this task if the user hasn't provided the service-account JSON + property ID yet — the unit tests in tasks 2-5 prove the contracts.

- [ ] **Step 1: Append GA4 questions to the QUESTIONS array**

Find the `const QUESTIONS = [...]` array in `scripts/test-30-questions.mjs` and add three at the end:

```js
  // GA4 — only fire when user explicitly mentions it
  { n: 31, cat: 'GA4', q: '¿Cuántas sesiones tuvimos en GA4 los últimos 7 días?' },
  { n: 32, cat: 'GA4', q: 'Top 10 landing pages por sesiones la semana pasada en Google Analytics' },
  { n: 33, cat: 'GA4', q: '¿Cuántos usuarios activos hay en el sitio ahora mismo?' },
  // Routing-canary: this should still fire NB, NOT GA4 (no GA4 trigger words)
  { n: 34, cat: 'Routing canary (must use NB)', q: '¿Qué canal generó más revenue atribuido la semana pasada?' },
```

- [ ] **Step 2: Run only the GA4 + canary subset**

Run: `node scripts/test-30-questions.mjs --qs 31,32,33,34`
Expected:
- Q31 → uses `ga4.run_report` (only). No `northbeam.*` calls.
- Q32 → uses `ga4.run_report` with `landingPage` dimension. No `northbeam.*` calls.
- Q33 → uses `ga4.realtime`. Single call, sub-second latency.
- Q34 → uses `northbeam.metrics_explorer` (or `gantri.attribution_*`). NO `ga4.*` calls.

- [ ] **Step 3: Inspect responses**

Run: `python3 -c "import json; d=json.load(open('.test-30-results.json')); [print(f'Q{r[chr(34)+chr(110)+chr(34)]}: tools={[tc[chr(34)+chr(110)+chr(97)+chr(109)+chr(101)+chr(34)] for tc in r[chr(34)+chr(116)+chr(111)+chr(111)+chr(108)+chr(67)+chr(97)+chr(108)+chr(108)+chr(115)+chr(34)]]}')) for r in d[chr(34)+chr(114)+chr(101)+chr(115)+chr(117)+chr(108)+chr(116)+chr(115)+chr(34)] if r[chr(34)+chr(110)+chr(34)] in (31,32,33,34)]"`

Or just `cat .test-30-results.json | python3 -m json.tool | grep -A 5 '"n": 31'` for each.

Expected: each tool list contains the right tool name, no cross-contamination.

- [ ] **Step 4: If any of Q31/32/33 returned an error**

Inspect the error in `errorMessage`. Likely causes:
- `403 PERMISSION_DENIED` → service account email not added as Viewer in GA4 Property Access. Add it and re-run.
- `400` with "Invalid metric/dimension" → typo in metric/dimension name. Cross-check against the GA4 docs (https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema).
- `401` → service-account key invalid/expired. Re-download.
- Connection refused / `ECONNREFUSED` → check the bot has outbound network to `analyticsdata.googleapis.com` (it should, no firewall changes needed for Fly).

- [ ] **Step 5: Commit smoke-test additions**

```bash
git add scripts/test-30-questions.mjs
git commit -m "test(ga4): 3 GA4 smoke questions + 1 NB-routing canary"
```

---

## Task 9: Deploy + manual verification in Slack

**Files:**
- (no code changes; this is the deploy step)

- [ ] **Step 1: Add the two GA4 secrets to Supabase Vault**

User pastes the service-account JSON (entire file as a string) and the property ID. Maintainer runs against the vault project:

```sql
-- In the Supabase SQL editor for project ykjjwszoxazzlcovhlgd, as the postgres role:
SELECT vault.create_secret(<paste-service-account-json-here>::text, 'GA4_SERVICE_ACCOUNT_KEY');
SELECT vault.create_secret('123456789', 'GA4_PROPERTY_ID');  -- replace with actual ID
```

Verify both come back via the helper RPC:

```sql
SELECT read_vault_secret('GA4_PROPERTY_ID');           -- expect the numeric ID
SELECT length(read_vault_secret('GA4_SERVICE_ACCOUNT_KEY'));  -- expect ~2400+ chars
```

- [ ] **Step 2: Push branch + deploy to Fly**

```bash
git push origin feat/northbeam-api-migration
fly deploy --remote-only
```

Expected: deploy succeeds. Logs show `ga4 connector registered { propertyId: '...' }`.

- [ ] **Step 3: Verify health checks**

```bash
curl -sS https://gantri-ai-bot.fly.dev/healthz
# {"ok":true}

curl -sS https://gantri-ai-bot.fly.dev/readyz
# {"ok":true,...} — confirms NB + Porter + Grafana still healthy. (GA4 is not in the readyz check yet; that's fine.)
```

- [ ] **Step 4: Manual prompts in Slack DM with @gantri-ai**

Run these one at a time and verify the bot's tool selection and answer quality:

| Prompt | Expected tool | Should NOT call |
|---|---|---|
| `¿Cuántas sesiones tuvimos en GA4 los últimos 7 días?` | `ga4.run_report` | `northbeam.*` |
| `Top 5 landing pages por sesiones la semana pasada` | `ga4.run_report` (with `landingPage` dim) | `northbeam.*` |
| `Bounce rate por dispositivo este mes en Google Analytics` | `ga4.run_report` | `northbeam.*` |
| `¿Cuántos usuarios activos hay ahora mismo?` | `ga4.realtime` | `northbeam.*` |
| `¿Qué canal generó más revenue atribuido la semana pasada?` | `northbeam.metrics_explorer` | `ga4.*` |
| `¿Cuál es el ROAS de Google los últimos 30 días?` | `northbeam.metrics_explorer` | `ga4.*` |

- [ ] **Step 5: If routing fails on any prompt**

If the bot called the wrong tool, capture the message + the tool list and iterate on the prompt. Common fixes:
- Bot called GA4 for an attribution question → strengthen the "🛑 For revenue/spend/ROAS/CAC default to NB" line in the routing block.
- Bot called NB for a sessions question → add the trigger word the user used to the GA4 trigger list.

Edit `src/orchestrator/prompts.ts`, build, and re-deploy:

```bash
npm run build
git add src/orchestrator/prompts.ts
git commit -m "fix(ga4): tighten routing — <describe the mis-route>"
git push
fly deploy --remote-only
```

- [ ] **Step 6: Final commit if any prompt fixes were needed**

(See step 5 above; nothing to do here if step 4 passed clean.)

---

## Self-review checklist (executed already by the plan author; engineer can re-run if anything looks off)

**1. Spec coverage:**
- "Service-account auth + access-token caching" → Task 2 ✅
- "Generic `ga4.run_report` tool" → Tasks 3 + 5 ✅
- "Realtime tool" → Tasks 4 + 5 ✅
- "Wired into bootstrap, gracefully skips if creds missing" → Task 6 ✅
- "Prompt routing: NB default; GA4 only on explicit triggers" → Task 7 ✅
- "Smoke-test live + deploy" → Tasks 8 + 9 ✅

**2. Placeholder scan:** no "TBD"/"TODO" in steps — every step has either code, exact commands, or expected output. The only conditional (Task 8 step 4) lists concrete failure modes + remedies.

**3. Type consistency:** `Ga4ReportRequest` / `Ga4ReportResponse` / `Ga4ReportRow` / `Ga4ApiError` are all defined in Task 3 and used unchanged in Tasks 4 + 5. Tool args (`RunReportArgs`, `RealtimeArgs`) are defined in Task 5 and never re-defined. Connector class name `Ga4Connector` is consistent across tasks 5, 6, 7. Vault secret names `GA4_PROPERTY_ID` + `GA4_SERVICE_ACCOUNT_KEY` are consistent across tasks 1, 6, 9.
