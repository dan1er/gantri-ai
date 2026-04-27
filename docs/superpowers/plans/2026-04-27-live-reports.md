# Live Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Live Reports feature: bot generates a JSON spec from a "live report" intent, persists it, and serves a beautiful Tremor-based dashboard at `/r/<slug>` that re-runs the spec on each visit (no LLM in the request path).

**Architecture:** A `LiveReportSpec` (versioned JSON, tool-whitelisted) is compiled by the LLM once and stored in `published_reports`. Each visit to `/r/<slug>` loads a Vite-built React SPA which fetches `/r/<slug>/data.json`. The data endpoint executes the spec — paralleling the listed tool calls and resolving `ValueRef` paths into UI blocks — then returns `{dataResults, ui, meta}`. RBAC: author + admin can modify; URL token gates view (Slack OAuth in phase 2). Cross-org dedup before each new compile.

**Tech Stack:** TypeScript ESM Node 20, Express (existing), Supabase (existing), Vite + React + Tailwind + Tremor for the SPA, Shiki for spec syntax highlighting, vitest, zod.

**Reference spec:** `docs/superpowers/specs/2026-04-27-live-reports-design.md`

---

## File Structure

**New backend files:**
- `src/reports/live/spec.ts` — Zod schemas for `LiveReportSpec` v1 + `WHITELISTED_TOOLS` constant.
- `src/reports/live/value-ref.ts` — `resolveValueRef(ref, dataResults)` parser/resolver.
- `src/reports/live/runner.ts` — `runLiveSpec(spec, registry)` parallel tool dispatch + UI hydration.
- `src/reports/live/dedup.ts` — keyword extraction + `findSimilarReports`.
- `src/reports/live/identifiers.ts` — `slugifyTitle`, `generateAccessToken`, collision-aware `findFreeSlug`.
- `src/storage/repositories/published-reports.ts` — CRUD + history.
- `src/connectors/live-reports/connector.ts` — `LiveReportsConnector` exposing 5 tools.
- `src/connectors/live-reports/compiler.ts` — `compileLiveReport(intent, claude, registry)` LLM call + Zod retry.
- `src/server/live-reports-routes.ts` — Express routes mounted on the existing receiver.

**New frontend files (under `web/`):**
- `web/package.json`, `web/vite.config.ts`, `web/tailwind.config.ts`, `web/postcss.config.js`, `web/tsconfig.json`, `web/index.html`
- `web/public/logo-name.png`, `web/public/favicon.png` (copied from `gantri/mantle/public/`)
- `web/src/main.tsx`, `web/src/App.tsx`, `web/src/styles/globals.css`
- `web/src/lib/{api.ts,format.ts,valueRef.ts}`
- `web/src/theme/{tokens.ts,tremor.ts}`
- `web/src/blocks/{KpiBlock.tsx,ChartBlock.tsx,TableBlock.tsx,TextBlock.tsx,DividerBlock.tsx}`
- `web/src/components/{ReportHeader.tsx,ReportFooter.tsx,SpecDrawer.tsx,ErrorState.tsx,LoadingShimmer.tsx}`

**Modified backend files:**
- `package.json` — add Vite/React/Tremor build deps, shiki, nanoid.
- `src/index.ts` — register `LiveReportsConnector`, mount `live-reports-routes`, serve `web/dist` static.
- `src/orchestrator/prompts.ts` — add live-reports section + trigger-phrase rule + dedup-first rule.
- `Dockerfile` — `npm run build:web` step before final image.
- `supabase/migrations/0010_published_reports.sql` (new) — tables + indexes.

---

## Phase 0 — Foundations (1 task)

### Task 0: Scaffold `web/` + add backend deps

**Files:**
- Create: `web/package.json`, `web/vite.config.ts`, `web/tailwind.config.ts`, `web/postcss.config.js`, `web/tsconfig.json`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/styles/globals.css`, `web/.gitignore`
- Modify: `package.json` (add `nanoid`, `shiki`)
- Modify: `Dockerfile` (build SPA before runtime image)

- [ ] **Step 1: Add backend deps**

Edit root `package.json`, add to `dependencies`:

```json
"nanoid": "^5.0.7",
"shiki": "^1.22.0"
```

Run: `cd /Users/danierestevez/Documents/work/gantri/gantri-ai-bot && npm install`
Expected: `added 2 packages` (or more for transitive).

- [ ] **Step 2: Scaffold `web/`**

Create `web/.gitignore`:
```
dist/
node_modules/
```

Create `web/package.json`:
```json
{
  "name": "gantri-ai-bot-web",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@tremor/react": "^3.18.4",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.3",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.14",
    "typescript": "^5.6.3",
    "vite": "^5.4.10"
  }
}
```

Create `web/vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  base: '/r/',
});
```

Create `web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

Create `web/tailwind.config.ts`:
```ts
import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    './node_modules/@tremor/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        gantri: {
          ink: '#0E0E0E',
          paper: '#FAFAFA',
          accent: '#0066FF',
        },
      },
    },
  },
  plugins: [],
};
export default config;
```

Create `web/postcss.config.js`:
```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

Create `web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/png" href="/r/favicon.png" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Live Report</title>
    <link rel="stylesheet" href="https://rsms.me/inter/inter.css" />
  </head>
  <body class="bg-gantri-paper text-gantri-ink antialiased">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Create `web/src/styles/globals.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

html { font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
body { font-feature-settings: 'cv11', 'ss01'; }
```

Create `web/src/main.tsx`:
```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import './styles/globals.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

Create placeholder `web/src/App.tsx`:
```tsx
export function App() {
  return (
    <div className="min-h-screen flex items-center justify-center text-2xl">
      Live Reports SPA — coming online…
    </div>
  );
}
```

Copy logo:
```bash
mkdir -p web/public
cp /Users/danierestevez/Documents/work/gantri/mantle/public/logo-name.png web/public/logo-name.png
cp /Users/danierestevez/Documents/work/gantri/mantle/public/favicon.png web/public/favicon.png
cp /Users/danierestevez/Documents/work/gantri/mantle/public/logo-bg.png web/public/og-image.png
```

- [ ] **Step 3: Install + build the web bundle**

```bash
cd web && npm install && npm run build
```
Expected: `dist/` folder created. `dist/index.html` + `dist/assets/*.{js,css}` exist.

- [ ] **Step 4: Wire root build script + Dockerfile**

Edit root `package.json` `scripts`:
```json
"build:web": "cd web && npm install --no-audit --no-fund && npm run build",
"build": "tsc && npm run build:web"
```

Modify `Dockerfile` — add the web build before the final stage. Find the build stage (where `RUN npm run build` runs) and replace with:
```Dockerfile
RUN npm run build:web
RUN npm run build
```
Make sure `web/dist` is copied to the runtime image.

- [ ] **Step 5: Confirm full build still works**

```bash
cd /Users/danierestevez/Documents/work/gantri/gantri-ai-bot
npm run build
```
Expected: `tsc` exits 0, then `web/dist/` rebuilt, all green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(live-reports): scaffold web SPA (Vite + React + Tailwind + Tremor) + brand assets"
```

---

## Phase 1 — Backend core (6 tasks)

### Task 1: DB migration `published_reports` + history

**Files:**
- Create: `supabase/migrations/0010_published_reports.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- 0010_published_reports.sql
-- Live Reports persisted spec + history.

CREATE TABLE IF NOT EXISTS published_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  title           text NOT NULL,
  description     text,
  spec            jsonb NOT NULL,
  spec_version    int NOT NULL DEFAULT 1,
  owner_slack_id  text NOT NULL,
  intent          text NOT NULL,
  intent_keywords text[] NOT NULL DEFAULT '{}',
  access_token    text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  last_visited_at timestamptz,
  visit_count     int NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS published_reports_owner_idx ON published_reports(owner_slack_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS published_reports_keywords_idx ON published_reports USING gin(intent_keywords);

CREATE TABLE IF NOT EXISTS published_reports_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id       uuid NOT NULL REFERENCES published_reports(id) ON DELETE CASCADE,
  spec            jsonb NOT NULL,
  spec_version    int NOT NULL,
  intent          text NOT NULL,
  replaced_by_slack_id text NOT NULL,
  replaced_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS published_reports_history_report_idx ON published_reports_history(report_id, replaced_at DESC);
```

- [ ] **Step 2: Apply via Supabase MCP**

Use the supabase MCP `apply_migration` tool with project_id `ykjjwszoxazzlcovhlgd` and the SQL above.

Expected: success, no errors.

- [ ] **Step 3: Verify tables exist**

Use `execute_sql` with: `SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'published_reports%' ORDER BY table_name;`
Expected: 2 rows — `published_reports`, `published_reports_history`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0010_published_reports.sql
git commit -m "feat(live-reports): migration 0010 — published_reports + history"
```

---

### Task 2: Spec types + Zod validator (v1)

**Files:**
- Create: `src/reports/live/spec.ts`
- Test: `tests/unit/reports/live/spec.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/reports/live/spec.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { LiveReportSpec, WHITELISTED_TOOLS } from '../../../../src/reports/live/spec.js';

describe('LiveReportSpec v1', () => {
  it('accepts a minimal valid spec', () => {
    const valid = {
      version: 1,
      title: 'Weekly Sales',
      data: [
        { id: 'rev', tool: 'northbeam.metrics_explorer', args: { dateRange: 'last_7_days', metrics: ['rev'] } },
      ],
      ui: [
        { type: 'kpi', label: 'Revenue', value: 'rev.rows[0].rev', format: 'currency' },
      ],
    };
    expect(LiveReportSpec.safeParse(valid).success).toBe(true);
  });

  it('rejects a spec referencing a non-whitelisted tool', () => {
    const bad = {
      version: 1,
      title: 'Test',
      data: [{ id: 'x', tool: 'reports.create_canvas', args: {} }],
      ui: [],
    };
    expect(LiveReportSpec.safeParse(bad).success).toBe(false);
  });

  it('rejects a spec with no data steps', () => {
    expect(LiveReportSpec.safeParse({ version: 1, title: 'T', data: [], ui: [] }).success).toBe(false);
  });

  it('rejects a spec with version != 1', () => {
    expect(LiveReportSpec.safeParse({ version: 2, title: 'T', data: [{ id: 'x', tool: 'northbeam.metrics_explorer', args: {} }], ui: [] }).success).toBe(false);
  });

  it('accepts all 5 ui block types', () => {
    const spec = {
      version: 1,
      title: 'All blocks',
      data: [{ id: 's', tool: 'gantri.order_stats', args: {} }],
      ui: [
        { type: 'kpi', label: 'X', value: 's.totalOrders' },
        { type: 'chart', variant: 'line', title: 'Trend', data: 's.daily', x: 'date', y: 'orders' },
        { type: 'table', data: 's.rows', columns: [{ field: 'a', label: 'A' }] },
        { type: 'text', markdown: '## Hello' },
        { type: 'divider' },
      ],
    };
    expect(LiveReportSpec.safeParse(spec).success).toBe(true);
  });

  it('exposes WHITELISTED_TOOLS as a non-empty set including northbeam, gantri, ga4, grafana prefixes', () => {
    const tools = [...WHITELISTED_TOOLS];
    expect(tools.length).toBeGreaterThan(5);
    expect(tools.some((t) => t.startsWith('northbeam.'))).toBe(true);
    expect(tools.some((t) => t.startsWith('gantri.'))).toBe(true);
    expect(tools.some((t) => t.startsWith('ga4.'))).toBe(true);
    expect(tools.some((t) => t.startsWith('grafana.'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify fails**

```bash
cd /Users/danierestevez/Documents/work/gantri/gantri-ai-bot
npx vitest run tests/unit/reports/live/spec.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/reports/live/spec.ts`:

```ts
import { z } from 'zod';

/**
 * Whitelist of tool names a Live Report spec may invoke. Enforced both at
 * compile time (Zod) and at runtime (the runner double-checks before
 * dispatching). Adding a new tool to this set means it has been audited as
 * safe for unattended invocation: read-only, args validated by its own Zod
 * schema, output stable across versions.
 */
export const WHITELISTED_TOOLS = new Set<string>([
  // Northbeam
  'northbeam.metrics_explorer',
  'northbeam.list_metrics',
  'northbeam.list_breakdowns',
  'northbeam.list_attribution_models',
  'northbeam.list_orders',
  // Gantri Porter aggregations + analyses
  'gantri.order_stats',
  'gantri.orders_query',
  'gantri.late_orders_report',
  'gantri.sales_report',
  'gantri.compare_orders_nb_vs_porter',
  'gantri.diff_orders_nb_vs_porter',
  'gantri.attribution_compare_models',
  'gantri.ltv_cac_by_channel',
  'gantri.new_vs_returning_split',
  'gantri.budget_optimization_report',
  // GA4
  'ga4.run_report',
  'ga4.realtime',
  'ga4.list_events',
  'ga4.page_engagement_summary',
  // Grafana
  'grafana.sql',
  'grafana.run_dashboard',
  'grafana.list_dashboards',
]);

const ToolName = z.string().refine((t) => WHITELISTED_TOOLS.has(t), {
  message: 'Tool is not whitelisted for live reports',
});

const DataStep = z.object({
  id: z.string().min(1).max(64).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'id must be a valid identifier'),
  tool: ToolName,
  args: z.record(z.unknown()),
});

const ValueRef = z.string().min(1).max(200);

const KpiBlock = z.object({
  type: z.literal('kpi'),
  label: z.string().min(1).max(80),
  value: ValueRef,
  delta: z.object({
    from: ValueRef,
    format: z.enum(['percent', 'absolute']).default('percent'),
  }).optional(),
  format: z.enum(['currency', 'number', 'percent']).default('number'),
  width: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(1),
});

const ChartBlock = z.object({
  type: z.literal('chart'),
  variant: z.enum(['line', 'area', 'bar', 'donut', 'horizontal_bar']),
  title: z.string().min(1).max(120),
  data: ValueRef,
  x: z.string().min(1).max(64),
  y: z.union([z.string().min(1).max(64), z.array(z.string().min(1).max(64)).min(1).max(8)]),
  yFormat: z.enum(['currency', 'number', 'percent']).default('number'),
  height: z.enum(['sm', 'md', 'lg']).default('md'),
});

const TableColumn = z.object({
  field: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  format: z.enum(['currency', 'number', 'percent', 'date_pt', 'admin_order_link', 'pct_delta']).optional(),
  align: z.enum(['left', 'right', 'center']).default('left'),
});

const TableBlock = z.object({
  type: z.literal('table'),
  title: z.string().min(1).max(120).optional(),
  data: ValueRef,
  columns: z.array(TableColumn).min(1).max(20),
  sortBy: z.object({
    field: z.string().min(1).max(64),
    direction: z.enum(['asc', 'desc']).default('desc'),
  }).optional(),
  pageSize: z.number().int().min(1).max(500).default(25),
});

const TextBlock = z.object({
  type: z.literal('text'),
  markdown: z.string().min(1).max(20_000),
});

const DividerBlock = z.object({
  type: z.literal('divider'),
});

const UiBlock = z.discriminatedUnion('type', [KpiBlock, ChartBlock, TableBlock, TextBlock, DividerBlock]);

export const LiveReportSpec = z.object({
  version: z.literal(1),
  title: z.string().min(1).max(200),
  subtitle: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(4000).optional(),
  data: z.array(DataStep).min(1).max(20),
  ui: z.array(UiBlock).min(1).max(60),
  cacheTtlSec: z.number().int().min(0).max(86_400).default(300),
});

export type LiveReportSpec = z.infer<typeof LiveReportSpec>;
export type DataStep = z.infer<typeof DataStep>;
export type UiBlock = z.infer<typeof UiBlock>;
export type KpiBlock = z.infer<typeof KpiBlock>;
export type ChartBlock = z.infer<typeof ChartBlock>;
export type TableBlock = z.infer<typeof TableBlock>;
export type TextBlock = z.infer<typeof TextBlock>;
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/reports/live/spec.test.ts
```
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src/reports/live/spec.ts tests/unit/reports/live/spec.test.ts
git commit -m "feat(live-reports): spec v1 — Zod schema + tool whitelist"
```

---

### Task 3: ValueRef resolver

**Files:**
- Create: `src/reports/live/value-ref.ts`
- Test: `tests/unit/reports/live/value-ref.test.ts`

- [ ] **Step 1: Failing tests**

Create `tests/unit/reports/live/value-ref.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveValueRef } from '../../../../src/reports/live/value-ref.js';

const fixture = {
  rev: { rows: [{ rev: 1234.5, channel: 'Google' }, { rev: 999, channel: 'Meta' }], totals: { rev: 2233.5 } },
  orders: { count: 87, daily: [{ date: '2026-04-25', count: 12 }, { date: '2026-04-26', count: 14 }] },
};

describe('resolveValueRef', () => {
  it('returns top-level scalar', () => {
    expect(resolveValueRef('orders.count', fixture)).toBe(87);
  });
  it('navigates nested objects', () => {
    expect(resolveValueRef('rev.totals.rev', fixture)).toBe(2233.5);
  });
  it('returns whole arrays', () => {
    expect(resolveValueRef('orders.daily', fixture)).toEqual(fixture.orders.daily);
  });
  it('indexes into arrays with [n]', () => {
    expect(resolveValueRef('rev.rows[0].rev', fixture)).toBe(1234.5);
    expect(resolveValueRef('rev.rows[1].channel', fixture)).toBe('Meta');
  });
  it('returns undefined for missing keys', () => {
    expect(resolveValueRef('nope.x', fixture)).toBeUndefined();
    expect(resolveValueRef('rev.rows[5].rev', fixture)).toBeUndefined();
  });
  it('returns undefined for unparseable refs', () => {
    expect(resolveValueRef('', fixture)).toBeUndefined();
    expect(resolveValueRef('rev..x', fixture)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to fail**

```bash
npx vitest run tests/unit/reports/live/value-ref.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/reports/live/value-ref.ts`:

```ts
/**
 * Resolves a dotted/bracketed path against a data root and returns the value
 * at that path, or `undefined` if any segment is missing.
 *
 *   "rev.rows[0].rev"  → root.rev.rows[0].rev
 *   "orders.daily"     → root.orders.daily   (array)
 *   "rev"              → root.rev            (object)
 *
 * No expressions, no math, no transforms. Pure read.
 */
export function resolveValueRef(ref: string, root: Record<string, unknown>): unknown {
  if (!ref || typeof ref !== 'string') return undefined;
  // Split on `.` but preserve `[n]` as part of the segment so we can pop it off.
  const segments = ref.split('.');
  if (segments.some((s) => s === '')) return undefined;
  let cur: unknown = root;
  for (const raw of segments) {
    // Match `name[idx]` or just `name`.
    const m = raw.match(/^([^[\]]+)((?:\[\d+\])*)$/);
    if (!m) return undefined;
    const key = m[1];
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
    const indexes = m[2].match(/\[(\d+)\]/g) ?? [];
    for (const idxStr of indexes) {
      const idx = Number(idxStr.slice(1, -1));
      if (!Array.isArray(cur)) return undefined;
      cur = cur[idx];
    }
  }
  return cur;
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/reports/live/value-ref.test.ts
```
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src/reports/live/value-ref.ts tests/unit/reports/live/value-ref.test.ts
git commit -m "feat(live-reports): valueRef resolver — dotted+bracketed paths into dataResults"
```

---

### Task 4: Spec runner

**Files:**
- Create: `src/reports/live/runner.ts`
- Test: `tests/unit/reports/live/runner.test.ts`

- [ ] **Step 1: Failing tests**

Create `tests/unit/reports/live/runner.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { runLiveSpec } from '../../../../src/reports/live/runner.js';
import type { LiveReportSpec } from '../../../../src/reports/live/spec.js';

function fakeRegistry(map: Record<string, unknown>) {
  return {
    execute: vi.fn(async (toolName: string, _args: unknown) => {
      if (map[toolName] === undefined) return { ok: false, error: { code: 'NOT_FOUND', message: 'no fixture' } };
      return { ok: true, data: map[toolName] };
    }),
  };
}

describe('runLiveSpec', () => {
  it('parallel-runs each data step and resolves UI blocks', async () => {
    const spec: LiveReportSpec = {
      version: 1,
      title: 'T',
      data: [
        { id: 'a', tool: 'gantri.order_stats', args: {} },
        { id: 'b', tool: 'northbeam.metrics_explorer', args: {} },
      ],
      ui: [
        { type: 'kpi', label: 'Orders', value: 'a.totalOrders', format: 'number', width: 1 },
        { type: 'kpi', label: 'Revenue', value: 'b.rows[0].rev', format: 'currency', width: 1 },
      ],
      cacheTtlSec: 300,
    };
    const reg = fakeRegistry({
      'gantri.order_stats': { totalOrders: 87 },
      'northbeam.metrics_explorer': { rows: [{ rev: 12345.6 }] },
    });
    const out = await runLiveSpec(spec, reg as never);
    expect(out.dataResults.a).toEqual({ totalOrders: 87 });
    expect(out.dataResults.b).toEqual({ rows: [{ rev: 12345.6 }] });
    expect(out.ui).toEqual(spec.ui);
    expect(out.errors).toEqual([]);
  });

  it('records per-step errors and continues', async () => {
    const spec: LiveReportSpec = {
      version: 1, title: 'T',
      data: [
        { id: 'good', tool: 'gantri.order_stats', args: {} },
        { id: 'bad', tool: 'northbeam.list_metrics', args: {} },
      ],
      ui: [{ type: 'text', markdown: 'hi' }],
      cacheTtlSec: 300,
    };
    const reg = fakeRegistry({ 'gantri.order_stats': { x: 1 } });
    const out = await runLiveSpec(spec, reg as never);
    expect(out.dataResults.good).toEqual({ x: 1 });
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatchObject({ stepId: 'bad' });
  });

  it('rejects a spec referencing a non-whitelisted tool at runtime', async () => {
    const spec = { version: 1, title: 'T', data: [{ id: 'x', tool: 'feedback.send', args: {} }], ui: [], cacheTtlSec: 0 } as unknown as LiveReportSpec;
    const reg = fakeRegistry({});
    await expect(runLiveSpec(spec, reg as never)).rejects.toThrow(/not whitelisted/i);
  });
});
```

- [ ] **Step 2: Run to fail**

```bash
npx vitest run tests/unit/reports/live/runner.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/reports/live/runner.ts`:

```ts
import { logger } from '../../logger.js';
import { WHITELISTED_TOOLS, type LiveReportSpec, type UiBlock } from './spec.js';

interface MinimalRegistry {
  execute(toolName: string, args: unknown): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
}

export interface LiveSpecRunResult {
  dataResults: Record<string, unknown>;
  ui: UiBlock[];
  errors: Array<{ stepId: string; tool: string; code: string; message: string }>;
  meta: {
    generatedAt: string;
    durationMs: number;
    sources: string[];
    spec: LiveReportSpec;
  };
}

/**
 * Runs every step in `spec.data` in parallel and returns a unified result with:
 *   - `dataResults`: { [stepId]: tool result data }
 *   - `ui`: passed through unchanged (frontend hydrates via valueRef)
 *   - `errors`: per-step failures (the report degrades gracefully)
 *   - `meta.sources`: distinct tool names used (for the footer)
 *
 * Steps that fail produce a row in `errors[]` but do NOT abort other steps.
 * The frontend renders blocks bound to a failed step as ErrorState.
 */
export async function runLiveSpec(spec: LiveReportSpec, registry: MinimalRegistry): Promise<LiveSpecRunResult> {
  // Defense in depth: re-validate tool whitelist at runtime.
  for (const step of spec.data) {
    if (!WHITELISTED_TOOLS.has(step.tool)) {
      throw new Error(`Tool ${step.tool} is not whitelisted for live reports`);
    }
  }

  const startedAt = Date.now();
  const results = await Promise.all(
    spec.data.map(async (step) => {
      const t0 = Date.now();
      try {
        const r = await registry.execute(step.tool, step.args);
        if (!r.ok) {
          logger.warn({ stepId: step.id, tool: step.tool, code: r.error?.code, ms: Date.now() - t0 }, 'live-report step failed');
          return { stepId: step.id, tool: step.tool, ok: false as const, error: r.error ?? { code: 'UNKNOWN', message: 'no detail' } };
        }
        return { stepId: step.id, tool: step.tool, ok: true as const, data: r.data };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ stepId: step.id, tool: step.tool, err: message, ms: Date.now() - t0 }, 'live-report step threw');
        return { stepId: step.id, tool: step.tool, ok: false as const, error: { code: 'THREW', message } };
      }
    }),
  );

  const dataResults: Record<string, unknown> = {};
  const errors: LiveSpecRunResult['errors'] = [];
  for (const r of results) {
    if (r.ok) dataResults[r.stepId] = r.data;
    else errors.push({ stepId: r.stepId, tool: r.tool, code: r.error.code, message: r.error.message });
  }

  const sources = [...new Set(spec.data.map((s) => s.tool))].sort();
  return {
    dataResults,
    ui: spec.ui,
    errors,
    meta: {
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      sources,
      spec,
    },
  };
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/reports/live/runner.test.ts
```
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/reports/live/runner.ts tests/unit/reports/live/runner.test.ts
git commit -m "feat(live-reports): runner — parallel tool dispatch with graceful per-step errors"
```

---

### Task 5: PublishedReportsRepo

**Files:**
- Create: `src/storage/repositories/published-reports.ts`
- Test: `tests/unit/storage/published-reports.test.ts`

- [ ] **Step 1: Failing tests (in-memory repo via mocked Supabase client)**

Create `tests/unit/storage/published-reports.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublishedReportsRepo } from '../../../src/storage/repositories/published-reports.js';

function fakeSupabase() {
  const tables: Record<string, any[]> = { published_reports: [], published_reports_history: [] };
  const builder = (table: string) => {
    let pending: any = { table, op: 'select', filters: [], data: null, single: false, returning: null };
    const chain = {
      select: vi.fn((cols?: string) => { pending.op = 'select'; pending.cols = cols ?? '*'; return chain; }),
      insert: vi.fn((row: any) => { pending.op = 'insert'; pending.data = row; return chain; }),
      update: vi.fn((row: any) => { pending.op = 'update'; pending.data = row; return chain; }),
      eq: vi.fn((col: string, v: any) => { pending.filters.push({ col, v }); return chain; }),
      neq: vi.fn(() => chain),
      is: vi.fn((col: string, v: any) => { pending.filters.push({ col, v: v === null ? null : v }); return chain; }),
      order: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      single: vi.fn(() => { pending.single = true; return Promise.resolve(execute(pending, tables)); }),
      maybeSingle: vi.fn(() => { pending.single = true; pending.maybeSingle = true; return Promise.resolve(execute(pending, tables)); }),
      then: (cb: any) => Promise.resolve(execute(pending, tables)).then(cb),
    };
    return chain;
  };
  return { from: builder, _tables: tables };
}

function execute(pending: any, tables: Record<string, any[]>) {
  const t = tables[pending.table];
  if (pending.op === 'insert') {
    const inserted = { ...pending.data, id: pending.data.id ?? `id_${t.length + 1}`, created_at: new Date().toISOString() };
    t.push(inserted);
    return { data: inserted, error: null };
  }
  if (pending.op === 'select') {
    let rows = [...t];
    for (const f of pending.filters) {
      rows = rows.filter((r) => r[f.col] === f.v);
    }
    if (pending.single) return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }
  if (pending.op === 'update') {
    let rows = [...t];
    for (const f of pending.filters) rows = rows.filter((r) => r[f.col] === f.v);
    rows.forEach((r) => Object.assign(r, pending.data));
    return { data: rows[0] ?? null, error: null };
  }
  return { data: null, error: null };
}

describe('PublishedReportsRepo', () => {
  let supabase: ReturnType<typeof fakeSupabase>;
  let repo: PublishedReportsRepo;
  beforeEach(() => {
    supabase = fakeSupabase();
    repo = new PublishedReportsRepo(supabase as never);
  });

  it('creates a report and reads it back by slug', async () => {
    const created = await repo.create({
      slug: 'weekly-sales',
      title: 'Weekly Sales',
      ownerSlackId: 'UDANNY',
      intent: 'show me weekly sales',
      intentKeywords: ['weekly', 'sales'],
      spec: { version: 1, title: 'Weekly Sales', data: [], ui: [] } as never,
      accessToken: 'tok123',
    });
    expect(created.slug).toBe('weekly-sales');
    const fetched = await repo.getBySlug('weekly-sales');
    expect(fetched?.title).toBe('Weekly Sales');
  });

  it('records visit increments count + sets last_visited_at', async () => {
    await repo.create({ slug: 's', title: 't', ownerSlackId: 'U', intent: 'x', intentKeywords: [], spec: {} as never, accessToken: 'a' });
    await repo.recordVisit('s');
    const r = await repo.getBySlug('s');
    expect(r?.visitCount).toBe(1);
  });

  it('archive sets archived_at and getBySlug returns null', async () => {
    await repo.create({ slug: 's', title: 't', ownerSlackId: 'U', intent: 'x', intentKeywords: [], spec: {} as never, accessToken: 'a' });
    await repo.archive('s', 'UDANNY');
    expect(await repo.getBySlug('s')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to fail**

```bash
npx vitest run tests/unit/storage/published-reports.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/storage/repositories/published-reports.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { LiveReportSpec } from '../../reports/live/spec.js';

export interface PublishedReport {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  spec: LiveReportSpec;
  specVersion: number;
  ownerSlackId: string;
  intent: string;
  intentKeywords: string[];
  accessToken: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  lastVisitedAt: string | null;
  visitCount: number;
}

interface CreateInput {
  slug: string;
  title: string;
  description?: string | null;
  ownerSlackId: string;
  intent: string;
  intentKeywords: string[];
  spec: LiveReportSpec;
  accessToken: string;
}

function rowToReport(r: any): PublishedReport {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    description: r.description ?? null,
    spec: r.spec,
    specVersion: r.spec_version ?? 1,
    ownerSlackId: r.owner_slack_id,
    intent: r.intent,
    intentKeywords: r.intent_keywords ?? [],
    accessToken: r.access_token,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? r.created_at,
    archivedAt: r.archived_at ?? null,
    lastVisitedAt: r.last_visited_at ?? null,
    visitCount: r.visit_count ?? 0,
  };
}

export class PublishedReportsRepo {
  constructor(private readonly client: SupabaseClient) {}

  async create(input: CreateInput): Promise<PublishedReport> {
    const { data, error } = await this.client
      .from('published_reports')
      .insert({
        slug: input.slug,
        title: input.title,
        description: input.description ?? null,
        spec: input.spec,
        spec_version: input.spec.version,
        owner_slack_id: input.ownerSlackId,
        intent: input.intent,
        intent_keywords: input.intentKeywords,
        access_token: input.accessToken,
      })
      .select('*')
      .single();
    if (error) throw new Error(`published_reports insert failed: ${error.message}`);
    return rowToReport(data);
  }

  async getBySlug(slug: string): Promise<PublishedReport | null> {
    const { data, error } = await this.client
      .from('published_reports')
      .select('*')
      .eq('slug', slug)
      .is('archived_at', null)
      .maybeSingle();
    if (error) throw new Error(`published_reports read failed: ${error.message}`);
    return data ? rowToReport(data) : null;
  }

  async listByOwner(ownerSlackId: string): Promise<PublishedReport[]> {
    const { data, error } = await this.client
      .from('published_reports')
      .select('*')
      .eq('owner_slack_id', ownerSlackId)
      .is('archived_at', null)
      .order('created_at', { ascending: false });
    if (error) throw new Error(`published_reports list failed: ${error.message}`);
    return (data ?? []).map(rowToReport);
  }

  async listAll(): Promise<PublishedReport[]> {
    const { data, error } = await this.client
      .from('published_reports')
      .select('*')
      .is('archived_at', null)
      .order('created_at', { ascending: false });
    if (error) throw new Error(`published_reports listAll failed: ${error.message}`);
    return (data ?? []).map(rowToReport);
  }

  async searchByKeywords(keywords: string[]): Promise<PublishedReport[]> {
    if (keywords.length === 0) return [];
    const { data, error } = await this.client
      .from('published_reports')
      .select('*')
      .is('archived_at', null)
      .overlaps('intent_keywords', keywords);
    if (error) throw new Error(`published_reports keyword search failed: ${error.message}`);
    return (data ?? []).map(rowToReport);
  }

  async recordVisit(slug: string): Promise<void> {
    const existing = await this.getBySlug(slug);
    if (!existing) return;
    await this.client
      .from('published_reports')
      .update({ visit_count: existing.visitCount + 1, last_visited_at: new Date().toISOString() })
      .eq('slug', slug);
  }

  async archive(slug: string, _byUser: string): Promise<void> {
    await this.client
      .from('published_reports')
      .update({ archived_at: new Date().toISOString() })
      .eq('slug', slug);
  }

  async replaceSpec(input: { slug: string; spec: LiveReportSpec; intent: string; intentKeywords: string[]; replacedBy: string; newAccessToken?: string }): Promise<PublishedReport> {
    const existing = await this.getBySlug(input.slug);
    if (!existing) throw new Error(`No active report with slug ${input.slug}`);
    // Snapshot current spec into history.
    await this.client.from('published_reports_history').insert({
      report_id: existing.id,
      spec: existing.spec,
      spec_version: existing.specVersion,
      intent: existing.intent,
      replaced_by_slack_id: input.replacedBy,
    });
    const update: Record<string, unknown> = {
      spec: input.spec,
      spec_version: input.spec.version,
      intent: input.intent,
      intent_keywords: input.intentKeywords,
      title: input.spec.title,
      description: input.spec.description ?? null,
      updated_at: new Date().toISOString(),
    };
    if (input.newAccessToken) update.access_token = input.newAccessToken;
    const { data, error } = await this.client
      .from('published_reports')
      .update(update)
      .eq('slug', input.slug)
      .select('*')
      .single();
    if (error) throw new Error(`published_reports replaceSpec failed: ${error.message}`);
    return rowToReport(data);
  }

  async listHistory(slug: string, limit = 5): Promise<Array<{ spec: LiveReportSpec; intent: string; replacedAt: string; replacedBy: string }>> {
    const existing = await this.getBySlug(slug);
    if (!existing) return [];
    const { data, error } = await this.client
      .from('published_reports_history')
      .select('spec, intent, replaced_at, replaced_by_slack_id')
      .eq('report_id', existing.id)
      .order('replaced_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`published_reports_history read failed: ${error.message}`);
    return (data ?? []).map((r: any) => ({ spec: r.spec, intent: r.intent, replacedAt: r.replaced_at, replacedBy: r.replaced_by_slack_id }));
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/storage/published-reports.test.ts
```
Expected: 3 passed (the test mock is intentionally simplified — full coverage of search/replaceSpec lands in integration tests later).

- [ ] **Step 5: Commit**

```bash
git add src/storage/repositories/published-reports.ts tests/unit/storage/published-reports.test.ts
git commit -m "feat(live-reports): PublishedReportsRepo — CRUD + history + visit tracking"
```

---

### Task 6: Identifiers (slug + token + dedup keywords)

**Files:**
- Create: `src/reports/live/identifiers.ts`
- Create: `src/reports/live/dedup.ts`
- Test: `tests/unit/reports/live/identifiers.test.ts`
- Test: `tests/unit/reports/live/dedup.test.ts`

- [ ] **Step 1: Identifiers tests**

Create `tests/unit/reports/live/identifiers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { slugifyTitle, generateAccessToken, findFreeSlug } from '../../../../src/reports/live/identifiers.js';

describe('slugifyTitle', () => {
  it('lowercases + hyphenates ASCII', () => {
    expect(slugifyTitle('Weekly Sales Report')).toBe('weekly-sales-report');
  });
  it('strips diacritics', () => {
    expect(slugifyTitle('ROAS por canál')).toBe('roas-por-canal');
  });
  it('drops punctuation', () => {
    expect(slugifyTitle("Today's Top 10 — A Snapshot!")).toBe('todays-top-10-a-snapshot');
  });
  it('caps at 60 chars', () => {
    const long = 'a'.repeat(80);
    expect(slugifyTitle(long).length).toBeLessThanOrEqual(60);
  });
  it('falls back when input is non-ASCII-only', () => {
    expect(slugifyTitle('!!!')).toMatch(/^report-/);
  });
});

describe('generateAccessToken', () => {
  it('returns 32 url-safe chars', () => {
    const t = generateAccessToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});

describe('findFreeSlug', () => {
  it('returns the base slug if not taken', async () => {
    const out = await findFreeSlug('weekly-sales', async () => false);
    expect(out).toBe('weekly-sales');
  });
  it('appends -2 if base is taken', async () => {
    const taken = new Set(['weekly-sales']);
    const out = await findFreeSlug('weekly-sales', async (s) => taken.has(s));
    expect(out).toBe('weekly-sales-2');
  });
  it('keeps incrementing past collisions', async () => {
    const taken = new Set(['s', 's-2', 's-3']);
    const out = await findFreeSlug('s', async (slug) => taken.has(slug));
    expect(out).toBe('s-4');
  });
});
```

- [ ] **Step 2: Run to fail**

```bash
npx vitest run tests/unit/reports/live/identifiers.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement identifiers**

Create `src/reports/live/identifiers.ts`:

```ts
import { customAlphabet } from 'nanoid';

const tokenAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const generateToken = customAlphabet(tokenAlphabet, 32);

export function generateAccessToken(): string {
  return generateToken();
}

/**
 * Title → URL-safe slug. ASCII-only, lowercase, hyphen-separated.
 * Strips diacritics, punctuation, collapses runs of `-`. Caps at 60 chars.
 * Falls back to a random short id when input has no slug-able chars.
 */
export function slugifyTitle(title: string): string {
  if (!title) return `report-${generateToken().slice(0, 8).toLowerCase()}`;
  const normalized = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  if (!normalized) return `report-${generateToken().slice(0, 8).toLowerCase()}`;
  return normalized;
}

/**
 * Returns a slug that doesn't collide. Calls `isTaken(slug)` for the base
 * first, then `slug-2`, `slug-3`, ... up to 50 tries.
 */
export async function findFreeSlug(base: string, isTaken: (slug: string) => Promise<boolean>): Promise<string> {
  if (!await isTaken(base)) return base;
  for (let n = 2; n <= 50; n++) {
    const candidate = `${base}-${n}`;
    if (!await isTaken(candidate)) return candidate;
  }
  // Last resort
  return `${base}-${generateToken().slice(0, 6).toLowerCase()}`;
}
```

- [ ] **Step 4: Run identifiers tests**

```bash
npx vitest run tests/unit/reports/live/identifiers.test.ts
```
Expected: 9 passed.

- [ ] **Step 5: Dedup tests**

Create `tests/unit/reports/live/dedup.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { extractKeywords, scoreSimilarity } from '../../../../src/reports/live/dedup.js';

describe('extractKeywords', () => {
  it('lowercases, dedupes, strips stopwords', () => {
    expect(extractKeywords('Weekly Sales Report by Channel for the team')).toEqual(
      expect.arrayContaining(['weekly', 'sales', 'report', 'channel', 'team']),
    );
  });
  it('preserves multi-language tokens', () => {
    const k = extractKeywords('Reporte de ventas por canal');
    expect(k).toEqual(expect.arrayContaining(['reporte', 'ventas', 'canal']));
  });
  it('drops short tokens (<3 chars)', () => {
    expect(extractKeywords('a b cc dd ee')).not.toContain('a');
    expect(extractKeywords('a b cc dd ee')).toContain('cc');
  });
});

describe('scoreSimilarity', () => {
  it('returns the count of shared keywords', () => {
    expect(scoreSimilarity(['a', 'b', 'c'], ['b', 'c', 'd'])).toBe(2);
  });
  it('handles empty arrays', () => {
    expect(scoreSimilarity([], ['a'])).toBe(0);
    expect(scoreSimilarity(['a'], [])).toBe(0);
  });
});
```

- [ ] **Step 6: Implement dedup**

Create `src/reports/live/dedup.ts`:

```ts
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'with', 'of', 'in', 'on', 'at', 'to', 'is', 'are',
  'was', 'were', 'by', 'from', 'this', 'that', 'these', 'those', 'me', 'my', 'we', 'our', 'team',
  // Spanish stopwords (the bot is bilingual)
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'y', 'o', 'pero', 'para',
  'con', 'en', 'es', 'son', 'por', 'que', 'me', 'mi', 'nos', 'nuestro', 'nuestra',
]);

export function extractKeywords(text: string): string[] {
  if (!text) return [];
  const tokens = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return [...new Set(tokens)];
}

export function scoreSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  let n = 0;
  for (const k of b) if (setA.has(k)) n++;
  return n;
}

export interface SimilarityCandidate {
  slug: string;
  title: string;
  ownerSlackId: string;
  score: number;
}

/**
 * Picks reports whose intent_keywords overlap the query keywords by ≥3.
 * Returns sorted desc by score, capped at `limit`.
 */
export function rankCandidates(
  queryKeywords: string[],
  candidates: Array<{ slug: string; title: string; ownerSlackId: string; intentKeywords: string[] }>,
  minScore = 3,
  limit = 5,
): SimilarityCandidate[] {
  return candidates
    .map((c) => ({ slug: c.slug, title: c.title, ownerSlackId: c.ownerSlackId, score: scoreSimilarity(queryKeywords, c.intentKeywords) }))
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
```

- [ ] **Step 7: Run dedup tests**

```bash
npx vitest run tests/unit/reports/live/dedup.test.ts
```
Expected: 5 passed.

- [ ] **Step 8: Commit**

```bash
git add src/reports/live/identifiers.ts src/reports/live/dedup.ts tests/unit/reports/live/
git commit -m "feat(live-reports): identifiers (slug + token) + dedup (keyword extract + scoring)"
```

---

## Phase 2 — Backend tools (5 tasks)

### Task 7: Spec compiler (LLM call + Zod retry)

**Files:**
- Create: `src/connectors/live-reports/compiler.ts`
- Test: `tests/unit/connectors/live-reports/compiler.test.ts`

- [ ] **Step 1: Test (mocked Claude)**

Create `tests/unit/connectors/live-reports/compiler.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { compileLiveReport } from '../../../../src/connectors/live-reports/compiler.js';

function mockClaude(responses: string[]) {
  let i = 0;
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text: responses[i++] ?? responses[responses.length - 1] }],
        usage: { input_tokens: 100, output_tokens: 200 },
      })),
    },
  };
}

const validSpec = JSON.stringify({
  version: 1,
  title: 'Sample Report',
  data: [{ id: 'a', tool: 'gantri.order_stats', args: {} }],
  ui: [{ type: 'kpi', label: 'Orders', value: 'a.totalOrders', format: 'number' }],
});

describe('compileLiveReport', () => {
  it('returns a parsed spec on first valid response', async () => {
    const claude = mockClaude([validSpec]);
    const out = await compileLiveReport({ intent: 'show order count', claude: claude as never, model: 'claude-sonnet-4-6', toolCatalog: 'fake catalog' });
    expect(out.spec.title).toBe('Sample Report');
    expect(claude.messages.create).toHaveBeenCalledTimes(1);
  });

  it('retries once when first response is invalid JSON, then succeeds', async () => {
    const claude = mockClaude(['not json {', validSpec]);
    const out = await compileLiveReport({ intent: 'x', claude: claude as never, model: 'claude-sonnet-4-6', toolCatalog: 'cat' });
    expect(out.spec.title).toBe('Sample Report');
    expect(claude.messages.create).toHaveBeenCalledTimes(2);
  });

  it('fails after 2 invalid attempts', async () => {
    const claude = mockClaude(['junk', 'still junk']);
    await expect(
      compileLiveReport({ intent: 'x', claude: claude as never, model: 'claude-sonnet-4-6', toolCatalog: 'cat' }),
    ).rejects.toThrow(/compile.*failed/i);
  });
});
```

- [ ] **Step 2: Run to fail**

```bash
npx vitest run tests/unit/connectors/live-reports/compiler.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/connectors/live-reports/compiler.ts`:

```ts
import type Anthropic from '@anthropic-ai/sdk';
import { logger } from '../../logger.js';
import { LiveReportSpec, type LiveReportSpec as Spec } from '../../reports/live/spec.js';

const SYSTEM_PROMPT = `You are the Live Reports compiler. The user asks for a "live report" in natural language; you emit a STRICT JSON spec that the deterministic runtime will execute on every visit.

Output: a single JSON object matching this TypeScript type (validated by Zod):

  type LiveReportSpec = {
    version: 1;
    title: string;          // ALWAYS in English, ≤80 chars
    subtitle?: string;
    description?: string;   // 1-3 sentences explaining what the report shows
    data: DataStep[];       // 1..20 entries; each runs a whitelisted tool with args
    ui: UiBlock[];          // 1..60 entries; rendered top-to-bottom
    cacheTtlSec?: number;   // default 300
  }
  type DataStep = { id: string; tool: WhitelistedTool; args: object };
  type UiBlock =
    | { type: 'kpi'; label: string; value: string; delta?: { from: string; format?: 'percent' | 'absolute' }; format?: 'currency' | 'number' | 'percent'; width?: 1 | 2 | 3 | 4 }
    | { type: 'chart'; variant: 'line' | 'area' | 'bar' | 'donut' | 'horizontal_bar'; title: string; data: string; x: string; y: string | string[]; yFormat?: 'currency' | 'number' | 'percent'; height?: 'sm' | 'md' | 'lg' }
    | { type: 'table'; title?: string; data: string; columns: { field: string; label: string; format?: 'currency' | 'number' | 'percent' | 'date_pt' | 'admin_order_link' | 'pct_delta'; align?: 'left' | 'right' | 'center' }[]; sortBy?: { field: string; direction?: 'asc' | 'desc' }; pageSize?: number }
    | { type: 'text'; markdown: string }
    | { type: 'divider' };

Rules:
- Output ONLY the JSON object. No prose, no code fences.
- Title MUST be in English, even if the user wrote in Spanish.
- 'data' steps: one DataStep per tool call. The 'id' is referenced by ui blocks via "id.path.to.field" (e.g. "rev.rows[0].rev"). Use parallel-safe ids (no dependency between steps).
- Build a logical layout: 1 row of KPI cards (4 max), then a chart, then a table. Add a divider between sections if useful.
- Prefer specialized tools when they exist: gantri.late_orders_report over composing orders_query, ga4.page_engagement_summary over manual run_report+filter.

Available tools and their args:
{TOOL_CATALOG}

Return the JSON object now.`;

export interface CompileLiveReportInput {
  intent: string;
  claude: Anthropic;
  model: string;
  toolCatalog: string;
  maxAttempts?: number;
}

export interface CompileLiveReportResult {
  spec: Spec;
  inputTokens: number;
  outputTokens: number;
  attempts: number;
}

export async function compileLiveReport(input: CompileLiveReportInput): Promise<CompileLiveReportResult> {
  const maxAttempts = input.maxAttempts ?? 2;
  let lastError: string | null = null;
  let totalIn = 0;
  let totalOut = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const userMsg = lastError
      ? `${input.intent}\n\n--\nPREVIOUS ATTEMPT FAILED VALIDATION: ${lastError}\nReturn a corrected JSON spec.`
      : input.intent;
    const resp = await input.claude.messages.create({
      model: input.model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT.replace('{TOOL_CATALOG}', input.toolCatalog),
      messages: [{ role: 'user', content: userMsg }],
    });
    totalIn += resp.usage?.input_tokens ?? 0;
    totalOut += resp.usage?.output_tokens ?? 0;
    const text = resp.content.find((b) => b.type === 'text')?.text ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.trim());
    } catch (err) {
      lastError = `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.warn({ attempt, lastError }, 'compileLiveReport — invalid JSON');
      continue;
    }
    const validation = LiveReportSpec.safeParse(parsed);
    if (validation.success) {
      return { spec: validation.data, inputTokens: totalIn, outputTokens: totalOut, attempts: attempt };
    }
    lastError = validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 6).join('; ');
    logger.warn({ attempt, lastError }, 'compileLiveReport — schema validation failed');
  }
  throw new Error(`compile failed after ${maxAttempts} attempts: ${lastError ?? 'unknown error'}`);
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/connectors/live-reports/compiler.test.ts
```
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/live-reports/compiler.ts tests/unit/connectors/live-reports/compiler.test.ts
git commit -m "feat(live-reports): compiler — Claude → JSON spec with Zod retry-on-invalid"
```

---

### Task 8: LiveReportsConnector with `find_similar_reports`

**Files:**
- Create: `src/connectors/live-reports/connector.ts`
- Test: `tests/unit/connectors/live-reports/connector-find.test.ts`

- [ ] **Step 1: Test**

Create `tests/unit/connectors/live-reports/connector-find.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { LiveReportsConnector } from '../../../../src/connectors/live-reports/connector.js';
import type { PublishedReport } from '../../../../src/storage/repositories/published-reports.js';

function makeRepo(reports: Partial<PublishedReport>[]) {
  return {
    listAll: vi.fn(async () => reports as PublishedReport[]),
    getBySlug: vi.fn(),
    create: vi.fn(),
    archive: vi.fn(),
    listByOwner: vi.fn(),
    replaceSpec: vi.fn(),
    listHistory: vi.fn(),
    recordVisit: vi.fn(),
    searchByKeywords: vi.fn(),
  };
}

function makeConnector(opts: { repo: any; getActor?: () => { slackUserId: string }; isAdmin?: () => Promise<boolean> }) {
  return new LiveReportsConnector({
    repo: opts.repo,
    claude: { messages: { create: vi.fn() } } as never,
    model: 'claude-sonnet-4-6',
    registry: { execute: vi.fn() } as never,
    getToolCatalog: () => 'fake catalog',
    publicBaseUrl: 'https://gantri-ai-bot.fly.dev',
    getActor: opts.getActor ?? (() => ({ slackUserId: 'UDANNY' })),
    getRoleForActor: opts.isAdmin ?? (async () => 'user'),
  });
}

describe('LiveReportsConnector.reports.find_similar_reports', () => {
  it('returns existing reports with ≥3 keyword overlap, sorted by score desc, with owner', async () => {
    const repo = makeRepo([
      { slug: 'weekly-sales', title: 'Weekly Sales', ownerSlackId: 'UDANNY', intentKeywords: ['weekly', 'sales', 'revenue', 'channel'] },
      { slug: 'monthly-sales', title: 'Monthly Sales', ownerSlackId: 'UIAN', intentKeywords: ['monthly', 'sales', 'revenue'] },
      { slug: 'unrelated', title: 'Unrelated', ownerSlackId: 'UIAN', intentKeywords: ['orders', 'inventory'] },
    ]);
    const conn = makeConnector({ repo });
    const tool = conn.tools.find((t) => t.name === 'reports.find_similar_reports')!;
    const out = await tool.execute({ intent: 'I want a weekly sales report by channel for revenue' }) as { matches: any[] };
    expect(out.matches.length).toBeGreaterThan(0);
    expect(out.matches[0].slug).toBe('weekly-sales');
    expect(out.matches[0].owner_slack_id).toBe('UDANNY');
    expect(out.matches[0].score).toBeGreaterThanOrEqual(3);
  });

  it('returns empty matches when nothing overlaps', async () => {
    const repo = makeRepo([
      { slug: 's1', title: 'X', ownerSlackId: 'UA', intentKeywords: ['orders', 'inventory'] },
    ]);
    const conn = makeConnector({ repo });
    const tool = conn.tools.find((t) => t.name === 'reports.find_similar_reports')!;
    const out = await tool.execute({ intent: 'channel revenue marketing attribution' }) as { matches: any[] };
    expect(out.matches).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to fail**

```bash
npx vitest run tests/unit/connectors/live-reports/connector-find.test.ts
```
Expected: FAIL — connector module not found.

- [ ] **Step 3: Implement skeleton + `reports.find_similar_reports`**

Create `src/connectors/live-reports/connector.ts`:

```ts
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { Connector, ToolDef } from '../base/connector.js';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import type { PublishedReportsRepo } from '../../storage/repositories/published-reports.js';
import type { ConnectorRegistry } from '../base/registry.js';
import type { ActorContext } from '../../orchestrator/orchestrator.js';
import { extractKeywords, rankCandidates } from '../../reports/live/dedup.js';
import { compileLiveReport } from './compiler.js';
import { runLiveSpec } from '../../reports/live/runner.js';
import { slugifyTitle, generateAccessToken, findFreeSlug } from '../../reports/live/identifiers.js';
import { logger } from '../../logger.js';

export interface LiveReportsConnectorDeps {
  repo: PublishedReportsRepo;
  claude: Anthropic;
  model: string;
  registry: Pick<ConnectorRegistry, 'execute'>;
  getToolCatalog: () => string;       // assembled tool descriptions for the compiler prompt
  publicBaseUrl: string;              // e.g. https://gantri-ai-bot.fly.dev
  getActor: () => ActorContext | undefined;
  getRoleForActor: (slackUserId: string) => Promise<string | null>;
}

const FindArgs = z.object({
  intent: z.string().min(3).max(2000).describe('Natural-language description of the report the user wants. Used to extract keywords and search existing reports.'),
});
type FindArgs = z.infer<typeof FindArgs>;

const PublishArgs = z.object({
  intent: z.string().min(3).max(2000),
  forceCreate: z.boolean().default(false).describe('Skip the dedup gate. Set true ONLY if the user explicitly says they want a new report after seeing the dedup recommendation.'),
});
type PublishArgs = z.infer<typeof PublishArgs>;

const ListMineArgs = z.object({}).strict();
type ListMineArgs = z.infer<typeof ListMineArgs>;

const RecompileArgs = z.object({
  slug: z.string().min(1).max(80),
  newIntent: z.string().min(3).max(2000),
  regenerateToken: z.boolean().default(false),
});
type RecompileArgs = z.infer<typeof RecompileArgs>;

const ArchiveArgs = z.object({
  slug: z.string().min(1).max(80),
});
type ArchiveArgs = z.infer<typeof ArchiveArgs>;

export class LiveReportsConnector implements Connector {
  readonly name = 'live-reports';
  readonly tools: readonly ToolDef[];

  constructor(private readonly deps: LiveReportsConnectorDeps) {
    this.tools = [
      this.findTool(),
      this.publishTool(),
      this.listMineTool(),
      this.recompileTool(),
      this.archiveTool(),
    ];
  }

  async healthCheck() { return { ok: true }; }

  private findTool(): ToolDef<FindArgs> {
    return {
      name: 'reports.find_similar_reports',
      description: [
        'Search existing live reports for ones that already answer the user\'s intent. Returns matches sorted by keyword overlap (≥3 shared keywords).',
        'ALWAYS call this BEFORE `reports.publish_live_report`. If matches are found, recommend them to the user before creating a new one.',
        'Searches across ALL non-archived reports (cross-org). Each match includes owner so the bot can say "owned by @user".',
      ].join(' '),
      schema: FindArgs as z.ZodType<FindArgs>,
      jsonSchema: zodToJsonSchema(FindArgs),
      execute: (args) => this.find(args),
    };
  }

  private publishTool(): ToolDef<PublishArgs> {
    return {
      name: 'reports.publish_live_report',
      description: [
        'Create a Live Report at a shareable URL. Use ONLY when the user explicitly asks for a "live report", "reporte en vivo", "live dashboard", "shareable URL".',
        'BEFORE calling this tool, call `reports.find_similar_reports` first. If matches are returned with score≥3, recommend them to the user. Only call this tool with `forceCreate: true` when the user has explicitly confirmed they want a new one anyway.',
        'Pipeline: dedup → LLM compiles JSON spec → Zod validates → smoke-execute the spec end-to-end → persist with slug + token. Returns the URL.',
      ].join(' '),
      schema: PublishArgs as z.ZodType<PublishArgs>,
      jsonSchema: zodToJsonSchema(PublishArgs),
      execute: (args) => this.publish(args),
    };
  }

  private listMineTool(): ToolDef<ListMineArgs> {
    return {
      name: 'reports.list_my_reports',
      description: 'List Live Reports owned by the current user.',
      schema: ListMineArgs as z.ZodType<ListMineArgs>,
      jsonSchema: zodToJsonSchema(ListMineArgs),
      execute: () => this.listMine(),
    };
  }

  private recompileTool(): ToolDef<RecompileArgs> {
    return {
      name: 'reports.recompile_report',
      description: [
        'Replace the spec of an existing Live Report. Author or admin only.',
        'The slug + URL stay stable (bookmarks survive). Old spec is preserved in history (last 5 versions).',
        '`regenerateToken: true` rotates the access token (invalidates old links).',
      ].join(' '),
      schema: RecompileArgs as z.ZodType<RecompileArgs>,
      jsonSchema: zodToJsonSchema(RecompileArgs),
      execute: (args) => this.recompile(args),
    };
  }

  private archiveTool(): ToolDef<ArchiveArgs> {
    return {
      name: 'reports.archive_report',
      description: 'Soft-delete a Live Report. Author or admin only.',
      schema: ArchiveArgs as z.ZodType<ArchiveArgs>,
      jsonSchema: zodToJsonSchema(ArchiveArgs),
      execute: (args) => this.archive(args),
    };
  }

  // ---- find ----
  private async find(args: FindArgs) {
    const keywords = extractKeywords(args.intent);
    const all = await this.deps.repo.listAll();
    const matches = rankCandidates(
      keywords,
      all.map((r) => ({ slug: r.slug, title: r.title, ownerSlackId: r.ownerSlackId, intentKeywords: r.intentKeywords })),
    );
    return {
      keywords,
      matches: matches.map((m) => ({
        slug: m.slug,
        title: m.title,
        owner_slack_id: m.ownerSlackId,
        score: m.score,
        url: `${this.deps.publicBaseUrl}/r/${m.slug}`,
      })),
    };
  }

  // ---- publish ----  (full impl in next task; stub for now to satisfy registry)
  private async publish(_args: PublishArgs): Promise<unknown> {
    throw new Error('publish: implemented in Task 9');
  }
  private async listMine(): Promise<unknown> { throw new Error('listMine: Task 10'); }
  private async recompile(_a: RecompileArgs): Promise<unknown> { throw new Error('recompile: Task 11'); }
  private async archive(_a: ArchiveArgs): Promise<unknown> { throw new Error('archive: Task 11'); }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/connectors/live-reports/connector-find.test.ts
```
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/live-reports/connector.ts tests/unit/connectors/live-reports/connector-find.test.ts
git commit -m "feat(live-reports): connector skeleton + reports.find_similar_reports"
```

---

### Task 9: `reports.publish_live_report` full pipeline

**Files:**
- Modify: `src/connectors/live-reports/connector.ts` (replace `publish` stub)
- Test: `tests/unit/connectors/live-reports/connector-publish.test.ts`

- [ ] **Step 1: Test**

Create `tests/unit/connectors/live-reports/connector-publish.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { LiveReportsConnector } from '../../../../src/connectors/live-reports/connector.js';

const validSpec = {
  version: 1,
  title: 'Weekly Sales',
  data: [{ id: 'a', tool: 'gantri.order_stats', args: {} }],
  ui: [{ type: 'kpi', label: 'Orders', value: 'a.totalOrders', format: 'number' }],
};

function fakeClaude(text: string) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text }],
        usage: { input_tokens: 10, output_tokens: 20 },
      })),
    },
  };
}
function fakeRegistry(map: Record<string, unknown>) {
  return { execute: vi.fn(async (n: string) => (map[n] ? { ok: true, data: map[n] } : { ok: false, error: { code: 'X', message: 'no' } })) };
}
function fakeRepo() {
  const reports: any[] = [];
  return {
    listAll: vi.fn(async () => reports),
    getBySlug: vi.fn(async (slug: string) => reports.find((r) => r.slug === slug && !r.archivedAt) ?? null),
    create: vi.fn(async (input: any) => { const row = { id: 'r1', archivedAt: null, ...input, accessToken: input.accessToken, intentKeywords: input.intentKeywords }; reports.push(row); return row; }),
    archive: vi.fn(),
    listByOwner: vi.fn(async () => reports),
    replaceSpec: vi.fn(),
    listHistory: vi.fn(),
    recordVisit: vi.fn(),
    searchByKeywords: vi.fn(),
  };
}

function makeConnector(opts: { intentJson: string; runOk?: boolean; isAdmin?: boolean; existing?: any[] }) {
  const repo = fakeRepo();
  if (opts.existing) (repo.listAll as any).mockResolvedValue(opts.existing);
  const claude = fakeClaude(opts.intentJson);
  const registry = fakeRegistry(opts.runOk === false ? {} : { 'gantri.order_stats': { totalOrders: 87 } });
  return {
    repo,
    conn: new LiveReportsConnector({
      repo: repo as never,
      claude: claude as never,
      model: 'claude-sonnet-4-6',
      registry: registry as never,
      getToolCatalog: () => 'cat',
      publicBaseUrl: 'https://gantri-ai-bot.fly.dev',
      getActor: () => ({ slackUserId: 'UDANNY' }),
      getRoleForActor: async () => (opts.isAdmin ? 'admin' : 'user'),
    }),
  };
}

describe('reports.publish_live_report', () => {
  it('rejects without forceCreate when a high-overlap existing report exists', async () => {
    const { conn } = makeConnector({
      intentJson: JSON.stringify(validSpec),
      existing: [{ slug: 'weekly-sales', title: 'Weekly Sales', ownerSlackId: 'UA', intentKeywords: ['weekly', 'sales', 'revenue'] }],
    });
    const tool = conn.tools.find((t) => t.name === 'reports.publish_live_report')!;
    const out = await tool.execute({ intent: 'weekly sales revenue', forceCreate: false }) as any;
    expect(out.status).toBe('existing_match');
    expect(out.matches.length).toBeGreaterThan(0);
  });

  it('compiles + smoke-runs + persists with slug derived from title', async () => {
    const { conn, repo } = makeConnector({ intentJson: JSON.stringify(validSpec) });
    const tool = conn.tools.find((t) => t.name === 'reports.publish_live_report')!;
    const out = await tool.execute({ intent: 'weekly sales by channel', forceCreate: false }) as any;
    expect(out.status).toBe('created');
    expect(out.slug).toBe('weekly-sales');
    expect(out.url).toMatch(/\/r\/weekly-sales\?t=/);
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('aborts if smoke-execute errors on every step', async () => {
    const { conn } = makeConnector({ intentJson: JSON.stringify(validSpec), runOk: false });
    const tool = conn.tools.find((t) => t.name === 'reports.publish_live_report')!;
    const out = await tool.execute({ intent: 'sales', forceCreate: false }) as any;
    expect(out.status).toBe('smoke_failed');
    expect(out.errors.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to fail**

```bash
npx vitest run tests/unit/connectors/live-reports/connector-publish.test.ts
```
Expected: FAIL — `publish: implemented in Task 9` thrown.

- [ ] **Step 3: Implement `publish`**

Replace the `publish` method body in `src/connectors/live-reports/connector.ts`:

```ts
  private async publish(args: PublishArgs) {
    const actor = this.deps.getActor();
    if (!actor) return { error: { code: 'NO_ACTOR', message: 'no active actor' } };

    // 1. Dedup gate
    if (!args.forceCreate) {
      const dedup = await this.find({ intent: args.intent });
      if (dedup.matches.length > 0) {
        return {
          status: 'existing_match' as const,
          keywords: dedup.keywords,
          matches: dedup.matches,
          notes: 'Existing reports match this intent. Recommend them to the user. To create a new one anyway, call again with forceCreate: true.',
        };
      }
    }

    // 2. Compile via LLM (with Zod retry inside)
    let compileOut;
    try {
      compileOut = await compileLiveReport({
        intent: args.intent,
        claude: this.deps.claude,
        model: this.deps.model,
        toolCatalog: this.deps.getToolCatalog(),
      });
    } catch (err) {
      return { status: 'compile_failed' as const, message: err instanceof Error ? err.message : String(err) };
    }
    const spec = compileOut.spec;

    // 3. Smoke-execute the spec end-to-end. If EVERY step errors, abort.
    const smoke = await runLiveSpec(spec, this.deps.registry);
    if (smoke.errors.length === spec.data.length) {
      return {
        status: 'smoke_failed' as const,
        errors: smoke.errors,
        spec,
        message: 'Every data step failed during smoke execution. Spec was not persisted.',
      };
    }

    // 4. Persist
    const slugBase = slugifyTitle(spec.title);
    const slug = await findFreeSlug(slugBase, async (s) => (await this.deps.repo.getBySlug(s)) !== null);
    const accessToken = generateAccessToken();
    const intentKeywords = extractKeywords(args.intent);
    const created = await this.deps.repo.create({
      slug,
      title: spec.title,
      description: spec.description ?? null,
      ownerSlackId: actor.slackUserId,
      intent: args.intent,
      intentKeywords,
      spec,
      accessToken,
    });

    const url = `${this.deps.publicBaseUrl}/r/${created.slug}?t=${accessToken}`;
    logger.info({ slug, owner: actor.slackUserId, attempts: compileOut.attempts, ms: smoke.meta.durationMs }, 'live-report published');
    return {
      status: 'created' as const,
      slug: created.slug,
      title: created.title,
      url,
      compileAttempts: compileOut.attempts,
      smokeWarnings: smoke.errors,  // partial errors are non-fatal
    };
  }
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/connectors/live-reports/connector-publish.test.ts
```
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/live-reports/connector.ts tests/unit/connectors/live-reports/connector-publish.test.ts
git commit -m "feat(live-reports): reports.publish_live_report — dedup + compile + smoke + persist"
```

---

### Task 10: `reports.list_my_reports`

**Files:**
- Modify: `src/connectors/live-reports/connector.ts` (replace `listMine` stub)
- Test: `tests/unit/connectors/live-reports/connector-list.test.ts`

- [ ] **Step 1: Test**

Create `tests/unit/connectors/live-reports/connector-list.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { LiveReportsConnector } from '../../../../src/connectors/live-reports/connector.js';

function makeConn(reports: any[]) {
  return new LiveReportsConnector({
    repo: { listByOwner: vi.fn(async () => reports), listAll: vi.fn(), getBySlug: vi.fn(), create: vi.fn(), archive: vi.fn(), replaceSpec: vi.fn(), listHistory: vi.fn(), recordVisit: vi.fn(), searchByKeywords: vi.fn() } as never,
    claude: { messages: { create: vi.fn() } } as never,
    model: 'claude-sonnet-4-6',
    registry: { execute: vi.fn() } as never,
    getToolCatalog: () => '',
    publicBaseUrl: 'https://x',
    getActor: () => ({ slackUserId: 'UA' }),
    getRoleForActor: async () => 'user',
  });
}

describe('reports.list_my_reports', () => {
  it('returns reports owned by the actor with URLs', async () => {
    const conn = makeConn([
      { slug: 's1', title: 'T1', ownerSlackId: 'UA', accessToken: 'tok1', createdAt: '2026-04-01', updatedAt: '2026-04-01', visitCount: 4 },
      { slug: 's2', title: 'T2', ownerSlackId: 'UA', accessToken: 'tok2', createdAt: '2026-04-02', updatedAt: '2026-04-02', visitCount: 0 },
    ]);
    const tool = conn.tools.find((t) => t.name === 'reports.list_my_reports')!;
    const out = await tool.execute({}) as any;
    expect(out.reports).toHaveLength(2);
    expect(out.reports[0].url).toMatch(/\/r\/s1\?t=tok1/);
  });
});
```

- [ ] **Step 2: Run to fail**

```bash
npx vitest run tests/unit/connectors/live-reports/connector-list.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Replace `listMine` in `src/connectors/live-reports/connector.ts`:

```ts
  private async listMine() {
    const actor = this.deps.getActor();
    if (!actor) return { error: { code: 'NO_ACTOR', message: 'no actor' } };
    const rows = await this.deps.repo.listByOwner(actor.slackUserId);
    return {
      reports: rows.map((r) => ({
        slug: r.slug,
        title: r.title,
        url: `${this.deps.publicBaseUrl}/r/${r.slug}?t=${r.accessToken}`,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        visitCount: r.visitCount,
        lastVisitedAt: r.lastVisitedAt,
      })),
    };
  }
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/connectors/live-reports/connector-list.test.ts
```
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/live-reports/connector.ts tests/unit/connectors/live-reports/connector-list.test.ts
git commit -m "feat(live-reports): reports.list_my_reports"
```

---

### Task 11: `reports.recompile_report` + `reports.archive_report` (RBAC)

**Files:**
- Modify: `src/connectors/live-reports/connector.ts`
- Test: `tests/unit/connectors/live-reports/connector-rbac.test.ts`

- [ ] **Step 1: Test**

Create `tests/unit/connectors/live-reports/connector-rbac.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { LiveReportsConnector } from '../../../../src/connectors/live-reports/connector.js';

const okSpec = JSON.stringify({
  version: 1, title: 'Updated Title',
  data: [{ id: 'a', tool: 'gantri.order_stats', args: {} }],
  ui: [{ type: 'kpi', label: 'X', value: 'a.totalOrders' }],
});

function makeConn(opts: {
  ownerOfTarget: string;
  actorSlackId: string;
  isAdmin: boolean;
  intentJson?: string;
  runOk?: boolean;
}) {
  const target = { slug: 's1', title: 'Old', ownerSlackId: opts.ownerOfTarget, accessToken: 't', spec: { version: 1, title: 'Old', data: [], ui: [] }, intent: 'old' };
  const repo = {
    getBySlug: vi.fn(async (slug: string) => slug === 's1' ? target : null),
    archive: vi.fn(async () => undefined),
    replaceSpec: vi.fn(async (input: any) => ({ ...target, ...input, slug: 's1', accessToken: input.newAccessToken ?? target.accessToken })),
    listAll: vi.fn(async () => []),
    listByOwner: vi.fn(async () => []),
    listHistory: vi.fn(),
    recordVisit: vi.fn(),
    searchByKeywords: vi.fn(),
    create: vi.fn(),
  };
  const claude = { messages: { create: vi.fn(async () => ({ content: [{ type: 'text', text: opts.intentJson ?? okSpec }], usage: { input_tokens: 1, output_tokens: 1 } })) } };
  const registry = { execute: vi.fn(async () => (opts.runOk === false ? { ok: false, error: { code: 'X', message: 'no' } } : { ok: true, data: { totalOrders: 1 } })) };
  return new LiveReportsConnector({
    repo: repo as never,
    claude: claude as never,
    model: 'claude-sonnet-4-6',
    registry: registry as never,
    getToolCatalog: () => '',
    publicBaseUrl: 'https://x',
    getActor: () => ({ slackUserId: opts.actorSlackId }),
    getRoleForActor: async () => (opts.isAdmin ? 'admin' : 'user'),
  });
}

describe('reports.recompile_report', () => {
  it('rejects when actor is not owner and not admin', async () => {
    const conn = makeConn({ ownerOfTarget: 'UA', actorSlackId: 'UB', isAdmin: false });
    const tool = conn.tools.find((t) => t.name === 'reports.recompile_report')!;
    const out = await tool.execute({ slug: 's1', newIntent: 'new', regenerateToken: false }) as any;
    expect(out.error?.code).toBe('FORBIDDEN');
  });

  it('allows owner to recompile', async () => {
    const conn = makeConn({ ownerOfTarget: 'UA', actorSlackId: 'UA', isAdmin: false });
    const tool = conn.tools.find((t) => t.name === 'reports.recompile_report')!;
    const out = await tool.execute({ slug: 's1', newIntent: 'new', regenerateToken: false }) as any;
    expect(out.status).toBe('recompiled');
    expect(out.slug).toBe('s1');
  });

  it('admin can recompile any report', async () => {
    const conn = makeConn({ ownerOfTarget: 'UA', actorSlackId: 'UADMIN', isAdmin: true });
    const tool = conn.tools.find((t) => t.name === 'reports.recompile_report')!;
    const out = await tool.execute({ slug: 's1', newIntent: 'new', regenerateToken: true }) as any;
    expect(out.status).toBe('recompiled');
  });
});

describe('reports.archive_report', () => {
  it('rejects non-owner non-admin', async () => {
    const conn = makeConn({ ownerOfTarget: 'UA', actorSlackId: 'UB', isAdmin: false });
    const tool = conn.tools.find((t) => t.name === 'reports.archive_report')!;
    const out = await tool.execute({ slug: 's1' }) as any;
    expect(out.error?.code).toBe('FORBIDDEN');
  });
  it('allows owner', async () => {
    const conn = makeConn({ ownerOfTarget: 'UA', actorSlackId: 'UA', isAdmin: false });
    const tool = conn.tools.find((t) => t.name === 'reports.archive_report')!;
    const out = await tool.execute({ slug: 's1' }) as any;
    expect(out.status).toBe('archived');
  });
});
```

- [ ] **Step 2: Run to fail**

```bash
npx vitest run tests/unit/connectors/live-reports/connector-rbac.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `recompile` and `archive`**

Replace stubs in `src/connectors/live-reports/connector.ts`:

```ts
  private async assertCanModify(slug: string): Promise<{ allowed: boolean; report?: any; reason?: string }> {
    const actor = this.deps.getActor();
    if (!actor) return { allowed: false, reason: 'NO_ACTOR' };
    const report = await this.deps.repo.getBySlug(slug);
    if (!report) return { allowed: false, reason: 'NOT_FOUND' };
    const role = await this.deps.getRoleForActor(actor.slackUserId);
    if (report.ownerSlackId === actor.slackUserId || role === 'admin') return { allowed: true, report };
    return { allowed: false, reason: 'FORBIDDEN', report };
  }

  private async recompile(args: RecompileArgs) {
    const gate = await this.assertCanModify(args.slug);
    if (!gate.allowed) {
      const code = gate.reason ?? 'FORBIDDEN';
      return { error: { code, message: code === 'NOT_FOUND' ? 'Report not found' : 'Only the report author or an admin can recompile' } };
    }
    const compileOut = await compileLiveReport({
      intent: args.newIntent,
      claude: this.deps.claude,
      model: this.deps.model,
      toolCatalog: this.deps.getToolCatalog(),
    });
    const smoke = await runLiveSpec(compileOut.spec, this.deps.registry);
    if (smoke.errors.length === compileOut.spec.data.length) {
      return { error: { code: 'SMOKE_FAILED', message: 'Every step errored. Spec was not saved.' }, errors: smoke.errors };
    }
    const actor = this.deps.getActor()!;
    const newToken = args.regenerateToken ? generateAccessToken() : undefined;
    const updated = await this.deps.repo.replaceSpec({
      slug: args.slug,
      spec: compileOut.spec,
      intent: args.newIntent,
      intentKeywords: extractKeywords(args.newIntent),
      replacedBy: actor.slackUserId,
      newAccessToken: newToken,
    });
    return {
      status: 'recompiled' as const,
      slug: updated.slug,
      title: updated.title,
      url: `${this.deps.publicBaseUrl}/r/${updated.slug}?t=${updated.accessToken}`,
      tokenRotated: !!newToken,
    };
  }

  private async archive(args: ArchiveArgs) {
    const gate = await this.assertCanModify(args.slug);
    if (!gate.allowed) {
      const code = gate.reason ?? 'FORBIDDEN';
      return { error: { code, message: code === 'NOT_FOUND' ? 'Report not found' : 'Only the report author or an admin can archive' } };
    }
    const actor = this.deps.getActor()!;
    await this.deps.repo.archive(args.slug, actor.slackUserId);
    return { status: 'archived' as const, slug: args.slug };
  }
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/connectors/live-reports/
```
Expected: all 4 connector test files pass.

- [ ] **Step 5: Commit**

```bash
git add src/connectors/live-reports/connector.ts tests/unit/connectors/live-reports/connector-rbac.test.ts
git commit -m "feat(live-reports): reports.recompile_report + reports.archive_report (author/admin only)"
```

---

## Phase 3 — HTTP endpoints (3 tasks)

### Task 12: `GET /r/:slug/data.json` endpoint

**Files:**
- Create: `src/server/live-reports-routes.ts`
- Test: `tests/unit/server/live-reports-routes.test.ts`

- [ ] **Step 1: Test**

Create `tests/unit/server/live-reports-routes.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { mountLiveReportsRoutes } from '../../../src/server/live-reports-routes.js';

function makeApp(opts: { repo: any; registry: any }) {
  const app = express();
  mountLiveReportsRoutes(app, { repo: opts.repo, registry: opts.registry, webDistDir: '/nonexistent' });
  return app;
}

async function fetchJson(app: express.Express, path: string) {
  const server = app.listen(0);
  const port = (server.address() as any).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const body = await res.text();
    return { status: res.status, body, json: (() => { try { return JSON.parse(body); } catch { return null; } })() };
  } finally { server.close(); }
}

const validReport = {
  id: 'r1', slug: 's1', title: 'T', accessToken: 'TOK',
  spec: { version: 1, title: 'T', data: [{ id: 'a', tool: 'gantri.order_stats', args: {} }], ui: [{ type: 'kpi', label: 'X', value: 'a.totalOrders' }], cacheTtlSec: 0 },
  ownerSlackId: 'UA', intent: 'i', intentKeywords: [], createdAt: '2026-04-26', updatedAt: '2026-04-26', archivedAt: null, visitCount: 0, lastVisitedAt: null, specVersion: 1, description: null,
};

describe('GET /r/:slug/data.json', () => {
  it('404 when report missing', async () => {
    const repo = { getBySlug: vi.fn(async () => null), recordVisit: vi.fn() };
    const registry = { execute: vi.fn() };
    const app = makeApp({ repo, registry });
    const r = await fetchJson(app, '/r/missing/data.json?t=anything');
    expect(r.status).toBe(404);
  });

  it('401 when token mismatches', async () => {
    const repo = { getBySlug: vi.fn(async () => validReport), recordVisit: vi.fn() };
    const registry = { execute: vi.fn() };
    const app = makeApp({ repo, registry });
    const r = await fetchJson(app, '/r/s1/data.json?t=WRONG');
    expect(r.status).toBe(401);
  });

  it('200 returns dataResults + ui + meta on valid token', async () => {
    const repo = { getBySlug: vi.fn(async () => validReport), recordVisit: vi.fn() };
    const registry = { execute: vi.fn(async () => ({ ok: true, data: { totalOrders: 87 } })) };
    const app = makeApp({ repo, registry });
    const r = await fetchJson(app, '/r/s1/data.json?t=TOK');
    expect(r.status).toBe(200);
    expect(r.json.dataResults.a).toEqual({ totalOrders: 87 });
    expect(r.json.ui[0].type).toBe('kpi');
    expect(r.json.meta.sources).toContain('gantri.order_stats');
    expect(r.json.meta.spec).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to fail**

```bash
npx vitest run tests/unit/server/live-reports-routes.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/server/live-reports-routes.ts`:

```ts
import path from 'node:path';
import type { Express } from 'express';
import type { PublishedReportsRepo } from '../storage/repositories/published-reports.js';
import { runLiveSpec } from '../reports/live/runner.js';
import { logger } from '../logger.js';

interface MinimalRegistry {
  execute(toolName: string, args: unknown): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
}

export interface LiveReportsRoutesDeps {
  repo: PublishedReportsRepo;
  registry: MinimalRegistry;
  webDistDir: string; // absolute path to web/dist; HTML shell served from here
}

export function mountLiveReportsRoutes(app: Express, deps: LiveReportsRoutesDeps): void {
  // GET /r/:slug/data.json — the deterministic data endpoint.
  app.get('/r/:slug/data.json', async (req, res) => {
    try {
      const slug = req.params.slug;
      const token = String(req.query.t ?? '');
      const report = await deps.repo.getBySlug(slug);
      if (!report) return res.status(404).json({ error: 'not_found' });
      if (token !== report.accessToken) return res.status(401).json({ error: 'unauthorized' });
      const result = await runLiveSpec(report.spec, deps.registry);
      void deps.repo.recordVisit(slug).catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'recordVisit failed'));
      res.set('Cache-Control', `public, max-age=${report.spec.cacheTtlSec ?? 300}`);
      return res.json({
        dataResults: result.dataResults,
        ui: result.ui,
        errors: result.errors,
        meta: {
          ...result.meta,
          slug: report.slug,
          title: report.title,
          description: report.description,
          owner_slack_id: report.ownerSlackId,
          intent: report.intent,
          createdAt: report.createdAt,
          updatedAt: report.updatedAt,
          lastRefreshedAt: result.meta.generatedAt,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, '/r/:slug/data.json failed');
      res.status(500).json({ error: 'internal', detail: msg });
    }
  });

  // GET /r/:slug — serves the SPA shell. The SPA itself reads slug from URL.
  app.get('/r/:slug', (_req, res) => {
    res.sendFile(path.join(deps.webDistDir, 'index.html'));
  });

  // Static assets for the SPA (JS, CSS, logo, favicon, etc.).
  app.get(/^\/r\/(assets|logo-name\.png|favicon\.png|og-image\.png).*/, (req, res, next) => {
    // Strip the "/r/" prefix so express.static finds the file under web/dist
    const rest = req.path.replace(/^\/r\//, '');
    res.sendFile(path.join(deps.webDistDir, rest), (err) => err && next());
  });
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/server/live-reports-routes.test.ts
```
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/server/live-reports-routes.ts tests/unit/server/live-reports-routes.test.ts
git commit -m "feat(live-reports): /r/:slug/data.json endpoint with token auth + cache headers"
```

---

### Task 13: HTML shell route + static assets

The shell route is already in `mountLiveReportsRoutes` (Task 12). This task adds an integration-style smoke test that the SPA index.html actually loads.

**Files:**
- Test: `tests/unit/server/live-reports-shell.test.ts`

- [ ] **Step 1: Test**

Create `tests/unit/server/live-reports-shell.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { mountLiveReportsRoutes } from '../../../src/server/live-reports-routes.js';

describe('GET /r/:slug serves the SPA shell', () => {
  it('returns index.html from webDistDir', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webdist-'));
    fs.writeFileSync(path.join(tmp, 'index.html'), '<!doctype html><html><body>Live Reports SPA</body></html>');
    const app = express();
    mountLiveReportsRoutes(app, { repo: { getBySlug: vi.fn() } as never, registry: { execute: vi.fn() } as never, webDistDir: tmp });
    const server = app.listen(0);
    const port = (server.address() as any).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/r/anything`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('Live Reports SPA');
    } finally { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run**

```bash
npx vitest run tests/unit/server/live-reports-shell.test.ts
```
Expected: 1 passed.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/server/live-reports-shell.test.ts
git commit -m "test(live-reports): SPA shell served at GET /r/:slug"
```

---

### Task 14: Refresh endpoint (cache bypass)

**Files:**
- Modify: `src/server/live-reports-routes.ts` (add `?refresh=1` handling)
- Modify: `tests/unit/server/live-reports-routes.test.ts` (add a refresh test)

- [ ] **Step 1: Add the test**

Append to `tests/unit/server/live-reports-routes.test.ts`:

```ts
describe('GET /r/:slug/data.json?refresh=1', () => {
  it('sets Cache-Control: no-store when refresh is requested', async () => {
    const repo = { getBySlug: vi.fn(async () => validReport), recordVisit: vi.fn() };
    const registry = { execute: vi.fn(async () => ({ ok: true, data: { totalOrders: 1 } })) };
    const app = makeApp({ repo, registry });
    const server = app.listen(0);
    const port = (server.address() as any).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/r/s1/data.json?t=TOK&refresh=1`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
    } finally { server.close(); }
  });
});
```

- [ ] **Step 2: Run to fail**

```bash
npx vitest run tests/unit/server/live-reports-routes.test.ts
```
Expected: 1 fail (the new refresh test).

- [ ] **Step 3: Update the route**

In `src/server/live-reports-routes.ts`, modify the data.json handler — replace the `res.set('Cache-Control', ...)` line with:

```ts
      const refresh = String(req.query.refresh ?? '') === '1';
      res.set('Cache-Control', refresh ? 'no-store' : `public, max-age=${report.spec.cacheTtlSec ?? 300}`);
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/unit/server/live-reports-routes.test.ts
```
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/server/live-reports-routes.ts tests/unit/server/live-reports-routes.test.ts
git commit -m "feat(live-reports): ?refresh=1 bypasses cache headers"
```

---

## Phase 4 — Frontend (8 tasks)

(Frontend tasks have lighter test coverage than backend — Vitest in JSDom mode for components, but the visual review is the smoke test. We do unit-test the format + valueRef helpers strictly.)

### Task 15: Frontend lib helpers (format + valueRef + api)

**Files:**
- Create: `web/src/lib/format.ts`, `web/src/lib/valueRef.ts`, `web/src/lib/api.ts`
- Test: `web/src/lib/__tests__/format.test.ts`, `web/src/lib/__tests__/valueRef.test.ts`

- [ ] **Step 1: Add vitest to web/**

Edit `web/package.json` — add to `devDependencies`:
```json
"vitest": "^2.1.4",
"@types/node": "^20.14.0"
```

Add to `scripts`:
```json
"test": "vitest run"
```

Run:
```bash
cd web && npm install
```

- [ ] **Step 2: Tests**

Create `web/src/lib/__tests__/format.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fmt } from '../format.js';

describe('fmt', () => {
  it('currency formats with USD + two decimals', () => {
    expect(fmt(1234.5, 'currency')).toBe('$1,234.50');
  });
  it('percent multiplies by 100 and adds %', () => {
    expect(fmt(0.123, 'percent')).toBe('12.30%');
  });
  it('number adds thousand separators', () => {
    expect(fmt(1234567, 'number')).toBe('1,234,567');
  });
  it('returns "—" for null/undefined', () => {
    expect(fmt(null, 'number')).toBe('—');
    expect(fmt(undefined, 'currency')).toBe('—');
  });
  it('passes through strings', () => {
    expect(fmt('hello', 'number')).toBe('hello');
  });
});
```

Create `web/src/lib/__tests__/valueRef.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveRef } from '../valueRef.js';

const root = { a: { rows: [{ x: 1 }, { x: 2 }], total: 99 } };

describe('resolveRef (frontend)', () => {
  it('navigates dotted paths', () => {
    expect(resolveRef('a.total', root)).toBe(99);
  });
  it('indexes arrays', () => {
    expect(resolveRef('a.rows[1].x', root)).toBe(2);
  });
  it('returns undefined for missing', () => {
    expect(resolveRef('a.nope', root)).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run to fail**

```bash
cd web && npx vitest run
```
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

Create `web/src/lib/format.ts`:

```ts
export type FormatKind = 'currency' | 'number' | 'percent' | 'date_pt' | 'pct_delta' | 'admin_order_link';

const numberFmt = new Intl.NumberFormat('en-US');
const currencyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const percentFmt = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function fmt(v: unknown, kind: FormatKind): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') {
    if (kind === 'admin_order_link') return v;
    return v;
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  switch (kind) {
    case 'currency': return currencyFmt.format(n);
    case 'percent': return percentFmt.format(n);
    case 'pct_delta': return `${n >= 0 ? '+' : ''}${percentFmt.format(n)}`;
    case 'date_pt': return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(n));
    case 'number':
    default: return numberFmt.format(n);
  }
}

export function fmtRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}
```

Create `web/src/lib/valueRef.ts`:

```ts
export function resolveRef(ref: string, root: unknown): unknown {
  if (!ref || typeof ref !== 'string') return undefined;
  const segments = ref.split('.');
  if (segments.some((s) => s === '')) return undefined;
  let cur: unknown = root;
  for (const raw of segments) {
    const m = raw.match(/^([^[\]]+)((?:\[\d+\])*)$/);
    if (!m) return undefined;
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[m[1]];
    const idxs = m[2].match(/\[(\d+)\]/g) ?? [];
    for (const idxStr of idxs) {
      const i = Number(idxStr.slice(1, -1));
      if (!Array.isArray(cur)) return undefined;
      cur = cur[i];
    }
  }
  return cur;
}
```

Create `web/src/lib/api.ts`:

```ts
export interface ReportPayload {
  dataResults: Record<string, unknown>;
  ui: any[];
  errors: Array<{ stepId: string; tool: string; code: string; message: string }>;
  meta: {
    slug: string;
    title: string;
    description?: string | null;
    owner_slack_id: string;
    intent: string;
    createdAt: string;
    updatedAt: string;
    lastRefreshedAt: string;
    sources: string[];
    spec: any;
  };
}

export async function fetchReport(slug: string, token: string, refresh = false): Promise<ReportPayload> {
  const url = `/r/${slug}/data.json?t=${encodeURIComponent(token)}${refresh ? '&refresh=1' : ''}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return await res.json();
}
```

- [ ] **Step 5: Run tests**

```bash
cd web && npx vitest run
```
Expected: 8 passed.

- [ ] **Step 6: Commit**

```bash
git add web/
git commit -m "feat(live-reports/web): format + valueRef + api helpers with vitest coverage"
```

---

### Task 16: UI block primitives — KPI, Chart, Table, Text, Divider

**Files:**
- Create: `web/src/blocks/KpiBlock.tsx`, `ChartBlock.tsx`, `TableBlock.tsx`, `TextBlock.tsx`, `DividerBlock.tsx`

(No DOM tests on these — visual review and the e2e smoke test in Task 28 are the gates. They're Tremor wrappers, so the surface area we add is small.)

- [ ] **Step 1: Implement KpiBlock**

Create `web/src/blocks/KpiBlock.tsx`:

```tsx
import { Card, Metric, Text, Flex, BadgeDelta } from '@tremor/react';
import { resolveRef } from '../lib/valueRef.js';
import { fmt } from '../lib/format.js';

export function KpiBlock({ block, dataResults }: { block: any; dataResults: Record<string, unknown> }) {
  const v = resolveRef(block.value, dataResults);
  const display = fmt(v, block.format ?? 'number');
  let delta: { pct: number; abs: number } | null = null;
  if (block.delta && typeof v === 'number') {
    const fromV = resolveRef(block.delta.from, dataResults);
    if (typeof fromV === 'number' && fromV !== 0) {
      delta = { pct: (v - fromV) / fromV, abs: v - fromV };
    }
  }
  const widthClass = (
    { 1: 'col-span-1', 2: 'col-span-2', 3: 'col-span-3', 4: 'col-span-4' } as Record<number, string>
  )[block.width ?? 1];
  return (
    <Card decoration="left" decorationColor="blue" className={widthClass}>
      <Text>{block.label}</Text>
      <Metric>{display}</Metric>
      {delta && (
        <Flex justifyContent="start" className="mt-2">
          <BadgeDelta deltaType={delta.pct >= 0 ? 'increase' : 'decrease'}>
            {fmt(delta.pct, 'pct_delta')}
          </BadgeDelta>
          <Text className="ml-2">vs. previous period</Text>
        </Flex>
      )}
    </Card>
  );
}
```

- [ ] **Step 2: Implement ChartBlock**

Create `web/src/blocks/ChartBlock.tsx`:

```tsx
import { Card, Title, LineChart, BarChart, AreaChart, DonutChart } from '@tremor/react';
import { resolveRef } from '../lib/valueRef.js';

const heightClass: Record<string, string> = { sm: 'h-48', md: 'h-72', lg: 'h-96' };

export function ChartBlock({ block, dataResults }: { block: any; dataResults: Record<string, unknown> }) {
  const data = resolveRef(block.data, dataResults);
  if (!Array.isArray(data) || data.length === 0) {
    return <Card><Title>{block.title}</Title><div className="py-8 text-center text-sm text-gray-500">No data for this period.</div></Card>;
  }
  const categories = Array.isArray(block.y) ? block.y : [block.y];
  const valueFormatter = (n: number) => {
    if (block.yFormat === 'currency') return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
    if (block.yFormat === 'percent') return `${(n * 100).toFixed(1)}%`;
    return new Intl.NumberFormat('en-US').format(n);
  };
  const common = { data, index: block.x, categories, valueFormatter, className: heightClass[block.height ?? 'md'], yAxisWidth: 60 };
  return (
    <Card>
      <Title>{block.title}</Title>
      {block.variant === 'line' && <LineChart {...common} />}
      {block.variant === 'area' && <AreaChart {...common} />}
      {block.variant === 'bar' && <BarChart {...common} />}
      {block.variant === 'horizontal_bar' && <BarChart {...common} layout="vertical" />}
      {block.variant === 'donut' && <DonutChart data={data} category={categories[0]} index={block.x} valueFormatter={valueFormatter} className={heightClass[block.height ?? 'md']} />}
    </Card>
  );
}
```

- [ ] **Step 3: Implement TableBlock**

Create `web/src/blocks/TableBlock.tsx`:

```tsx
import { Card, Title, Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell } from '@tremor/react';
import { resolveRef } from '../lib/valueRef.js';
import { fmt } from '../lib/format.js';

export function TableBlock({ block, dataResults }: { block: any; dataResults: Record<string, unknown> }) {
  const data = resolveRef(block.data, dataResults);
  if (!Array.isArray(data)) {
    return <Card>{block.title && <Title>{block.title}</Title>}<div className="py-6 text-center text-sm text-gray-500">No data.</div></Card>;
  }
  let rows = [...data];
  if (block.sortBy) {
    const f = block.sortBy.field;
    const dir = block.sortBy.direction === 'asc' ? 1 : -1;
    rows.sort((a, b) => (((a as any)[f] ?? 0) > ((b as any)[f] ?? 0) ? dir : -dir));
  }
  const sliced = rows.slice(0, block.pageSize ?? 25);
  return (
    <Card>
      {block.title && <Title>{block.title}</Title>}
      <Table className="mt-4">
        <TableHead>
          <TableRow>
            {block.columns.map((c: any) => (
              <TableHeaderCell key={c.field} className={c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : ''}>
                {c.label}
              </TableHeaderCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {sliced.map((r: any, i: number) => (
            <TableRow key={i}>
              {block.columns.map((c: any) => (
                <TableCell key={c.field} className={c.align === 'right' ? 'text-right tabular-nums' : c.align === 'center' ? 'text-center' : ''}>
                  {c.format === 'admin_order_link' && r[c.field]
                    ? <a href={`https://admin.gantri.com/orders/${r[c.field]}`} target="_blank" rel="noreferrer" className="text-blue-600 underline">#{r[c.field]}</a>
                    : fmt(r[c.field], c.format ?? 'number')}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
```

- [ ] **Step 4: Implement TextBlock + DividerBlock**

Create `web/src/blocks/TextBlock.tsx`:

```tsx
export function TextBlock({ block }: { block: { markdown: string } }) {
  // Lightweight markdown — bold, italic, line breaks. Avoid pulling a full md lib.
  const html = block.markdown
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n\n/g, '<br/><br/>')
    .replace(/\n/g, '<br/>');
  return <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: html }} />;
}
```

Create `web/src/blocks/DividerBlock.tsx`:

```tsx
export function DividerBlock() {
  return <hr className="my-6 border-gray-200" />;
}
```

- [ ] **Step 5: Verify build**

```bash
cd web && npm run build
```
Expected: builds OK, no errors. `dist/` populated.

- [ ] **Step 6: Commit**

```bash
git add web/src/blocks/
git commit -m "feat(live-reports/web): KpiBlock + ChartBlock + TableBlock + TextBlock + DividerBlock"
```

---

### Task 17: ReportHeader + ReportFooter + ErrorState + LoadingShimmer

**Files:**
- Create: `web/src/components/ReportHeader.tsx`, `ReportFooter.tsx`, `ErrorState.tsx`, `LoadingShimmer.tsx`

- [ ] **Step 1: Implement ReportHeader**

Create `web/src/components/ReportHeader.tsx`:

```tsx
import { Button } from '@tremor/react';
import { fmtRelativeTime } from '../lib/format.js';

interface Props {
  title: string;
  subtitle?: string | null;
  lastRefreshedAt: string;
  onRefresh: () => void;
  refreshing: boolean;
  onShowSpec: () => void;
}

export function ReportHeader({ title, subtitle, lastRefreshedAt, onRefresh, refreshing, onShowSpec }: Props) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between border-b border-gray-200 pb-6 mb-8">
      <div className="flex items-center gap-4">
        <a href="/r"><img src="/r/logo-name.png" alt="Gantri" className="h-7 w-auto" /></a>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-gantri-ink">{title}</h1>
          {subtitle && <p className="text-sm text-gray-500 mt-1">{subtitle}</p>}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-500" title={lastRefreshedAt}>Updated {fmtRelativeTime(lastRefreshedAt)}</span>
        <Button size="xs" variant="secondary" onClick={onRefresh} loading={refreshing}>Refresh</Button>
        <Button size="xs" variant="light" onClick={onShowSpec}>View spec</Button>
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Implement ReportFooter**

Create `web/src/components/ReportFooter.tsx`:

```tsx
interface Props {
  ownerSlackId: string;
  createdAt: string;
  lastRefreshedAt: string;
  intent: string;
  sources: string[];
  onRefresh: () => void;
  onReportFeedback: () => void;
}

export function ReportFooter({ ownerSlackId, createdAt, lastRefreshedAt, intent, sources, onRefresh, onReportFeedback }: Props) {
  const sourcesPretty = [...new Set(sources.map((s) => s.split('.')[0]))].map((p) => ({
    northbeam: 'Northbeam', gantri: 'Porter', ga4: 'Google Analytics 4', grafana: 'Grafana',
  }[p] ?? p)).join(' · ');
  return (
    <footer className="mt-12 border-t border-gray-200 pt-6 text-sm text-gray-600">
      <p><strong>Created by</strong> <span className="text-blue-600">@{ownerSlackId}</span> · <strong>{new Date(createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</strong> · last refreshed {new Date(lastRefreshedAt).toLocaleTimeString('en-US')}</p>
      <p className="mt-2"><strong>Generated from:</strong> <em>"{intent}"</em></p>
      <p className="mt-2"><strong>Data sources:</strong> {sourcesPretty}</p>
      <p className="mt-4 flex gap-4">
        <button className="text-blue-600 hover:underline" onClick={onRefresh}>Refresh now</button>
        <button className="text-blue-600 hover:underline" onClick={onReportFeedback}>Report a wrong number</button>
      </p>
    </footer>
  );
}
```

- [ ] **Step 3: Implement ErrorState + LoadingShimmer**

Create `web/src/components/ErrorState.tsx`:

```tsx
export function ErrorState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      <strong>{title}</strong>
      {detail && <p className="mt-1 text-red-600 whitespace-pre-wrap">{detail}</p>}
    </div>
  );
}
```

Create `web/src/components/LoadingShimmer.tsx`:

```tsx
export function LoadingShimmer() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-4 animate-pulse">
      {[1, 2, 3, 4].map((i) => <div key={i} className="h-28 rounded-lg bg-gray-100" />)}
      <div className="col-span-4 h-72 rounded-lg bg-gray-100" />
      <div className="col-span-4 h-96 rounded-lg bg-gray-100" />
    </div>
  );
}
```

- [ ] **Step 4: Verify build**

```bash
cd web && npm run build
```
Expected: builds OK.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/
git commit -m "feat(live-reports/web): ReportHeader (logo + refresh + view-spec) + ReportFooter (sources + feedback) + ErrorState + LoadingShimmer"
```

---

### Task 18: SpecDrawer (left slide-over)

**Files:**
- Create: `web/src/components/SpecDrawer.tsx`

- [ ] **Step 1: Implement**

Create `web/src/components/SpecDrawer.tsx`:

```tsx
import { useEffect, useState } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  intent: string;
  spec: any;
  meta: { owner_slack_id: string; createdAt: string; lastRefreshedAt: string; sources: string[] };
  canModify: boolean;
}

export function SpecDrawer({ open, onClose, intent, spec, meta, canModify }: Props) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const specJson = JSON.stringify(spec, null, 2);
  const sourcesCounts: Record<string, number> = {};
  for (const step of spec?.data ?? []) sourcesCounts[step.tool] = (sourcesCounts[step.tool] ?? 0) + 1;
  return (
    <>
      <div onClick={onClose} className="fixed inset-0 bg-black/30 z-40 transition-opacity" />
      <aside className="fixed inset-y-0 left-0 z-50 w-full sm:w-[480px] bg-white border-r border-gray-200 shadow-xl overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex justify-between items-center">
          <h2 className="text-lg font-semibold">Spec</h2>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-900 text-xl leading-none">×</button>
        </div>
        <div className="px-6 py-5 space-y-6">
          <section>
            <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">Intent</h3>
            <blockquote className="border-l-4 border-blue-500 pl-3 text-sm text-gray-800">{intent}</blockquote>
          </section>
          <section>
            <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">Provenance</h3>
            <p className="text-sm">
              Created by <span className="text-blue-600">@{meta.owner_slack_id}</span><br/>
              <span className="text-gray-600">{new Date(meta.createdAt).toLocaleString('en-US')}</span><br/>
              Last refreshed <span className="text-gray-600">{new Date(meta.lastRefreshedAt).toLocaleString('en-US')}</span><br/>
              Spec version <span className="font-mono">v{spec?.version ?? 1}</span>
            </p>
          </section>
          <section>
            <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">Data sources</h3>
            <ul className="text-sm space-y-1">
              {Object.entries(sourcesCounts).map(([tool, n]) => (
                <li key={tool}><span className="font-mono text-blue-700">{tool}</span> <span className="text-gray-500">× {n}</span></li>
              ))}
            </ul>
          </section>
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs uppercase tracking-wide text-gray-500">Spec JSON</h3>
              <button onClick={async () => { await navigator.clipboard.writeText(specJson); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="text-xs text-blue-600 hover:underline">{copied ? 'Copied!' : 'Copy'}</button>
            </div>
            <pre className="text-xs bg-gray-50 border border-gray-200 rounded p-3 overflow-x-auto"><code>{specJson}</code></pre>
          </section>
          {canModify && (
            <section>
              <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">Actions</h3>
              <p className="text-xs text-gray-500">Use the bot to recompile or archive this report:</p>
              <ul className="text-xs mt-1 space-y-0.5">
                <li><code className="text-gray-700">recompile this report with: &lt;new intent&gt;</code></li>
                <li><code className="text-gray-700">archive this report</code></li>
              </ul>
            </section>
          )}
        </div>
      </aside>
    </>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
cd web && npm run build
```
Expected: OK.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/SpecDrawer.tsx
git commit -m "feat(live-reports/web): SpecDrawer left slide-over (intent, provenance, sources, JSON, actions)"
```

---

### Task 19: App.tsx wiring everything

**Files:**
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Implement**

Replace `web/src/App.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { fetchReport, type ReportPayload } from './lib/api.js';
import { KpiBlock } from './blocks/KpiBlock.js';
import { ChartBlock } from './blocks/ChartBlock.js';
import { TableBlock } from './blocks/TableBlock.js';
import { TextBlock } from './blocks/TextBlock.js';
import { DividerBlock } from './blocks/DividerBlock.js';
import { ReportHeader } from './components/ReportHeader.js';
import { ReportFooter } from './components/ReportFooter.js';
import { SpecDrawer } from './components/SpecDrawer.js';
import { ErrorState } from './components/ErrorState.js';
import { LoadingShimmer } from './components/LoadingShimmer.js';

function readSlugAndToken(): { slug: string; token: string } | null {
  const m = window.location.pathname.match(/^\/r\/([^/]+)\/?$/);
  if (!m) return null;
  const slug = m[1];
  const token = new URLSearchParams(window.location.search).get('t') ?? '';
  return { slug, token };
}

export function App() {
  const ctx = readSlugAndToken();
  const [data, setData] = useState<ReportPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(window.location.hash === '#spec');

  async function load(refresh: boolean) {
    if (!ctx) return;
    if (refresh) setRefreshing(true); else setLoading(true);
    try {
      const payload = await fetchReport(ctx.slug, ctx.token, refresh);
      setData(payload);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { load(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => {
    const onHash = () => setDrawerOpen(window.location.hash === '#spec');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (!ctx) return <div className="p-10"><ErrorState title="Invalid URL" detail="Expected /r/<slug>" /></div>;
  if (err) return <div className="p-10"><ErrorState title="Couldn't load this report" detail={err} /></div>;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {data && (
        <ReportHeader
          title={data.meta.title}
          subtitle={data.meta.description ?? null}
          lastRefreshedAt={data.meta.lastRefreshedAt}
          onRefresh={() => load(true)}
          refreshing={refreshing}
          onShowSpec={() => { window.location.hash = '#spec'; setDrawerOpen(true); }}
        />
      )}
      {loading && <LoadingShimmer />}
      {data && (
        <main className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          {data.ui.map((block: any, i: number) => {
            const stepId = typeof block.value === 'string' ? block.value.split('.')[0]
              : typeof block.data === 'string' ? block.data.split('.')[0]
              : null;
            const stepError = stepId ? data.errors.find((e) => e.stepId === stepId) : null;
            if (stepError) {
              return <div key={i} className="col-span-4"><ErrorState title={`Couldn't load: ${stepError.tool}`} detail={stepError.message} /></div>;
            }
            switch (block.type) {
              case 'kpi': return <KpiBlock key={i} block={block} dataResults={data.dataResults} />;
              case 'chart': return <div key={i} className="col-span-4"><ChartBlock block={block} dataResults={data.dataResults} /></div>;
              case 'table': return <div key={i} className="col-span-4"><TableBlock block={block} dataResults={data.dataResults} /></div>;
              case 'text': return <div key={i} className="col-span-4"><TextBlock block={block} /></div>;
              case 'divider': return <div key={i} className="col-span-4"><DividerBlock /></div>;
              default: return null;
            }
          })}
        </main>
      )}
      {data && (
        <ReportFooter
          ownerSlackId={data.meta.owner_slack_id}
          createdAt={data.meta.createdAt}
          lastRefreshedAt={data.meta.lastRefreshedAt}
          intent={data.meta.intent}
          sources={data.meta.sources}
          onRefresh={() => load(true)}
          onReportFeedback={() => alert('To report a wrong number, DM the bot: feedback: <reason>')}
        />
      )}
      {data && (
        <SpecDrawer
          open={drawerOpen}
          onClose={() => { setDrawerOpen(false); if (window.location.hash === '#spec') history.replaceState(null, '', window.location.pathname + window.location.search); }}
          intent={data.meta.intent}
          spec={data.meta.spec}
          meta={{ owner_slack_id: data.meta.owner_slack_id, createdAt: data.meta.createdAt, lastRefreshedAt: data.meta.lastRefreshedAt, sources: data.meta.sources }}
          canModify={false}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
cd web && npm run build
```
Expected: builds OK. Visit `dist/index.html` should include all assets.

- [ ] **Step 3: Commit**

```bash
git add web/src/App.tsx
git commit -m "feat(live-reports/web): App wiring — fetch, render blocks, header, footer, drawer, refresh"
```

---

## Phase 5 — Integration (3 tasks)

### Task 20: Wire LiveReportsConnector + routes into `src/index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Edit imports + registration**

In `src/index.ts`, add at the top (with the other connector imports):

```ts
import { LiveReportsConnector } from './connectors/live-reports/connector.js';
import { PublishedReportsRepo } from './storage/repositories/published-reports.js';
import { mountLiveReportsRoutes } from './server/live-reports-routes.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
```

Find the section where `BroadcastConnector` is registered (after `getActiveActor()` is wired). Right after that registration, add:

```ts
  const publishedReportsRepo = new PublishedReportsRepo(supabase);
  registry.register(
    new LiveReportsConnector({
      repo: publishedReportsRepo,
      claude,
      model: 'claude-sonnet-4-6',
      registry: cachingRegistry,    // pre-existing var; falls back to `registry` if cachingRegistry isn't set up by this point
      getToolCatalog: () => registry.toolNames().join(', '),
      publicBaseUrl: process.env.PUBLIC_BASE_URL || 'https://gantri-ai-bot.fly.dev',
      getActor: () => {
        const a = getActiveActor();
        if (!a) throw new Error('live reports tool called without actor');
        return a;
      },
      getRoleForActor: (slackUserId) => usersRepo.getRole(slackUserId),
    }),
  );
```

(If `registry.toolNames()` doesn't exist, replace `getToolCatalog` with a function that returns the JSON descriptions of all registered tools. The compiler prompt only uses this as a hint.)

After `app.start(env.PORT)`, mount the routes BEFORE that line. Find the existing `receiver.router.get('/healthz', ...)` block and right after it add:

```ts
  // Live Reports HTML SPA + data endpoint
  const __filename = fileURLToPath(import.meta.url);
  const webDistDir = path.resolve(path.dirname(__filename), '..', 'web', 'dist');
  mountLiveReportsRoutes(receiver.app, {
    repo: publishedReportsRepo,
    registry: cachingRegistry,
    webDistDir,
  });
```

(If `cachingRegistry` is wrapped after the live-reports registration, use whichever variable refers to the final caching registry at this point.)

- [ ] **Step 2: Verify TS build**

```bash
cd /Users/danierestevez/Documents/work/gantri/gantri-ai-bot
npm run build
```
Expected: tsc exits 0.

- [ ] **Step 3: Run full test suite**

```bash
npm test
```
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(live-reports): wire LiveReportsConnector + /r/:slug routes into index.ts"
```

---

### Task 21: System prompt — trigger + dedup-first + tool docs

**Files:**
- Modify: `src/orchestrator/prompts.ts`

- [ ] **Step 1: Add the section**

Find the existing `*7. Scheduled reports*` block (search for `*7. Scheduled reports`). Add a new block right BEFORE it (so the canonical numbering becomes 7. Live Reports → 8. Scheduled reports — renumber inline):

```
*7. Live Reports (one-off shareable URL)* — \`reports.publish_live_report\`, \`reports.find_similar_reports\`, \`reports.list_my_reports\`, \`reports.recompile_report\`, \`reports.archive_report\`
  • 🚨 **\`reports.publish_live_report\` is ONLY for explicit "live report" requests.** Trigger words: "create a live report", "live dashboard", "shareable URL", "publish a live page", "make this a live report", "reporte en vivo", "dashboard en vivo", "publica un reporte". DO NOT fire for one-off questions, scheduled DM reports (use \`reports.subscribe\`), or canvas requests (\`reports.create_canvas\`).
  • 🚨 **ALWAYS call \`reports.find_similar_reports\` FIRST**, before \`reports.publish_live_report\`. Pass the user's full intent. If it returns matches with score≥3, recommend those existing reports to the user (with their URLs and owners). Do NOT compile a new spec without explicit confirmation that the user wants a new one despite the existing ones (then call \`publish_live_report\` with \`forceCreate: true\`).
  • The compile pipeline is automatic: dedup → LLM compiles JSON spec → Zod-validates → smoke-executes against real tools → persists with slug + access token. The user gets back a URL like \`gantri-ai-bot.fly.dev/r/<slug>?t=<token>\`.
  • Slugs are derived from the report title in English (\`Weekly Sales\` → \`weekly-sales\`). The LLM-generated title MUST be in English even if the user wrote in Spanish.
  • Use \`reports.list_my_reports\` for "what live reports do I have" / "qué reportes en vivo tengo".
  • \`reports.recompile_report\` replaces the spec of an existing report (slug stays stable, bookmarks survive). Author or admin only. Optional \`regenerateToken: true\` rotates the token.
  • \`reports.archive_report\` soft-deletes. Author or admin only.

```

(Renumber the rest of the prompt accordingly: scheduled reports moves from 7 to 8, etc.)

- [ ] **Step 2: Run tests**

```bash
npm test
```
Expected: green (the prompt is content-only — no test should regress).

- [ ] **Step 3: Build**

```bash
npm run build
```
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/prompts.ts
git commit -m "feat(live-reports): system prompt section + trigger + dedup-first rule"
```

---

### Task 22: Cache policies + RBAC review

**Files:**
- Modify: `src/connectors/base/default-policies.ts`

- [ ] **Step 1: Add policies for live-reports tools**

Edit `src/connectors/base/default-policies.ts`, append to the policy map:

```ts
  // Live Reports — find/list are read-only and idempotent; cache 60s.
  'reports.find_similar_reports': { version: 1, settleDays: 0, openTtlSec: 60, dateRangePath: '' },
  'reports.list_my_reports': { version: 1, settleDays: 0, openTtlSec: 30, dateRangePath: '' },
  // publish/recompile/archive are mutating — never cache.
```

(Ensure `dateRangePath: ''` is supported by the policy logic; if not, omit those lines and let the tools run uncached, which is fine for the volumes here.)

- [ ] **Step 2: Build + test**

```bash
npm run build && npm test
```
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add src/connectors/base/default-policies.ts
git commit -m "feat(live-reports): cache policies for find/list (60s/30s)"
```

---

## Phase 6 — Deploy + Verify (4 tasks)

### Task 23: Apply DB migration in production

- [ ] **Step 1: Apply via Supabase MCP**

Use the supabase MCP `apply_migration` tool with project_id `ykjjwszoxazzlcovhlgd` and the SQL from Task 1.

- [ ] **Step 2: Verify**

Use `execute_sql`:
```sql
SELECT count(*) AS cnt FROM published_reports;
```
Expected: 0 (table empty).

```sql
SELECT count(*) FROM published_reports_history;
```
Expected: 0.

- [ ] **Step 3: No commit needed (DDL only).**

---

### Task 24: Deploy to Fly + verify health

- [ ] **Step 1: Push branch**

```bash
git push origin feat/live-reports
```

- [ ] **Step 2: Deploy**

```bash
cd /Users/danierestevez/Documents/work/gantri/gantri-ai-bot
fly deploy --remote-only
```
Expected: image built, machine updated, health check passes.

- [ ] **Step 3: Verify endpoints**

```bash
curl -sS https://gantri-ai-bot.fly.dev/healthz
# {"ok":true}

curl -sS https://gantri-ai-bot.fly.dev/r/missing-report/data.json?t=x
# {"error":"not_found"}

curl -sS -o /dev/null -w "%{http_code}\n" https://gantri-ai-bot.fly.dev/r/anything
# 200 (the SPA shell)
```

- [ ] **Step 4: Inspect logs**

```bash
fly logs --no-tail | grep -i "live-report\|published_reports\|listening" | tail -20
```
Expected: at minimum, `gantri-ai-bot listening` from the most recent deploy. No errors related to live-reports.

---

### Task 25: Smoke test — create 3 live reports via the bot

This task exercises the system end-to-end through the actual orchestrator (with the real LLM). It runs from Fly's shell so all secrets are present.

- [ ] **Step 1: Smoke #1 — Weekly Sales by Channel**

Run via SSH:

```bash
cat <<'SCRIPT' | fly ssh console -C "node -" 2>&1 | tail -40
import('./dist/storage/supabase.js').then(async (s) => {
  const supabase = s.getSupabase();
  const env = process.env;
  const { Orchestrator } = await import('./dist/orchestrator/orchestrator.js');
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const claude = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const { ConnectorRegistry } = await import('./dist/connectors/base/registry.js');
  const { CachingRegistry } = await import('./dist/connectors/base/caching-registry.js');
  const { DEFAULT_CACHE_POLICIES } = await import('./dist/connectors/base/default-policies.js');
  const { TtlCache } = await import('./dist/storage/cache.js');
  const { LiveReportsConnector } = await import('./dist/connectors/live-reports/connector.js');
  const { PublishedReportsRepo } = await import('./dist/storage/repositories/published-reports.js');
  const { AuthorizedUsersRepo } = await import('./dist/storage/repositories/authorized-users.js');
  // Compose minimal registry — for smoke we don't need all connectors, just the LiveReports one + a real registry pointer for tool execution.
  // Reuse the production wiring by importing from index isn't trivial, so we drive end-to-end via direct tool call instead:
  const repo = new PublishedReportsRepo(supabase);
  const usersRepo = new AuthorizedUsersRepo(supabase);
  // Production-wide registry:
  const { NorthbeamApiConnector } = await import('./dist/connectors/northbeam-api/connector.js');
  const { GantriPorterConnector } = await import('./dist/connectors/gantri-porter/gantri-porter-connector.js');
  const { GrafanaConnector } = await import('./dist/connectors/grafana/grafana-connector.js');
  const { Ga4Client } = await import('./dist/connectors/ga4/client.js');
  const { Ga4Connector } = await import('./dist/connectors/ga4/connector.js');
  const { readVaultSecret } = await import('./dist/storage/supabase.js');
  const [nbKey, nbCid, porterUrl, porterEmail, porterPw, grafUrl, grafTok, grafUid, ga4Pid, ga4Key] = await Promise.all([
    'NORTHBEAM_API_KEY', 'NORTHBEAM_DATA_CLIENT_ID', 'PORTER_API_BASE_URL', 'PORTER_BOT_EMAIL', 'PORTER_BOT_PASSWORD', 'GRAFANA_URL', 'GRAFANA_TOKEN', 'GRAFANA_POSTGRES_DS_UID', 'GA4_PROPERTY_ID', 'GA4_SERVICE_ACCOUNT_KEY',
  ].map((n) => readVaultSecret(supabase, n).catch(() => null)));
  const reg = new ConnectorRegistry();
  reg.register(new NorthbeamApiConnector({ apiKey: nbKey, dataClientId: nbCid }));
  if (ga4Pid && ga4Key) reg.register(new Ga4Connector({ client: new Ga4Client({ propertyId: ga4Pid, serviceAccountKey: ga4Key }) }));
  const grafana = new GrafanaConnector({ baseUrl: grafUrl, token: grafTok, postgresDsUid: grafUid });
  reg.register(grafana);
  reg.register(new GantriPorterConnector({ baseUrl: porterUrl, email: porterEmail, password: porterPw, rollupRepo: { getBetween: async () => null } }));
  const live = new LiveReportsConnector({
    repo, claude, model: 'claude-sonnet-4-6', registry: reg,
    getToolCatalog: () => reg.toolNames().join(', '),
    publicBaseUrl: 'https://gantri-ai-bot.fly.dev',
    getActor: () => ({ slackUserId: 'UK0JM2PTM' }),
    getRoleForActor: async () => 'admin',
  });
  reg.register(live);
  const tool = live.tools.find((t) => t.name === 'reports.publish_live_report');
  const out = await tool.execute({ intent: 'Weekly sales by channel — last 7 days, KPI cards for revenue/spend/ROAS plus a line chart of daily revenue and a table of channel breakdowns', forceCreate: false });
  console.log(JSON.stringify(out, null, 2));
}).catch(e => { console.error('ERR:', e.message); console.error(e.stack); });
SCRIPT
```

Expected: a JSON response with `status: "created"`, a slug like `weekly-sales-by-channel`, and a URL.

- [ ] **Step 2: Verify the URL renders**

Take the URL from Step 1's output. Open it in a browser. Verify:
- The page loads (no 401, no 500).
- KPI cards render with numbers (not `—`).
- Line chart shows daily revenue.
- Table shows channels with revenue/spend/ROAS.
- "View spec" button opens the drawer with the JSON visible.
- "Refresh" button triggers a re-fetch.

If any block shows ErrorState, capture the error message and fix the prompt or tool args.

- [ ] **Step 3: Smoke #2 — Late Orders Snapshot**

Same SSH wrapper as Step 1, with this intent:

```
intent: 'A snapshot of currently-late orders. KPI cards with: total late, missed customer deadline, still within window. A table with the full per-order list — order id, customer, type, days past, primary cause.'
```

Verify URL renders.

- [ ] **Step 4: Smoke #3 — GA4 Page Engagement**

```
intent: 'GA4 page completion analysis last 30 days. KPI cards for site totals (views, sessions, scroll-to-bottom rate). Table for top 20 pages by views with their scroll rate. Another table for the bottom 20 pages by scroll rate (only pages with 500+ views).'
```

Verify URL renders.

- [ ] **Step 5: Verify dedup**

Re-run Smoke #1 verbatim. Expected: response has `status: "existing_match"` and matches[0].slug = the original.

- [ ] **Step 6: Verify cross-source visibility**

Run as a different "actor" (modify `getActor: () => ({ slackUserId: 'UIAN' })` in the wrapper) and call `reports.list_my_reports`. Expected: empty (Ian doesn't own any). Then call `reports.find_similar_reports` with intent matching the existing reports — expected: returns Danny's reports as matches (cross-org).

---

### Task 26: Final review + push to main

- [ ] **Step 1: Run full local test suite**

```bash
cd /Users/danierestevez/Documents/work/gantri/gantri-ai-bot
npm test
```
Expected: all green.

- [ ] **Step 2: Build full pipeline**

```bash
npm run build && cd web && npm run build
```
Expected: both green.

- [ ] **Step 3: Commit any final tweaks**

If any prompt fixes were applied during smoke tests, commit them.

- [ ] **Step 4: Open PR**

```bash
gh pr create --base main --head feat/live-reports --title "Live Reports: bot-generated shareable dashboards" --body "$(cat <<'EOF'
## Summary
- New \`reports.publish_live_report\` tool: bot compiles intent → JSON spec → persists, returns shareable URL.
- New tools: find_similar_reports, list_my_reports, recompile_report, archive_report.
- New endpoint: GET /r/:slug + /r/:slug/data.json (deterministic, no LLM at request time).
- New SPA: Vite + React + Tailwind + Tremor. KPI / chart / table / text / divider blocks.
- SpecDrawer: left slide-over with intent, provenance, sources, full spec JSON, copy button.
- Brand: Gantri logo in header + favicon + OG image.
- RBAC: author + admin can modify; URL token gates view (Slack OAuth in phase 2).
- Cross-org dedup: every publish_live_report is gated on find_similar_reports first.

Spec: \`docs/superpowers/specs/2026-04-27-live-reports-design.md\`
Plan: \`docs/superpowers/plans/2026-04-27-live-reports.md\`

## Test plan
- [x] Unit tests for spec validator, runner, valueRef, identifiers, dedup, repo, compiler, all 5 connector tools, routes (data.json + shell + refresh)
- [x] Frontend lib tests (format, valueRef)
- [x] End-to-end smoke: 3 reports created via the bot in production, all URLs render correctly, dedup recommends on duplicate ask
- [x] Migration applied
- [x] /healthz passes post-deploy

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Merge after review**

(Manual — Danny merges via GitHub UI when ready.)

---

## Self-review

**1. Spec coverage:**
- Spec `version: 1` Zod validator → Task 2 ✅
- Tool whitelist → Task 2 ✅
- ValueRef resolver → Task 3 ✅
- Spec runner with parallel + graceful errors → Task 4 ✅
- PublishedReportsRepo + history → Task 5 ✅
- Slug derived from title (English) + token gen → Task 6 ✅
- Cross-org dedup → Task 6, 8 ✅
- LLM compiler with Zod retry → Task 7 ✅
- `reports.publish_live_report` (dedup → compile → smoke → persist) → Task 9 ✅
- `reports.list_my_reports` → Task 10 ✅
- `reports.recompile_report` (RBAC) → Task 11 ✅
- `reports.archive_report` (RBAC) → Task 11 ✅
- `/r/:slug/data.json` (token auth + cache headers + graceful errors) → Task 12 ✅
- `/r/:slug` HTML shell → Task 13 ✅
- `?refresh=1` cache bypass → Task 14 ✅
- Frontend lib helpers → Task 15 ✅
- KPI/Chart/Table/Text/Divider blocks → Task 16 ✅
- Header (logo + refresh + view-spec) + Footer (sources + feedback) + ErrorState + LoadingShimmer → Task 17 ✅
- SpecDrawer left slide-over with copy + actions → Task 18 ✅
- App wiring (fetch + render + drawer + hash routing) → Task 19 ✅
- Wired into index.ts → Task 20 ✅
- System prompt (trigger + dedup-first) → Task 21 ✅
- Cache policies → Task 22 ✅
- DB migration applied → Task 23 ✅
- Deployed + healthchecks → Task 24 ✅
- 3 end-to-end test reports + dedup verification → Task 25 ✅

**2. Placeholder scan:** none — every step has explicit code or commands.

**3. Type consistency:** `LiveReportSpec`, `DataStep`, `UiBlock`, `ValueRef`, `PublishedReport` all defined in their first task and reused unchanged later. The `LiveReportsConnector` constructor signature is identical across tasks 8-11. The `ReportPayload` type used in the frontend (`web/src/lib/api.ts`) matches the response shape from `live-reports-routes.ts`. `mountLiveReportsRoutes` signature is consistent between tasks 12-14 and 20.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-27-live-reports.md`.**

Execution: subagent-driven, one fresh subagent per task. Two-stage review (spec compliance → code quality) per task. Phase boundaries (after tasks 6, 11, 14, 19, 22, 25) get a brief verification pause: run `npm test` + `npm run build` + (after task 24) curl the deployed endpoints. End-to-end smoke (Task 25) creates 3 real reports via the bot and visually verifies URLs render correctly.
