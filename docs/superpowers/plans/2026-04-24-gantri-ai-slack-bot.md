# gantri-ai-bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Slack DM bot that answers business questions in natural language by calling Claude with tool-use, grounded in Gantri's Northbeam GraphQL API. Architecture is pluggable so more data sources can be added later.

**Architecture:** Single Node/TS service on Fly.io. Slack events → Orchestrator (Claude tool-use) → Connector Registry → `NorthbeamConnector` (Auth0 JWT + GraphQL). Secrets and state in Supabase (Postgres + Vault). Playwright only used as a one-per-day fallback for Northbeam login if ROPC is disabled.

**Tech Stack:**
- Language: TypeScript 5.x (strict), Node 20
- Runtime: Fly.io container (Dockerfile)
- Slack: `@slack/bolt` (Events API, socket mode NOT used)
- LLM: `@anthropic-ai/sdk` (Claude Sonnet 4.6 default, Opus 4.7 escalation)
- GraphQL: native `fetch` wrapper (no heavy client needed — single endpoint, handwritten queries)
- DB/Secrets: `@supabase/supabase-js` against Supabase (Postgres + Vault)
- Browser: `playwright` + Chromium (fallback auth only)
- Validation: `zod` for env + tool-argument schemas
- Logging: `pino` (JSON) → stdout + BetterStack sink
- Testing: `vitest` + `msw` (HTTP mocking) + `supertest` (Slack event fixtures)
- Lint/format: `eslint` + `prettier`

---

## Assumed pre-conditions

- Supabase project exists and you have `SUPABASE_URL` and a service-role key with SQL + Vault privileges.
- An Anthropic API key is available.
- A Slack app has been created in Gantri's workspace with the following scopes: `im:history`, `im:write`, `chat:write`, `users:read`. The app's Bot Token (`xoxb-…`) and Signing Secret are available.
- Northbeam dashboard credentials (email/password) for `danny@gantri.com` are available. (Stored in `reference_northbeam_login` memory.)

If any of these is missing, stop and create it before starting implementation.

## File structure

```
gantri-ai-bot/
├── .env.example
├── .eslintrc.cjs
├── .prettierrc
├── Dockerfile
├── fly.toml
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── migrations/
│   └── 0001_initial.sql           # 4 tables from spec
├── src/
│   ├── index.ts                    # entry point: wire + start Slack app
│   ├── config/
│   │   └── env.ts                  # zod-parsed env + vault-loaded secrets
│   ├── logger.ts                   # pino instance
│   ├── storage/
│   │   ├── supabase.ts             # typed client + vault helpers
│   │   ├── cache.ts                # TTL cache over northbeam_cache table
│   │   └── repositories/
│   │       ├── authorized-users.ts
│   │       ├── conversations.ts
│   │       └── northbeam-tokens.ts
│   ├── connectors/
│   │   ├── base/
│   │   │   ├── connector.ts        # Connector interface + ToolDef + ToolResult types
│   │   │   └── registry.ts         # register + getTools + execute
│   │   └── northbeam/
│   │       ├── northbeam-connector.ts
│   │       ├── auth-manager.ts
│   │       ├── graphql-client.ts
│   │       ├── queries.ts          # typed GraphQL operation constants
│   │       ├── catalog.ts          # static metric catalog + tenant custom metrics
│   │       └── tools.ts            # 5 ToolDefs exposed to the LLM
│   ├── orchestrator/
│   │   ├── orchestrator.ts         # tool-use loop
│   │   ├── prompts.ts              # system prompt builder
│   │   └── formatter.ts            # markdown → Slack Blocks
│   └── slack/
│       ├── app.ts                  # Slack Bolt app setup
│       └── handlers.ts             # message.im + app_mention handlers
└── tests/
    ├── setup.ts                    # msw server, env fixtures
    ├── unit/
    │   ├── cache.test.ts
    │   ├── connector-registry.test.ts
    │   ├── northbeam/
    │   │   ├── graphql-client.test.ts
    │   │   ├── auth-manager.test.ts
    │   │   ├── catalog.test.ts
    │   │   └── tools.test.ts
    │   ├── orchestrator/
    │   │   ├── orchestrator.test.ts
    │   │   ├── prompts.test.ts
    │   │   └── formatter.test.ts
    │   └── slack/
    │       └── handlers.test.ts
    └── integration/
        └── end-to-end.test.ts
```

Files that change together (e.g. `northbeam-connector.ts` and its test) are co-located within their module folder (tests under `tests/unit/northbeam/` mirroring the src path).

---

## Task 1: Project scaffolding

**Files:**
- Create: `gantri-ai-bot/package.json`
- Create: `gantri-ai-bot/tsconfig.json`
- Create: `gantri-ai-bot/vitest.config.ts`
- Create: `gantri-ai-bot/.eslintrc.cjs`
- Create: `gantri-ai-bot/.prettierrc`
- Create: `gantri-ai-bot/.env.example`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "gantri-ai-bot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.0.0" },
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src tests --ext .ts",
    "format": "prettier --write 'src/**/*.ts' 'tests/**/*.ts'"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.0",
    "@slack/bolt": "^3.19.0",
    "@supabase/supabase-js": "^2.45.0",
    "pino": "^9.4.0",
    "playwright": "^1.47.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@typescript-eslint/eslint-plugin": "^8.6.0",
    "@typescript-eslint/parser": "^8.6.0",
    "eslint": "^9.10.0",
    "msw": "^2.4.0",
    "prettier": "^3.3.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": false,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
```

- [ ] **Step 4: Create `.eslintrc.cjs`**

```js
module.exports = {
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  env: { node: true, es2022: true },
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
  },
};
```

- [ ] **Step 5: Create `.prettierrc`**

```json
{
  "singleQuote": true,
  "semi": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

- [ ] **Step 6: Create `.env.example`**

```
# Supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...

# Optional
LOG_LEVEL=info
DEBUG_FULL_LOGS=false
PORT=3000
```

- [ ] **Step 7: Install and verify**

```bash
cd gantri-ai-bot
npm install
npm run typecheck
```

Expected: `npm install` completes; `npm run typecheck` prints nothing (no source files yet) or reports 0 errors.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .eslintrc.cjs .prettierrc .env.example
git commit -m "chore: project scaffolding (TS, Vitest, ESLint)"
```

---

## Task 2: Database migration 0001

**Files:**
- Create: `gantri-ai-bot/migrations/0001_initial.sql`
- Create: `gantri-ai-bot/migrations/README.md`

- [ ] **Step 1: Create `migrations/0001_initial.sql`**

```sql
-- gantri-ai-bot initial schema

create table if not exists authorized_users (
  slack_user_id text primary key,
  slack_workspace_id text not null,
  email text,
  role text not null default 'user' check (role in ('user','admin')),
  created_at timestamptz not null default now()
);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  slack_thread_ts text not null,
  slack_channel_id text not null,
  slack_user_id text references authorized_users(slack_user_id),
  question text not null,
  tool_calls jsonb,
  response text,
  model text,
  tokens_input int,
  tokens_output int,
  duration_ms int,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists conversations_thread_idx on conversations (slack_thread_ts);
create index if not exists conversations_created_idx on conversations (created_at);

create table if not exists northbeam_cache (
  cache_key text primary key,
  response jsonb not null,
  expires_at timestamptz not null
);
create index if not exists northbeam_cache_expires_idx on northbeam_cache (expires_at);

create table if not exists northbeam_tokens (
  id int primary key default 1 check (id = 1),
  access_token_encrypted text not null,
  expires_at timestamptz not null,
  last_refresh_method text check (last_refresh_method in ('ropc','playwright')),
  refreshed_at timestamptz not null default now()
);
```

- [ ] **Step 2: Create `migrations/README.md`**

```markdown
# Database migrations

Apply manually against the Supabase project via SQL Editor or `supabase db push`.

Order matters: run files in numeric order (`0001_*`, `0002_*`, ...).

## Vault secrets

This project relies on secrets stored in Supabase Vault. To create them, run in the SQL Editor:

```sql
select vault.create_secret('danny@gantri.com',     'NORTHBEAM_EMAIL');
select vault.create_secret('G@ntriSecure',         'NORTHBEAM_PASSWORD');
select vault.create_secret('1aaaa257-60a3-4fd7-a99e-7886894240d3', 'NORTHBEAM_DASHBOARD_ID');
```

(Values are placeholders in this README; actual values live only in Supabase Vault.)
```

- [ ] **Step 3: Apply migration manually**

Open Supabase SQL Editor → paste contents of `migrations/0001_initial.sql` → Run. Verify the four tables exist via Table Editor.

- [ ] **Step 4: Commit**

```bash
git add migrations/
git commit -m "db: initial schema (authorized_users, conversations, northbeam_cache, northbeam_tokens)"
```

---

## Task 3: Env config loader

**Files:**
- Create: `src/config/env.ts`
- Create: `tests/unit/env.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/unit/env.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

describe('loadEnv', () => {
  const validEnv = {
    SUPABASE_URL: 'https://abc.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    ANTHROPIC_API_KEY: 'sk-ant-xxx',
    SLACK_BOT_TOKEN: 'xoxb-xxx',
    SLACK_SIGNING_SECRET: 'secret',
  };

  it('parses required vars and defaults optional ones', () => {
    const env = loadEnv(validEnv);
    expect(env.SUPABASE_URL).toBe('https://abc.supabase.co');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.DEBUG_FULL_LOGS).toBe(false);
    expect(env.PORT).toBe(3000);
  });

  it('throws when a required var is missing', () => {
    const { SUPABASE_URL: _, ...partial } = validEnv;
    expect(() => loadEnv(partial)).toThrow(/SUPABASE_URL/);
  });

  it('coerces DEBUG_FULL_LOGS=true (string) to boolean true', () => {
    const env = loadEnv({ ...validEnv, DEBUG_FULL_LOGS: 'true' });
    expect(env.DEBUG_FULL_LOGS).toBe(true);
  });
});
```

- [ ] **Step 2: Run test** — expect FAIL

```bash
npx vitest run tests/unit/env.test.ts
```

Expected: test file fails because `src/config/env.ts` does not exist.

- [ ] **Step 3: Implement `src/config/env.ts`**

```ts
import { z } from 'zod';

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_SIGNING_SECRET: z.string().min(1),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  DEBUG_FULL_LOGS: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true')
    .default(false),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, unknown> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const msg = result.error.errors
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${msg}`);
  }
  return result.data;
}
```

- [ ] **Step 4: Run tests** — expect PASS

```bash
npx vitest run tests/unit/env.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts tests/unit/env.test.ts
git commit -m "feat(config): zod-parsed env loader"
```

---

## Task 4: Structured logger

**Files:**
- Create: `src/logger.ts`

- [ ] **Step 1: Implement `src/logger.ts`**

```ts
import pino from 'pino';
import { loadEnv } from './config/env.js';

const env = loadEnv();

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'gantri-ai-bot' },
  redact: {
    paths: [
      '*.authorization',
      '*.access_token',
      '*.access_token_encrypted',
      'password',
      'email',
      'SLACK_BOT_TOKEN',
      'SLACK_SIGNING_SECRET',
      'ANTHROPIC_API_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
    ],
    censor: '[REDACTED]',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
});

export type Logger = typeof logger;
```

- [ ] **Step 2: Smoke-test manually**

```bash
SUPABASE_URL=https://x.supabase.co SUPABASE_SERVICE_ROLE_KEY=x ANTHROPIC_API_KEY=x SLACK_BOT_TOKEN=x SLACK_SIGNING_SECRET=x \
  npx tsx -e "import('./src/logger.js').then(({logger})=>logger.info({password:'secret'},'hello'))"
```

Expected: JSON line with `"msg":"hello"`, `"password":"[REDACTED]"`, level `"info"`.

- [ ] **Step 3: Commit**

```bash
git add src/logger.ts
git commit -m "feat(logger): pino logger with secret redaction"
```

---

## Task 5: Supabase client + Vault helper

**Files:**
- Create: `src/storage/supabase.ts`
- Create: `tests/unit/storage/supabase.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/unit/storage/supabase.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readVaultSecret } from '../../../src/storage/supabase.js';

describe('readVaultSecret', () => {
  it('returns decrypted_secret from vault.decrypted_secrets', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'danny@gantri.com', error: null });
    const fakeClient: any = { rpc };
    const value = await readVaultSecret(fakeClient, 'NORTHBEAM_EMAIL');
    expect(value).toBe('danny@gantri.com');
    expect(rpc).toHaveBeenCalledWith('read_vault_secret', { secret_name: 'NORTHBEAM_EMAIL' });
  });

  it('throws when vault call errors', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'nope' } });
    const fakeClient: any = { rpc };
    await expect(readVaultSecret(fakeClient, 'NORTHBEAM_EMAIL')).rejects.toThrow(/nope/);
  });

  it('throws when secret does not exist', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const fakeClient: any = { rpc };
    await expect(readVaultSecret(fakeClient, 'MISSING')).rejects.toThrow(/MISSING/);
  });
});
```

- [ ] **Step 2: Run test** — expect FAIL

```bash
npx vitest run tests/unit/storage/supabase.test.ts
```

Expected: file not found.

- [ ] **Step 3: Implement `src/storage/supabase.ts`**

```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadEnv } from '../config/env.js';

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;
  const env = loadEnv();
  _client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  return _client;
}

/**
 * Reads a secret from Supabase Vault.
 * Requires a SECURITY DEFINER helper `read_vault_secret(secret_name text)` in the DB:
 *   create or replace function read_vault_secret(secret_name text) returns text
 *   language plpgsql security definer as $$
 *     declare v text;
 *     begin
 *       select decrypted_secret into v from vault.decrypted_secrets where name = secret_name;
 *       return v;
 *     end $$;
 *   grant execute on function read_vault_secret(text) to service_role;
 */
export async function readVaultSecret(
  client: SupabaseClient,
  name: string,
): Promise<string> {
  const { data, error } = await client.rpc('read_vault_secret', { secret_name: name });
  if (error) throw new Error(`Vault read failed for ${name}: ${error.message}`);
  if (!data) throw new Error(`Vault secret ${name} not found`);
  return data as string;
}
```

- [ ] **Step 4: Add the `read_vault_secret` helper to migrations**

Append to `migrations/0001_initial.sql`:

```sql
-- Vault helper: read a decrypted secret from a server role context.
create or replace function read_vault_secret(secret_name text) returns text
language plpgsql security definer as $$
  declare v text;
  begin
    select decrypted_secret into v from vault.decrypted_secrets where name = secret_name;
    return v;
  end $$;
grant execute on function read_vault_secret(text) to service_role;
```

Re-run the SQL in Supabase SQL Editor to create the function.

- [ ] **Step 5: Run tests** — expect PASS

```bash
npx vitest run tests/unit/storage/supabase.test.ts
```

Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add src/storage/supabase.ts tests/unit/storage/supabase.test.ts migrations/0001_initial.sql
git commit -m "feat(storage): supabase client + vault secret reader"
```

---

## Task 6: Connector base interface + registry

**Files:**
- Create: `src/connectors/base/connector.ts`
- Create: `src/connectors/base/registry.ts`
- Create: `tests/unit/connector-registry.test.ts`

- [ ] **Step 1: Create `src/connectors/base/connector.ts`**

```ts
import type { z } from 'zod';

export interface ToolDef<TArgs = unknown, TResult = unknown> {
  /** Fully-qualified name, e.g. "northbeam.sales". */
  name: string;
  /** Human-readable description passed to the LLM. */
  description: string;
  /** Zod schema validating the args object. */
  schema: z.ZodType<TArgs>;
  /** JSON Schema representation of `schema`, for the Claude tool manifest. */
  jsonSchema: Record<string, unknown>;
  /** Executes the tool with validated args. */
  execute(args: TArgs): Promise<TResult>;
}

export interface Connector {
  readonly name: string;
  readonly tools: readonly ToolDef[];
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}
```

- [ ] **Step 2: Write the failing test for registry** — `tests/unit/connector-registry.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { Connector, ToolDef } from '../../src/connectors/base/connector.js';
import { ConnectorRegistry } from '../../src/connectors/base/registry.js';

function fakeTool(name: string, execute = vi.fn()): ToolDef {
  return {
    name,
    description: `tool ${name}`,
    schema: z.object({}).passthrough(),
    jsonSchema: { type: 'object' },
    execute,
  };
}

function fakeConnector(name: string, tools: ToolDef[]): Connector {
  return {
    name,
    tools,
    async healthCheck() { return { ok: true }; },
  };
}

describe('ConnectorRegistry', () => {
  it('collects tools across connectors by qualified name', () => {
    const r = new ConnectorRegistry();
    r.register(fakeConnector('a', [fakeTool('a.one'), fakeTool('a.two')]));
    r.register(fakeConnector('b', [fakeTool('b.one')]));
    expect(r.getAllTools().map((t) => t.name).sort()).toEqual(['a.one', 'a.two', 'b.one']);
  });

  it('executes by qualified name', async () => {
    const exec = vi.fn().mockResolvedValue({ ok: true, data: 42 });
    const r = new ConnectorRegistry();
    r.register(fakeConnector('x', [fakeTool('x.go', exec)]));
    const result = await r.execute('x.go', { foo: 'bar' });
    expect(result).toEqual({ ok: true, data: 42 });
    expect(exec).toHaveBeenCalledWith({ foo: 'bar' });
  });

  it('returns an error result when tool does not exist', async () => {
    const r = new ConnectorRegistry();
    const result = await r.execute('missing.tool', {});
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TOOL_NOT_FOUND');
  });

  it('returns an error result when args fail schema validation', async () => {
    const schema = z.object({ n: z.number() });
    const tool: ToolDef<{ n: number }> = {
      name: 't.strict',
      description: '',
      schema,
      jsonSchema: {},
      execute: vi.fn(),
    };
    const r = new ConnectorRegistry();
    r.register(fakeConnector('t', [tool as ToolDef]));
    const result = await r.execute('t.strict', { n: 'not-a-number' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_ARGS');
  });

  it('refuses duplicate connector names', () => {
    const r = new ConnectorRegistry();
    r.register(fakeConnector('dup', []));
    expect(() => r.register(fakeConnector('dup', []))).toThrow(/already registered/);
  });
});
```

- [ ] **Step 3: Run test** — expect FAIL

```bash
npx vitest run tests/unit/connector-registry.test.ts
```

Expected: cannot resolve `registry.ts`.

- [ ] **Step 4: Implement `src/connectors/base/registry.ts`**

```ts
import type { Connector, ToolDef, ToolResult } from './connector.js';

export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>();
  private readonly tools = new Map<string, ToolDef>();

  register(connector: Connector): void {
    if (this.connectors.has(connector.name)) {
      throw new Error(`Connector '${connector.name}' already registered`);
    }
    this.connectors.set(connector.name, connector);
    for (const tool of connector.tools) {
      if (this.tools.has(tool.name)) {
        throw new Error(`Tool '${tool.name}' already registered`);
      }
      this.tools.set(tool.name, tool);
    }
  }

  getAllTools(): ToolDef[] {
    return [...this.tools.values()];
  }

  getConnectors(): Connector[] {
    return [...this.connectors.values()];
  }

  async execute(toolName: string, rawArgs: unknown): Promise<ToolResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return { ok: false, error: { code: 'TOOL_NOT_FOUND', message: `Unknown tool: ${toolName}` } };
    }
    const parsed = tool.schema.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        ok: false,
        error: { code: 'INVALID_ARGS', message: parsed.error.message },
      };
    }
    try {
      const data = await tool.execute(parsed.data);
      // If the tool already returned a ToolResult, pass it through.
      if (
        data &&
        typeof data === 'object' &&
        'ok' in (data as Record<string, unknown>)
      ) {
        return data as ToolResult;
      }
      return { ok: true, data };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'TOOL_EXEC_FAILED',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}
```

- [ ] **Step 5: Run tests** — expect PASS

```bash
npx vitest run tests/unit/connector-registry.test.ts
```

Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add src/connectors/base tests/unit/connector-registry.test.ts
git commit -m "feat(connectors): base Connector interface + registry"
```

---

## Task 7: TTL cache over Postgres

**Files:**
- Create: `src/storage/cache.ts`
- Create: `tests/unit/cache.test.ts`
- Create: `tests/setup.ts` (if not yet)

- [ ] **Step 1: Create `tests/setup.ts`**

```ts
// Ensures required env vars exist for modules that call loadEnv().
process.env.SUPABASE_URL ??= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-key';
process.env.ANTHROPIC_API_KEY ??= 'test-ant';
process.env.SLACK_BOT_TOKEN ??= 'xoxb-test';
process.env.SLACK_SIGNING_SECRET ??= 'test-sig';
process.env.LOG_LEVEL ??= 'silent';
```

- [ ] **Step 2: Write the failing test** — `tests/unit/cache.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest';
import { TtlCache } from '../../src/storage/cache.js';

function makeClient() {
  const store = new Map<string, { response: unknown; expires_at: string }>();
  return {
    store,
    client: {
      from(_: string) {
        return {
          select(_cols: string) {
            return {
              eq(_c: string, key: string) {
                return {
                  gt(_col: string, nowIso: string) {
                    return {
                      maybeSingle() {
                        const row = store.get(key);
                        if (row && row.expires_at > nowIso) {
                          return Promise.resolve({ data: row, error: null });
                        }
                        return Promise.resolve({ data: null, error: null });
                      },
                    };
                  },
                };
              },
            };
          },
          upsert(row: any) {
            store.set(row.cache_key, { response: row.response, expires_at: row.expires_at });
            return Promise.resolve({ error: null });
          },
        };
      },
    } as any,
  };
}

describe('TtlCache', () => {
  it('returns undefined on miss', async () => {
    const { client } = makeClient();
    const c = new TtlCache(client);
    expect(await c.get('k')).toBeUndefined();
  });

  it('stores and retrieves a value within TTL', async () => {
    const { client } = makeClient();
    const c = new TtlCache(client);
    await c.set('k', { x: 1 }, 60);
    expect(await c.get('k')).toEqual({ x: 1 });
  });

  it('returns undefined once TTL has elapsed', async () => {
    const { client, store } = makeClient();
    const c = new TtlCache(client);
    await c.set('k', { x: 1 }, 60);
    // Manually fast-forward the stored expiry into the past.
    const row = store.get('k')!;
    row.expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await c.get('k')).toBeUndefined();
  });

  it('key() produces stable hash for equivalent inputs regardless of key order', () => {
    const a = TtlCache.key('Op', { b: 2, a: 1 });
    const b = TtlCache.key('Op', { a: 1, b: 2 });
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 3: Run test** — expect FAIL

```bash
npx vitest run tests/unit/cache.test.ts
```

Expected: cannot resolve `cache.js`.

- [ ] **Step 4: Implement `src/storage/cache.ts`**

```ts
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export class TtlCache {
  constructor(private readonly client: SupabaseClient) {}

  static key(operationName: string, variables: Record<string, unknown>): string {
    const stable = stableStringify({ op: operationName, vars: variables });
    return createHash('sha256').update(stable).digest('hex');
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const nowIso = new Date().toISOString();
    const { data, error } = await this.client
      .from('northbeam_cache')
      .select('response,expires_at')
      .eq('cache_key', key)
      .gt('expires_at', nowIso)
      .maybeSingle();
    if (error) throw new Error(`Cache read failed: ${error.message}`);
    return (data?.response as T | undefined) ?? undefined;
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const { error } = await this.client
      .from('northbeam_cache')
      .upsert({ cache_key: key, response: value, expires_at: expiresAt });
    if (error) throw new Error(`Cache write failed: ${error.message}`);
  }
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + stableStringify((v as Record<string, unknown>)[k])).join(',') +
    '}'
  );
}
```

- [ ] **Step 5: Run tests** — expect PASS

```bash
npx vitest run tests/unit/cache.test.ts
```

Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add src/storage/cache.ts tests/unit/cache.test.ts tests/setup.ts
git commit -m "feat(storage): TTL cache over northbeam_cache table"
```

---

## Task 8: Repositories (authorized_users, conversations, northbeam_tokens)

**Files:**
- Create: `src/storage/repositories/authorized-users.ts`
- Create: `src/storage/repositories/conversations.ts`
- Create: `src/storage/repositories/northbeam-tokens.ts`
- Create: `tests/unit/storage/repositories.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/unit/storage/repositories.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest';
import { AuthorizedUsersRepo } from '../../../src/storage/repositories/authorized-users.js';
import { ConversationsRepo } from '../../../src/storage/repositories/conversations.js';
import { NorthbeamTokensRepo } from '../../../src/storage/repositories/northbeam-tokens.js';

function clientWithTable(handlers: Record<string, any>) {
  return {
    from(table: string) {
      return handlers[table] ?? {};
    },
  } as any;
}

describe('AuthorizedUsersRepo', () => {
  it('isAuthorized returns true when the user exists', async () => {
    const client = clientWithTable({
      authorized_users: {
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: { slack_user_id: 'U1' }, error: null }) }),
        }),
      },
    });
    const repo = new AuthorizedUsersRepo(client);
    expect(await repo.isAuthorized('U1')).toBe(true);
  });

  it('isAuthorized returns false when no row is found', async () => {
    const client = clientWithTable({
      authorized_users: {
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
        }),
      },
    });
    const repo = new AuthorizedUsersRepo(client);
    expect(await repo.isAuthorized('U_unknown')).toBe(false);
  });
});

describe('ConversationsRepo', () => {
  it('insert stores the row and returns its id', async () => {
    const insert = vi.fn().mockReturnValue({
      select: () => ({ single: () => Promise.resolve({ data: { id: 'uuid-1' }, error: null }) }),
    });
    const client = clientWithTable({ conversations: { insert } });
    const repo = new ConversationsRepo(client);
    const id = await repo.insert({
      slack_thread_ts: 'ts', slack_channel_id: 'C', slack_user_id: 'U', question: 'q',
    });
    expect(id).toBe('uuid-1');
    expect(insert).toHaveBeenCalled();
  });
});

describe('NorthbeamTokensRepo', () => {
  it('get returns null when no token row exists', async () => {
    const client = clientWithTable({
      northbeam_tokens: {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
      },
    });
    const repo = new NorthbeamTokensRepo(client);
    expect(await repo.get()).toBeNull();
  });

  it('upsert writes the singleton row', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const client = clientWithTable({ northbeam_tokens: { upsert } });
    const repo = new NorthbeamTokensRepo(client);
    await repo.upsert({
      access_token_encrypted: 'abc',
      expires_at: new Date().toISOString(),
      last_refresh_method: 'ropc',
    });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 1, access_token_encrypted: 'abc' }));
  });
});
```

- [ ] **Step 2: Implement `src/storage/repositories/authorized-users.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js';

export class AuthorizedUsersRepo {
  constructor(private readonly client: SupabaseClient) {}

  async isAuthorized(slackUserId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from('authorized_users')
      .select('slack_user_id')
      .eq('slack_user_id', slackUserId)
      .maybeSingle();
    if (error) throw new Error(`authorized_users read failed: ${error.message}`);
    return !!data;
  }
}
```

- [ ] **Step 3: Implement `src/storage/repositories/conversations.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js';

export interface ConversationInsert {
  slack_thread_ts: string;
  slack_channel_id: string;
  slack_user_id: string;
  question: string;
  tool_calls?: unknown;
  response?: string;
  model?: string;
  tokens_input?: number;
  tokens_output?: number;
  duration_ms?: number;
  error?: string;
}

export class ConversationsRepo {
  constructor(private readonly client: SupabaseClient) {}

  async insert(row: ConversationInsert): Promise<string> {
    const { data, error } = await this.client
      .from('conversations')
      .insert(row)
      .select('id')
      .single();
    if (error) throw new Error(`conversations insert failed: ${error.message}`);
    return data.id as string;
  }

  async loadRecentByThread(threadTs: string, limit = 10): Promise<Array<{ question: string; response: string | null }>> {
    const { data, error } = await this.client
      .from('conversations')
      .select('question,response')
      .eq('slack_thread_ts', threadTs)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) throw new Error(`conversations read failed: ${error.message}`);
    return (data ?? []) as Array<{ question: string; response: string | null }>;
  }
}
```

- [ ] **Step 4: Implement `src/storage/repositories/northbeam-tokens.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js';

export interface TokenRow {
  access_token_encrypted: string;
  expires_at: string;
  last_refresh_method: 'ropc' | 'playwright';
}

export class NorthbeamTokensRepo {
  constructor(private readonly client: SupabaseClient) {}

  async get(): Promise<TokenRow | null> {
    const { data, error } = await this.client
      .from('northbeam_tokens')
      .select('access_token_encrypted,expires_at,last_refresh_method')
      .eq('id', 1)
      .maybeSingle();
    if (error) throw new Error(`northbeam_tokens read failed: ${error.message}`);
    return (data as TokenRow | null) ?? null;
  }

  async upsert(row: TokenRow): Promise<void> {
    const { error } = await this.client
      .from('northbeam_tokens')
      .upsert({ id: 1, ...row });
    if (error) throw new Error(`northbeam_tokens upsert failed: ${error.message}`);
  }
}
```

- [ ] **Step 5: Run tests** — expect PASS

```bash
npx vitest run tests/unit/storage/repositories.test.ts
```

Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add src/storage/repositories tests/unit/storage/repositories.test.ts
git commit -m "feat(storage): repositories for authorized_users, conversations, northbeam_tokens"
```

---

## Task 9: Northbeam GraphQL client

**Files:**
- Create: `src/connectors/northbeam/graphql-client.ts`
- Create: `tests/unit/northbeam/graphql-client.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/unit/northbeam/graphql-client.test.ts`

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NorthbeamGraphqlClient } from '../../../src/connectors/northbeam/graphql-client.js';

describe('NorthbeamGraphqlClient', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it('sends required headers and returns data on success', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer jwt-xxx');
      expect(headers.get('x-nb-dashboard-id')).toBe('ws-1');
      expect(headers.get('x-nb-impersonate-user')).toBe('ws-1');
      expect(headers.get('content-type')).toBe('application/json');
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    });
    globalThis.fetch = fetchMock as any;

    const client = new NorthbeamGraphqlClient({
      getToken: async () => 'jwt-xxx',
      dashboardId: 'ws-1',
    });
    const data = await client.request<{ ok: boolean }>('MyOp', 'query MyOp { me { id } }', { a: 1 });
    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when response contains GraphQL errors', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ errors: [{ message: 'boom' }] }), { status: 200 }),
    ) as any;
    const client = new NorthbeamGraphqlClient({
      getToken: async () => 'jwt',
      dashboardId: 'ws',
    });
    await expect(client.request('Op', 'query { x }', {})).rejects.toThrow(/boom/);
  });

  it('throws with HTTP status when non-2xx', async () => {
    globalThis.fetch = vi.fn(async () => new Response('unauthorized', { status: 401 })) as any;
    const client = new NorthbeamGraphqlClient({
      getToken: async () => 'jwt',
      dashboardId: 'ws',
    });
    await expect(client.request('Op', 'query { x }', {})).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Implement `src/connectors/northbeam/graphql-client.ts`**

```ts
export interface GraphqlClientOptions {
  endpoint?: string;
  getToken: () => Promise<string>;
  dashboardId: string;
}

export class NorthbeamGraphqlClient {
  private readonly endpoint: string;

  constructor(private readonly opts: GraphqlClientOptions) {
    this.endpoint = opts.endpoint ?? 'https://dashboard-api.northbeam.io/api/graphql';
  }

  async request<T = unknown>(
    operationName: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const token = await this.opts.getToken();
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-nb-dashboard-id': this.opts.dashboardId,
        'x-nb-impersonate-user': this.opts.dashboardId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ operationName, query, variables }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Northbeam GraphQL HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors?.length) {
      throw new Error(`Northbeam GraphQL error: ${body.errors.map((e) => e.message).join('; ')}`);
    }
    if (!body.data) throw new Error('Northbeam GraphQL returned no data');
    return body.data;
  }
}
```

- [ ] **Step 3: Run tests** — expect PASS

```bash
npx vitest run tests/unit/northbeam/graphql-client.test.ts
```

Expected: 3 passed.

- [ ] **Step 4: Commit**

```bash
git add src/connectors/northbeam/graphql-client.ts tests/unit/northbeam/graphql-client.test.ts
git commit -m "feat(northbeam): minimal GraphQL client with required headers"
```

---

## Task 10: Northbeam Auth Manager — ROPC attempt

**Files:**
- Create: `src/connectors/northbeam/auth-manager.ts`
- Create: `tests/unit/northbeam/auth-manager.test.ts`

This task implements the happy path (ROPC) and the token-caching logic. Playwright fallback is added in Task 11.

- [ ] **Step 1: Write the failing test** — `tests/unit/northbeam/auth-manager.test.ts`

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NorthbeamAuthManager } from '../../../src/connectors/northbeam/auth-manager.js';

function makeValidJwt(expSecondsFromNow: number) {
  const payload = { exp: Math.floor(Date.now() / 1000) + expSecondsFromNow };
  const b64 = (s: string) => Buffer.from(s).toString('base64url');
  return `${b64('{}')}.${b64(JSON.stringify(payload))}.sig`;
}

describe('NorthbeamAuthManager (ROPC)', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  function makeRepo() {
    let row: any = null;
    return {
      get: vi.fn(async () => row),
      upsert: vi.fn(async (r: any) => { row = r; }),
      _peek: () => row,
    };
  }

  it('fetches a token via ROPC and stores it', async () => {
    const jwt = makeValidJwt(3600);
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('auth.northbeam.io/oauth/token');
      const body = JSON.parse(init!.body as string);
      expect(body.grant_type).toBe('password');
      expect(body.username).toBe('danny@gantri.com');
      return new Response(JSON.stringify({ access_token: jwt, expires_in: 3600 }), { status: 200 });
    }) as any;

    const repo = makeRepo();
    const mgr = new NorthbeamAuthManager({
      credentials: { email: 'danny@gantri.com', password: 'pw', dashboardId: 'ws' },
      tokensRepo: repo as any,
      playwrightLogin: vi.fn(),
    });
    const token = await mgr.getAccessToken();
    expect(token).toBe(jwt);
    expect(repo.upsert).toHaveBeenCalledOnce();
    expect(repo._peek().last_refresh_method).toBe('ropc');
  });

  it('reuses cached token when not near expiry', async () => {
    const jwt = makeValidJwt(7200); // 2h left
    const repo = makeRepo();
    await repo.upsert({
      access_token_encrypted: jwt,
      expires_at: new Date(Date.now() + 7200 * 1000).toISOString(),
      last_refresh_method: 'ropc',
    });
    globalThis.fetch = vi.fn(); // should not be called

    const mgr = new NorthbeamAuthManager({
      credentials: { email: 'x', password: 'y', dashboardId: 'ws' },
      tokensRepo: repo as any,
      playwrightLogin: vi.fn(),
    });
    const token = await mgr.getAccessToken();
    expect(token).toBe(jwt);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('refreshes when cached token is near expiry (<15 min)', async () => {
    const oldJwt = makeValidJwt(600); // 10 min left
    const newJwt = makeValidJwt(3600);
    const repo = makeRepo();
    await repo.upsert({
      access_token_encrypted: oldJwt,
      expires_at: new Date(Date.now() + 600 * 1000).toISOString(),
      last_refresh_method: 'ropc',
    });
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: newJwt, expires_in: 3600 }), { status: 200 }),
    ) as any;

    const mgr = new NorthbeamAuthManager({
      credentials: { email: 'x', password: 'y', dashboardId: 'ws' },
      tokensRepo: repo as any,
      playwrightLogin: vi.fn(),
    });
    const token = await mgr.getAccessToken();
    expect(token).toBe(newJwt);
  });

  it('falls back to playwrightLogin when ROPC returns 403', async () => {
    const jwt = makeValidJwt(3600);
    globalThis.fetch = vi.fn(async () => new Response('forbidden', { status: 403 })) as any;
    const playwrightLogin = vi.fn(async () => ({ accessToken: jwt, expiresIn: 3600 }));
    const repo = makeRepo();

    const mgr = new NorthbeamAuthManager({
      credentials: { email: 'x', password: 'y', dashboardId: 'ws' },
      tokensRepo: repo as any,
      playwrightLogin,
    });
    const token = await mgr.getAccessToken();
    expect(token).toBe(jwt);
    expect(playwrightLogin).toHaveBeenCalledOnce();
    expect(repo._peek().last_refresh_method).toBe('playwright');
  });
});
```

- [ ] **Step 2: Implement `src/connectors/northbeam/auth-manager.ts`**

```ts
import type { NorthbeamTokensRepo, TokenRow } from '../../storage/repositories/northbeam-tokens.js';

const AUTH0_ENDPOINT = 'https://auth.northbeam.io/oauth/token';
const AUTH0_CLIENT_ID = 'SAwznFb2ZPmCiduOv0lKqZ55o5155cD8';
const AUTH0_AUDIENCE = 'https://api.northbeam.io';
const REFRESH_BUFFER_SECONDS = 15 * 60; // refresh if <15 min left

export interface Credentials {
  email: string;
  password: string;
  dashboardId: string;
}

export interface PlaywrightLogin {
  (creds: Credentials): Promise<{ accessToken: string; expiresIn: number }>;
}

export interface AuthManagerOptions {
  credentials: Credentials;
  tokensRepo: NorthbeamTokensRepo;
  playwrightLogin: PlaywrightLogin;
}

export class NorthbeamAuthManager {
  private inflight: Promise<string> | null = null;

  constructor(private readonly opts: AuthManagerOptions) {}

  async getAccessToken(): Promise<string> {
    // Cached row still fresh?
    const cached = await this.opts.tokensRepo.get();
    if (cached && !this.isNearExpiry(cached.expires_at)) {
      return cached.access_token_encrypted;
    }
    // De-dupe concurrent refreshes.
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private isNearExpiry(expiresAtIso: string): boolean {
    const msLeft = new Date(expiresAtIso).getTime() - Date.now();
    return msLeft < REFRESH_BUFFER_SECONDS * 1000;
  }

  private async refresh(): Promise<string> {
    const fromRopc = await this.tryRopc();
    if (fromRopc) {
      await this.store(fromRopc.accessToken, fromRopc.expiresIn, 'ropc');
      return fromRopc.accessToken;
    }
    const fromPw = await this.opts.playwrightLogin(this.opts.credentials);
    await this.store(fromPw.accessToken, fromPw.expiresIn, 'playwright');
    return fromPw.accessToken;
  }

  private async tryRopc(): Promise<{ accessToken: string; expiresIn: number } | null> {
    const res = await fetch(AUTH0_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        username: this.opts.credentials.email,
        password: this.opts.credentials.password,
        audience: AUTH0_AUDIENCE,
        client_id: AUTH0_CLIENT_ID,
        scope: 'openid profile email',
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token || !body.expires_in) return null;
    return { accessToken: body.access_token, expiresIn: body.expires_in };
  }

  private async store(
    accessToken: string,
    expiresIn: number,
    method: TokenRow['last_refresh_method'],
  ): Promise<void> {
    await this.opts.tokensRepo.upsert({
      access_token_encrypted: accessToken,
      expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      last_refresh_method: method,
    });
  }
}
```

> Note: the `access_token_encrypted` column holds the raw JWT for v1. The column name anticipates a future encryption-at-rest layer (Supabase Vault column-level encryption) but that's deferred — v1 relies on database access controls.

- [ ] **Step 3: Run tests** — expect PASS

```bash
npx vitest run tests/unit/northbeam/auth-manager.test.ts
```

Expected: 4 passed.

- [ ] **Step 4: Commit**

```bash
git add src/connectors/northbeam/auth-manager.ts tests/unit/northbeam/auth-manager.test.ts
git commit -m "feat(northbeam): auth manager with ROPC + Playwright fallback interface"
```

---

## Task 11: Playwright fallback login

**Files:**
- Create: `src/connectors/northbeam/playwright-login.ts`
- (Test: integration-only — expensive, skip in unit suite.)

- [ ] **Step 1: Implement `src/connectors/northbeam/playwright-login.ts`**

```ts
import { chromium } from 'playwright';
import type { Credentials, PlaywrightLogin } from './auth-manager.js';
import { logger } from '../../logger.js';

const LOGIN_URL_TEMPLATE =
  'https://dashboard.northbeam.io/{{dashboardId}}/overview';

/**
 * Drives the Auth0 Universal Login page with Playwright, then captures the
 * Auth0-issued JWT from the in-page XHR to `auth.northbeam.io/oauth/token`.
 *
 * Use only when ROPC is unavailable. Slow (~10-20s) and requires Chromium.
 */
export const playwrightLogin: PlaywrightLogin = async (creds: Credentials) => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const tokenPromise = page.waitForResponse(
      (r) => r.url().startsWith('https://auth.northbeam.io/oauth/token') && r.status() === 200,
      { timeout: 30_000 },
    );

    await page.goto(LOGIN_URL_TEMPLATE.replace('{{dashboardId}}', creds.dashboardId), {
      waitUntil: 'networkidle',
    });
    await page.locator('input[type="email"]').fill(creds.email);
    await page.locator('input[type="password"]').fill(creds.password);
    await page.locator('button[type="submit"]').click();

    const response = await tokenPromise;
    const body = (await response.json()) as { access_token: string; expires_in: number };
    logger.info('Northbeam login via Playwright succeeded');
    return { accessToken: body.access_token, expiresIn: body.expires_in };
  } finally {
    await browser.close();
  }
};
```

- [ ] **Step 2: Manual smoke test (optional, slow)**

```bash
# With valid creds exported in env:
npx tsx -e "import('./src/connectors/northbeam/playwright-login.js').then(async ({playwrightLogin}) => { const r = await playwrightLogin({email: process.env.NB_EMAIL, password: process.env.NB_PW, dashboardId: process.env.NB_DID}); console.log(r.expiresIn, r.accessToken.length); })"
```

Expected: prints `86400 <big-number>` within ~20s.

- [ ] **Step 3: Commit**

```bash
git add src/connectors/northbeam/playwright-login.ts
git commit -m "feat(northbeam): playwright login fallback"
```

---

## Task 12: Northbeam GraphQL operations (queries.ts)

**Files:**
- Create: `src/connectors/northbeam/queries.ts`

- [ ] **Step 1: Implement `src/connectors/northbeam/queries.ts`**

```ts
/**
 * Northbeam internal GraphQL operations.
 * Endpoint: POST https://dashboard-api.northbeam.io/api/graphql
 * Reverse-engineered 2026-04-24; see `reference_northbeam_api` memory.
 */

export const GET_OVERVIEW_METRICS_REPORT_V3 = `
query GetOverviewMetricsReportV3(
  $accountingMode: String!, $attributionModel: String!, $attributionWindow: String!,
  $level: String!, $timeGranularity: String!,
  $dateRange: SalesDateRangeInput!, $compareDateRange: SalesDateRangeInput,
  $dimensionIds: [String!]!, $metricIds: [String!]!,
  $breakdownFilters: [SalesTableReportV3BreakdownsFilterInput!],
  $advancedSearch: JSONObject, $sorting: [SalesSortingInput!]
) {
  me {
    overviewMetricsReportV3(
      accountingMode: $accountingMode, attributionModel: $attributionModel,
      attributionWindow: $attributionWindow, level: $level,
      timeGranularity: $timeGranularity, dateRange: $dateRange,
      compareDateRange: $compareDateRange, dimensionIds: $dimensionIds,
      metricIds: $metricIds, breakdownFilters: $breakdownFilters,
      advancedSearch: $advancedSearch, sorting: $sorting
    ) {
      rows
      summary { actual comparison }
    }
  }
}`;

export const GET_SALES_METRICS_REPORT_V4 = `
query GetSalesMetricsReportV4(
  $accountingMode: String!, $attributionModel: String!, $attributionWindow: String!,
  $level: String!, $timeGranularity: String!,
  $dateRange: SalesDateRangeInput!, $compareDateRange: SalesDateRangeInput,
  $dimensionIds: [String!]!, $metricIds: [String!]!,
  $advancedSearch: JSONObject,
  $breakdownFilters: [SalesTableReportV3BreakdownsFilterInput!],
  $universalBenchmarkBreakdownFilters: [SalesTableReportV3BreakdownsFilterInput!],
  $campaignHashFilters: [String!], $adsetHashFilters: [String!], $adHashFilters: [String!],
  $statusFilters: [String!],
  $metricFilters: [SalesMetricFilterInput!], $metricFiltersClauseType: String,
  $sorting: [SalesSortingInput!], $limit: Int, $offset: Int,
  $isSummary: Boolean, $summaryDimensionIds: [String!]
) {
  me {
    salesMetricsReportV4(
      accountingMode: $accountingMode, attributionModel: $attributionModel,
      attributionWindow: $attributionWindow, level: $level,
      timeGranularity: $timeGranularity, dateRange: $dateRange,
      compareDateRange: $compareDateRange, dimensionIds: $dimensionIds,
      metricIds: $metricIds, advancedSearch: $advancedSearch,
      breakdownFilters: $breakdownFilters,
      universalBenchmarkBreakdownFilters: $universalBenchmarkBreakdownFilters,
      campaignHashFilters: $campaignHashFilters, adsetHashFilters: $adsetHashFilters,
      adHashFilters: $adHashFilters, statusFilters: $statusFilters,
      metricFilters: $metricFilters, metricFiltersClauseType: $metricFiltersClauseType,
      sorting: $sorting, limit: $limit, offset: $offset,
      isSummary: $isSummary, summaryDimensionIds: $summaryDimensionIds
    ) {
      actual comparison
    }
  }
}`;

export const GET_SALES_METRICS_COUNT_V4 = `
query GetSalesMetricsCountV4(
  $accountingMode: String!, $attributionModel: String!, $attributionWindow: String!,
  $level: String!, $timeGranularity: String!,
  $dateRange: SalesDateRangeInput!, $compareDateRange: SalesDateRangeInput,
  $dimensionIds: [String!]!, $metricIds: [String!]!,
  $advancedSearch: JSONObject,
  $campaignHashFilters: [String!], $adsetHashFilters: [String!], $adHashFilters: [String!],
  $statusFilters: [String!],
  $breakdownFilters: [SalesTableReportV3BreakdownsFilterInput!],
  $universalBenchmarkBreakdownFilters: [SalesTableReportV3BreakdownsFilterInput!],
  $metricFilters: [SalesMetricFilterInput!], $metricFiltersClauseType: String
) {
  me {
    salesMetricsCountV4(
      accountingMode: $accountingMode, attributionModel: $attributionModel,
      attributionWindow: $attributionWindow, level: $level,
      timeGranularity: $timeGranularity, dateRange: $dateRange,
      compareDateRange: $compareDateRange, dimensionIds: $dimensionIds,
      statusFilters: $statusFilters, metricIds: $metricIds,
      advancedSearch: $advancedSearch,
      campaignHashFilters: $campaignHashFilters, adsetHashFilters: $adsetHashFilters,
      adHashFilters: $adHashFilters, breakdownFilters: $breakdownFilters,
      universalBenchmarkBreakdownFilters: $universalBenchmarkBreakdownFilters,
      metricFilters: $metricFilters, metricFiltersClauseType: $metricFiltersClauseType
    ) { total }
  }
}`;

export const GET_SALES_BREAKDOWN_CONFIGS = `
query GetSalesBreakdownConfigs {
  me {
    id
    salesBreakdownConfigs {
      key name
      choices { value label }
    }
  }
}`;

export const FETCH_PARTNERS_APEX_CONSENT = `
query FetchPartnersApexConsent {
  me {
    partnerApexConsent {
      partner permission hasConsent hasConnectedAccounts connectedAccountValidationWarning
    }
    isMetaCapiConfigured
  }
}`;
```

- [ ] **Step 2: Commit**

```bash
git add src/connectors/northbeam/queries.ts
git commit -m "feat(northbeam): GraphQL operation constants"
```

---

## Task 13: Metric & attribution catalog

**Files:**
- Create: `src/connectors/northbeam/catalog.ts`
- Create: `tests/unit/northbeam/catalog.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/unit/northbeam/catalog.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import {
  METRIC_CATALOG,
  ATTRIBUTION_MODELS,
  ATTRIBUTION_WINDOWS,
  ACCOUNTING_MODES,
  TIME_GRANULARITIES,
  SALES_LEVELS,
  describeCatalog,
} from '../../../src/connectors/northbeam/catalog.js';

describe('catalog', () => {
  it('includes core metric IDs', () => {
    const ids = METRIC_CATALOG.map((m) => m.id);
    for (const core of ['spend', 'rev', 'roas', 'cpm', 'ctr', 'visits']) {
      expect(ids).toContain(core);
    }
  });

  it('exposes fixed enumerations expected by the API', () => {
    expect(ATTRIBUTION_MODELS).toContain('linear');
    expect(ATTRIBUTION_WINDOWS).toContain('1');
    expect(ACCOUNTING_MODES).toContain('accrual');
    expect(TIME_GRANULARITIES).toContain('daily');
    expect(SALES_LEVELS).toContain('campaign');
  });

  it('describeCatalog returns a human-readable summary with each metric and its description', () => {
    const text = describeCatalog();
    expect(text).toContain('spend');
    expect(text).toContain('roas');
    expect(text).toMatch(/ROAS.*return/i);
  });
});
```

- [ ] **Step 2: Implement `src/connectors/northbeam/catalog.ts`**

```ts
export const ATTRIBUTION_MODELS = [
  'linear', 'first_click', 'clicks_only', 'northbeam_custom',
] as const;
export type AttributionModel = (typeof ATTRIBUTION_MODELS)[number];

export const ATTRIBUTION_WINDOWS = ['1', '7', '30'] as const;
export type AttributionWindow = (typeof ATTRIBUTION_WINDOWS)[number];

export const ACCOUNTING_MODES = ['accrual', 'cash'] as const;
export type AccountingMode = (typeof ACCOUNTING_MODES)[number];

export const TIME_GRANULARITIES = ['daily', 'weekly', 'monthly'] as const;
export type TimeGranularity = (typeof TIME_GRANULARITIES)[number];

export const SALES_LEVELS = ['campaign', 'adset', 'ad', 'platform'] as const;
export type SalesLevel = (typeof SALES_LEVELS)[number];

export interface MetricDef {
  id: string;
  label: string;
  description: string;
}

export const METRIC_CATALOG: MetricDef[] = [
  { id: 'spend', label: 'Spend', description: 'Marketing dollars spent.' },
  { id: 'rev', label: 'Revenue', description: 'Attributed revenue.' },
  { id: 'roas', label: 'ROAS', description: 'Return on ad spend (rev / spend).' },
  { id: 'roasFt', label: 'ROAS (First-touch)', description: 'Return on ad spend computed with a first-touch model.' },
  { id: 'roasLtv', label: 'ROAS (LTV)', description: 'Return on ad spend adjusted for lifetime value.' },
  { id: 'googleROAS', label: 'Google ROAS', description: 'ROAS as reported natively by Google Ads.' },
  { id: 'metaROAS7DClick1DView', label: 'Meta ROAS (7D Click, 1D View)', description: 'ROAS as reported by Meta with 7-day click / 1-day view attribution.' },
  { id: 'cpm', label: 'CPM', description: 'Cost per thousand impressions.' },
  { id: 'ctr', label: 'CTR', description: 'Click-through rate.' },
  { id: 'ecpc', label: 'eCPC', description: 'Effective cost per click.' },
  { id: 'ecpnv', label: 'eCPNV', description: 'Effective cost per new visitor.' },
  { id: 'ecr', label: 'ECR', description: 'E-commerce conversion rate (orders / visits).' },
  { id: 'visits', label: 'Visits', description: 'Session count from tracked sources.' },
  { id: 'percentageNewVisits', label: '% New visits', description: 'Share of visits from new users.' },
  { id: 'avgTouchpointsPerOrderNew', label: 'Avg touchpoints / new order', description: 'Average number of attributed touchpoints preceding a new-customer order.' },
  { id: 'cpo', label: 'CPO', description: 'Cost per order.' },
  { id: 'aov', label: 'AOV', description: 'Average order value.' },
  { id: 'orders', label: 'Orders', description: 'Attributed order count.' },
  { id: 'rev_new', label: 'New customer revenue', description: 'Revenue attributed to first-time customers.' },
  { id: 'rev_returning', label: 'Returning customer revenue', description: 'Revenue from repeat customers.' },
];

export function describeCatalog(): string {
  const metrics = METRIC_CATALOG
    .map((m) => `- \`${m.id}\` (${m.label}): ${m.description}`)
    .join('\n');
  return [
    'Available metricIds:',
    metrics,
    '',
    `Attribution models: ${ATTRIBUTION_MODELS.join(', ')}`,
    `Attribution windows (days, as string): ${ATTRIBUTION_WINDOWS.join(', ')}`,
    `Accounting modes: ${ACCOUNTING_MODES.join(', ')}`,
    `Time granularities: ${TIME_GRANULARITIES.join(', ')}`,
    `Sales levels: ${SALES_LEVELS.join(', ')}`,
  ].join('\n');
}
```

- [ ] **Step 3: Run tests** — expect PASS

```bash
npx vitest run tests/unit/northbeam/catalog.test.ts
```

Expected: 3 passed.

- [ ] **Step 4: Commit**

```bash
git add src/connectors/northbeam/catalog.ts tests/unit/northbeam/catalog.test.ts
git commit -m "feat(northbeam): metric & attribution catalog"
```

---

## Task 14: Northbeam tool definitions

**Files:**
- Create: `src/connectors/northbeam/tools.ts`
- Create: `tests/unit/northbeam/tools.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/unit/northbeam/tools.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest';
import { buildNorthbeamTools } from '../../../src/connectors/northbeam/tools.js';

function fakeDeps() {
  return {
    gql: { request: vi.fn() },
    cache: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) },
    nowISO: () => '2026-04-24T00:00:00.000Z',
  };
}

describe('northbeam tools', () => {
  it('overview normalizes actual + comparison summaries and rows', async () => {
    const deps = fakeDeps();
    deps.gql.request.mockResolvedValue({
      me: {
        overviewMetricsReportV3: {
          rows: [{ date: '2026-04-17', metrics: { spend: 100 } }],
          summary: {
            actual: [{ metrics: { spend: 700 } }],
            comparison: [{ metrics: { spend: 650 } }],
          },
        },
      },
    });
    const tools = buildNorthbeamTools(deps as any);
    const overview = tools.find((t) => t.name === 'northbeam.overview')!;
    const result = await overview.execute({
      dateRange: { startDate: '2026-04-17', endDate: '2026-04-23' },
      metrics: ['spend'],
      compareToPreviousPeriod: true,
    });
    expect(result).toMatchObject({
      summary: { actual: { spend: 700 }, comparison: { spend: 650 } },
      rows: [{ date: '2026-04-17', metrics: { spend: 100 } }],
    });
  });

  it('sales rejects unknown metric id via schema', async () => {
    const deps = fakeDeps();
    const tools = buildNorthbeamTools(deps as any);
    const sales = tools.find((t) => t.name === 'northbeam.sales')!;
    const parsed = sales.schema.safeParse({
      level: 'campaign',
      dateRange: { startDate: '2026-04-01', endDate: '2026-04-07' },
      metrics: ['not_a_metric'],
    });
    expect(parsed.success).toBe(false);
  });

  it('list_breakdowns returns a normalized map', async () => {
    const deps = fakeDeps();
    deps.gql.request.mockResolvedValue({
      me: {
        salesBreakdownConfigs: [
          { key: 'Platform (Northbeam)', name: 'Platform (Northbeam)', choices: [{ value: 'Google Ads', label: 'Google Ads' }] },
        ],
      },
    });
    const tools = buildNorthbeamTools(deps as any);
    const lb = tools.find((t) => t.name === 'northbeam.list_breakdowns')!;
    const out: any = await lb.execute({});
    expect(out.breakdowns['Platform (Northbeam)']).toEqual(['Google Ads']);
  });
});
```

- [ ] **Step 2: Implement `src/connectors/northbeam/tools.ts`**

```ts
import { z } from 'zod';
import type { ToolDef } from '../base/connector.js';
import type { NorthbeamGraphqlClient } from './graphql-client.js';
import type { TtlCache } from '../../storage/cache.js';
import {
  ACCOUNTING_MODES,
  ATTRIBUTION_MODELS,
  ATTRIBUTION_WINDOWS,
  METRIC_CATALOG,
  SALES_LEVELS,
  TIME_GRANULARITIES,
} from './catalog.js';
import {
  FETCH_PARTNERS_APEX_CONSENT,
  GET_OVERVIEW_METRICS_REPORT_V3,
  GET_SALES_BREAKDOWN_CONFIGS,
  GET_SALES_METRICS_COUNT_V4,
  GET_SALES_METRICS_REPORT_V4,
} from './queries.js';

export interface NorthbeamToolDeps {
  gql: NorthbeamGraphqlClient;
  cache: TtlCache;
  nowISO?: () => string;
}

const METRIC_IDS = METRIC_CATALOG.map((m) => m.id) as [string, ...string[]];

const DateRange = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const Common = {
  attributionModel: z.enum(ATTRIBUTION_MODELS).default('linear'),
  attributionWindow: z.enum(ATTRIBUTION_WINDOWS).default('1'),
  accountingMode: z.enum(ACCOUNTING_MODES).default('accrual'),
  timeGranularity: z.enum(TIME_GRANULARITIES).default('daily'),
};

// ---------------- overview ----------------

const OverviewArgs = z.object({
  dateRange: DateRange,
  metrics: z.array(z.enum(METRIC_IDS)).min(1).max(20),
  dimensions: z.array(z.string()).default(['date']),
  ...Common,
  compareToPreviousPeriod: z.boolean().default(true),
});
type OverviewArgs = z.infer<typeof OverviewArgs>;

function previousPeriod(range: { startDate: string; endDate: string }) {
  const start = new Date(range.startDate + 'T00:00:00Z').getTime();
  const end = new Date(range.endDate + 'T00:00:00Z').getTime();
  const span = end - start;
  const prevEnd = new Date(start - 24 * 3600 * 1000);
  const prevStart = new Date(prevEnd.getTime() - span);
  return {
    startDate: prevStart.toISOString().slice(0, 10),
    endDate: prevEnd.toISOString().slice(0, 10),
  };
}

function cacheTtl(dateRange: { endDate: string }, nowISO: () => string): number {
  const today = nowISO().slice(0, 10);
  const end = dateRange.endDate;
  const daysAgo = Math.floor(
    (new Date(today + 'T00:00:00Z').getTime() - new Date(end + 'T00:00:00Z').getTime()) / 86_400_000,
  );
  if (daysAgo <= 0) return 5 * 60;     // today: 5 min
  if (daysAgo <= 7) return 30 * 60;    // last 7d: 30 min
  return 24 * 60 * 60;                  // older: 24h
}

// ---------------- sales ----------------

const SalesArgs = z.object({
  level: z.enum(SALES_LEVELS),
  dateRange: DateRange,
  metrics: z.array(z.enum(METRIC_IDS)).min(1).max(20),
  breakdown: z.string().optional(),
  platformFilter: z.string().optional(),
  statusFilter: z.array(z.string()).optional(),
  sorting: z
    .array(z.object({ dimensionId: z.string(), order: z.enum(['asc', 'desc']) }))
    .optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
  ...Common,
  compareToPreviousPeriod: z.boolean().default(false),
});
type SalesArgs = z.infer<typeof SalesArgs>;

// ---------------- factory ----------------

export function buildNorthbeamTools(deps: NorthbeamToolDeps): ToolDef[] {
  const nowISO = deps.nowISO ?? (() => new Date().toISOString());

  const overview: ToolDef<OverviewArgs> = {
    name: 'northbeam.overview',
    description:
      'Returns high-level marketing metrics (spend, revenue, ROAS, etc.) for a date range, optionally compared against the previous period. Use for summary questions like "how much did we spend last week" or "what was ROAS yesterday".',
    schema: OverviewArgs,
    jsonSchema: zodToJsonSchema(OverviewArgs),
    async execute(args) {
      const variables = {
        ...args,
        dimensionIds: args.dimensions,
        metricIds: args.metrics,
        level: 'campaign',
        breakdownFilters: [],
        sorting: [{ dimensionId: args.dimensions[0] ?? 'date', order: 'asc' }],
        compareDateRange: args.compareToPreviousPeriod ? previousPeriod(args.dateRange) : null,
      };
      const key = `nb.overview:${JSON.stringify(variables)}`;
      const cached = await deps.cache.get(key);
      if (cached) return cached;
      const data = await deps.gql.request<{
        me: { overviewMetricsReportV3: { rows: unknown[]; summary: { actual: any[]; comparison: any[] | null } } };
      }>('GetOverviewMetricsReportV3', GET_OVERVIEW_METRICS_REPORT_V3, variables);
      const report = data.me.overviewMetricsReportV3;
      const result = {
        period: args.dateRange,
        comparePeriod: variables.compareDateRange,
        summary: {
          actual: report.summary.actual?.[0]?.metrics ?? {},
          comparison: report.summary.comparison?.[0]?.metrics ?? null,
        },
        rows: report.rows,
      };
      await deps.cache.set(key, result, cacheTtl(args.dateRange, nowISO));
      return result;
    },
  };

  const sales: ToolDef<SalesArgs> = {
    name: 'northbeam.sales',
    description:
      'Returns a granular performance table at campaign/adset/ad/platform level with rich metrics and optional breakdown by Platform (Northbeam) / Category / Targeting. Use for drill-down questions like "best campaigns last week" or "Meta ROAS by adset".',
    schema: SalesArgs,
    jsonSchema: zodToJsonSchema(SalesArgs),
    async execute(args) {
      const dimensionIds = ['name', 'campaignName'];
      if (args.breakdown) dimensionIds.push(`breakdown:${args.breakdown}`);
      const breakdownFilters = args.platformFilter
        ? [{ key: 'Platform (Northbeam)', values: [args.platformFilter] }]
        : [];
      const variables = {
        ...args,
        dimensionIds,
        metricIds: args.metrics,
        breakdownFilters,
        universalBenchmarkBreakdownFilters: [],
        metricFilters: [],
        statusFilters: args.statusFilter ?? null,
        sorting: args.sorting ?? [{ dimensionId: 'spend', order: 'desc' }],
        compareDateRange: args.compareToPreviousPeriod ? previousPeriod(args.dateRange) : null,
        isSummary: false,
        summaryDimensionIds: null,
        advancedSearch: null,
      };
      const key = `nb.sales:${JSON.stringify(variables)}`;
      const cached = await deps.cache.get(key);
      if (cached) return cached;
      const data = await deps.gql.request<{
        me: { salesMetricsReportV4: { actual: unknown[]; comparison: unknown[] | null } };
      }>('GetSalesMetricsReportV4', GET_SALES_METRICS_REPORT_V4, variables);
      const result = {
        period: args.dateRange,
        comparePeriod: variables.compareDateRange,
        rows: data.me.salesMetricsReportV4.actual,
        comparison: data.me.salesMetricsReportV4.comparison,
      };
      await deps.cache.set(key, result, cacheTtl(args.dateRange, nowISO));
      return result;
    },
  };

  const listBreakdowns: ToolDef<Record<string, never>> = {
    name: 'northbeam.list_breakdowns',
    description:
      'Lists available breakdown dimensions (e.g. Platform, Category) and their allowed values. Use before `northbeam.sales` with a breakdown to ground on valid keys.',
    schema: z.object({}).strict(),
    jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const key = `nb.breakdowns`;
      const cached = await deps.cache.get(key);
      if (cached) return cached;
      const data = await deps.gql.request<{
        me: { salesBreakdownConfigs: Array<{ key: string; choices: Array<{ value: string }> }> };
      }>('GetSalesBreakdownConfigs', GET_SALES_BREAKDOWN_CONFIGS, {});
      const breakdowns: Record<string, string[]> = {};
      for (const b of data.me.salesBreakdownConfigs) {
        breakdowns[b.key] = b.choices.map((c) => c.value);
      }
      const result = { breakdowns };
      await deps.cache.set(key, result, 24 * 60 * 60);
      return result;
    },
  };

  const listMetrics: ToolDef<Record<string, never>> = {
    name: 'northbeam.list_metrics',
    description: 'Lists the metric IDs available to `northbeam.overview` and `northbeam.sales`.',
    schema: z.object({}).strict(),
    jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return { metrics: METRIC_CATALOG };
    },
  };

  const connectedPartners: ToolDef<Record<string, never>> = {
    name: 'northbeam.connected_partners',
    description: 'Reports which ad platforms (Meta, Google Ads, etc.) have a working connection into Northbeam.',
    schema: z.object({}).strict(),
    jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const key = `nb.partners`;
      const cached = await deps.cache.get(key);
      if (cached) return cached;
      const data = await deps.gql.request<{
        me: { partnerApexConsent: unknown[]; isMetaCapiConfigured: boolean };
      }>('FetchPartnersApexConsent', FETCH_PARTNERS_APEX_CONSENT, {});
      const result = {
        partners: data.me.partnerApexConsent,
        isMetaCapiConfigured: data.me.isMetaCapiConfigured,
      };
      await deps.cache.set(key, result, 24 * 60 * 60);
      return result;
    },
  };

  return [overview, sales, listBreakdowns, listMetrics, connectedPartners];
}

// ---------------- helper: zod → approximate JSON Schema ----------------

// Small util just for Claude's tool manifest. Not a full implementation;
// covers the shapes we actually use in this file.
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def: any = (schema as any)._def;
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = def.shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, child] of Object.entries<any>(shape)) {
        properties[k] = zodToJsonSchema(child);
        if (!('defaultValue' in (child as any)._def) && !((child as any).isOptional?.())) {
          required.push(k);
        }
      }
      return { type: 'object', properties, required, additionalProperties: false };
    }
    case 'ZodArray':
      return { type: 'array', items: zodToJsonSchema(def.type) };
    case 'ZodEnum':
      return { type: 'string', enum: def.values };
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodDefault':
      return zodToJsonSchema(def.innerType);
    case 'ZodOptional':
      return zodToJsonSchema(def.innerType);
    default:
      return {};
  }
}
```

- [ ] **Step 3: Run tests** — expect PASS

```bash
npx vitest run tests/unit/northbeam/tools.test.ts
```

Expected: 3 passed.

- [ ] **Step 4: Commit**

```bash
git add src/connectors/northbeam/tools.ts tests/unit/northbeam/tools.test.ts
git commit -m "feat(northbeam): 5 tool definitions with zod schemas and caching"
```

---

## Task 15: NorthbeamConnector assembly

**Files:**
- Create: `src/connectors/northbeam/northbeam-connector.ts`

- [ ] **Step 1: Implement `src/connectors/northbeam/northbeam-connector.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Connector, ToolDef } from '../base/connector.js';
import { NorthbeamAuthManager, type Credentials } from './auth-manager.js';
import { NorthbeamGraphqlClient } from './graphql-client.js';
import { playwrightLogin } from './playwright-login.js';
import { buildNorthbeamTools } from './tools.js';
import { TtlCache } from '../../storage/cache.js';
import { NorthbeamTokensRepo } from '../../storage/repositories/northbeam-tokens.js';

export interface NorthbeamConnectorOptions {
  supabase: SupabaseClient;
  credentials: Credentials;
}

export class NorthbeamConnector implements Connector {
  readonly name = 'northbeam';
  readonly tools: readonly ToolDef[];

  private readonly gql: NorthbeamGraphqlClient;
  private readonly auth: NorthbeamAuthManager;

  constructor(opts: NorthbeamConnectorOptions) {
    const tokensRepo = new NorthbeamTokensRepo(opts.supabase);
    this.auth = new NorthbeamAuthManager({
      credentials: opts.credentials,
      tokensRepo,
      playwrightLogin,
    });
    this.gql = new NorthbeamGraphqlClient({
      dashboardId: opts.credentials.dashboardId,
      getToken: () => this.auth.getAccessToken(),
    });
    const cache = new TtlCache(opts.supabase);
    this.tools = buildNorthbeamTools({ gql: this.gql, cache });
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.auth.getAccessToken();
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/connectors/northbeam/northbeam-connector.ts
git commit -m "feat(northbeam): NorthbeamConnector wiring"
```

---

## Task 16: Orchestrator — system prompt builder

**Files:**
- Create: `src/orchestrator/prompts.ts`
- Create: `tests/unit/orchestrator/prompts.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/unit/orchestrator/prompts.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../../src/orchestrator/prompts.js';

describe('buildSystemPrompt', () => {
  it("includes today's date, tool names, and the metric catalog summary", () => {
    const prompt = buildSystemPrompt({
      todayISO: '2026-04-24',
      toolNames: ['northbeam.overview', 'northbeam.sales'],
      catalogSummary: '- `spend` (Spend): Marketing dollars spent.',
    });
    expect(prompt).toContain('2026-04-24');
    expect(prompt).toContain('northbeam.overview');
    expect(prompt).toContain('northbeam.sales');
    expect(prompt).toContain('`spend`');
  });
});
```

- [ ] **Step 2: Implement `src/orchestrator/prompts.ts`**

```ts
export interface SystemPromptInput {
  todayISO: string;
  toolNames: string[];
  catalogSummary: string;
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  return `You are gantri-ai, an analytics assistant for Gantri's team. You answer business questions using live data from connected sources.

Today's date is ${input.todayISO}. Always ground date ranges relative to today.

Available tools: ${input.toolNames.map((n) => `\`${n}\``).join(', ')}.

Data source notes for Northbeam:
- Revenue, spend, ROAS and related performance metrics come from Northbeam.
- When a question is about a *summary* or *headline* number, prefer \`northbeam.overview\`.
- When a question requires a *table* or drill-down (per-campaign, per-platform, etc.), use \`northbeam.sales\`.
- If you need to filter by a platform or category, call \`northbeam.list_breakdowns\` first to ground on valid values.

${input.catalogSummary}

Response guidelines:
- Be concise. Lead with the headline number, then tables or breakdowns.
- Always state the period, attribution model, and attribution window you used.
- If a tool returns an error, explain briefly what went wrong and try a correction before giving up.
- Never fabricate metric IDs, breakdown keys, or attribution values — only use ones listed above.
- Format for Slack: short paragraphs, bullet lists for details, use code-fenced blocks for tabular data.`;
}
```

- [ ] **Step 3: Run tests** — expect PASS

```bash
npx vitest run tests/unit/orchestrator/prompts.test.ts
```

Expected: 1 passed.

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/prompts.ts tests/unit/orchestrator/prompts.test.ts
git commit -m "feat(orchestrator): system prompt builder"
```

---

## Task 17: Orchestrator — tool-use loop

**Files:**
- Create: `src/orchestrator/orchestrator.ts`
- Create: `tests/unit/orchestrator/orchestrator.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/unit/orchestrator/orchestrator.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { Orchestrator } from '../../../src/orchestrator/orchestrator.js';
import { ConnectorRegistry } from '../../../src/connectors/base/registry.js';
import type { Connector, ToolDef } from '../../../src/connectors/base/connector.js';

function buildRegistry(execResult: unknown = { summary: { actual: { spend: 700 } } }) {
  const tool: ToolDef = {
    name: 'northbeam.overview',
    description: 'overview',
    schema: z.object({}).passthrough(),
    jsonSchema: { type: 'object' },
    execute: vi.fn(async () => execResult),
  };
  const conn: Connector = { name: 'northbeam', tools: [tool], async healthCheck() { return { ok: true }; } };
  const r = new ConnectorRegistry();
  r.register(conn);
  return { registry: r, tool };
}

function fakeClaude(responses: any[]) {
  let i = 0;
  return {
    messages: {
      create: vi.fn(async () => responses[i++]),
    },
  };
}

describe('Orchestrator', () => {
  it('passes final text back when Claude stops without tool use', async () => {
    const { registry } = buildRegistry();
    const claude: any = fakeClaude([
      {
        content: [{ type: 'text', text: 'Hello there.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({
      registry,
      claude: claude as any,
      model: 'claude-sonnet-4-6',
      maxIterations: 3,
    });
    const out = await orch.run({ question: 'hi', threadHistory: [] });
    expect(out.response).toBe('Hello there.');
    expect(out.toolCalls).toEqual([]);
  });

  it('executes a tool, feeds the result back, and returns final text', async () => {
    const { registry, tool } = buildRegistry();
    const claude: any = fakeClaude([
      {
        content: [
          { type: 'text', text: 'Let me check…' },
          { type: 'tool_use', id: 'toolu_1', name: 'northbeam.overview', input: { dateRange: { startDate: '2026-04-17', endDate: '2026-04-23' } } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 20 },
        model: 'claude-sonnet-4-6',
      },
      {
        content: [{ type: 'text', text: 'You spent $700.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 200, output_tokens: 10 },
        model: 'claude-sonnet-4-6',
      },
    ]);
    const orch = new Orchestrator({
      registry,
      claude: claude as any,
      model: 'claude-sonnet-4-6',
      maxIterations: 3,
    });
    const out = await orch.run({ question: 'spend last week', threadHistory: [] });
    expect(out.response).toBe('You spent $700.');
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]).toMatchObject({ name: 'northbeam.overview' });
    expect(tool.execute).toHaveBeenCalledTimes(1);
  });

  it('stops after maxIterations and returns a graceful message', async () => {
    const { registry } = buildRegistry();
    const loopResponse = {
      content: [{ type: 'tool_use', id: 't', name: 'northbeam.overview', input: {} }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'claude-sonnet-4-6',
    };
    const claude: any = fakeClaude(Array(10).fill(loopResponse));
    const orch = new Orchestrator({
      registry,
      claude: claude as any,
      model: 'claude-sonnet-4-6',
      maxIterations: 2,
    });
    const out = await orch.run({ question: 'infinite', threadHistory: [] });
    expect(out.response).toMatch(/didn't converge|iteration limit/i);
  });
});
```

- [ ] **Step 2: Implement `src/orchestrator/orchestrator.ts`**

```ts
import type Anthropic from '@anthropic-ai/sdk';
import type { ConnectorRegistry } from '../connectors/base/registry.js';
import { buildSystemPrompt } from './prompts.js';
import { describeCatalog } from '../connectors/northbeam/catalog.js';
import { logger } from '../logger.js';

export interface OrchestratorInput {
  question: string;
  threadHistory: Array<{ question: string; response: string | null }>;
}

export interface OrchestratorOutput {
  response: string;
  model: string;
  toolCalls: Array<{ name: string; args: unknown; ok: boolean; errorMessage?: string }>;
  tokensInput: number;
  tokensOutput: number;
  iterations: number;
}

export interface OrchestratorOptions {
  registry: ConnectorRegistry;
  claude: Anthropic;
  model: string;
  maxIterations?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export class Orchestrator {
  private readonly maxIterations: number;
  private readonly maxOutputTokens: number;

  constructor(private readonly opts: OrchestratorOptions) {
    this.maxIterations = opts.maxIterations ?? 5;
    this.maxOutputTokens = opts.maxOutputTokens ?? 4096;
  }

  async run(input: OrchestratorInput): Promise<OrchestratorOutput> {
    const tools = this.opts.registry.getAllTools();
    const claudeTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.jsonSchema as any,
    }));

    const system = buildSystemPrompt({
      todayISO: new Date().toISOString().slice(0, 10),
      toolNames: tools.map((t) => t.name),
      catalogSummary: describeCatalog(),
    });

    const messages: any[] = [];
    for (const turn of input.threadHistory) {
      messages.push({ role: 'user', content: turn.question });
      if (turn.response) messages.push({ role: 'assistant', content: turn.response });
    }
    messages.push({ role: 'user', content: input.question });

    const toolCalls: OrchestratorOutput['toolCalls'] = [];
    let tokensInput = 0;
    let tokensOutput = 0;
    let lastModel = this.opts.model;

    for (let iter = 1; iter <= this.maxIterations; iter++) {
      const resp = await this.opts.claude.messages.create({
        model: this.opts.model,
        max_tokens: this.maxOutputTokens,
        system,
        tools: claudeTools,
        messages,
      });
      tokensInput += resp.usage.input_tokens;
      tokensOutput += resp.usage.output_tokens;
      lastModel = resp.model;

      if (resp.stop_reason !== 'tool_use') {
        const text = extractText(resp.content);
        return {
          response: text,
          model: lastModel,
          toolCalls,
          tokensInput,
          tokensOutput,
          iterations: iter,
        };
      }

      // Tool use branch.
      messages.push({ role: 'assistant', content: resp.content });
      const toolResults: any[] = [];
      for (const block of resp.content) {
        if (block.type !== 'tool_use') continue;
        const result = await this.opts.registry.execute(block.name, block.input);
        toolCalls.push({
          name: block.name,
          args: block.input,
          ok: result.ok,
          errorMessage: result.ok ? undefined : result.error?.message,
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result.ok ? JSON.stringify(result.data) : `ERROR: ${result.error?.message}`,
          is_error: !result.ok,
        });
      }
      messages.push({ role: 'user', content: toolResults });
      logger.debug({ iter, toolCalls: toolCalls.length }, 'orchestrator iteration');
    }

    return {
      response:
        "I couldn't converge on an answer within the iteration limit. Please try rephrasing or narrowing the question.",
      model: lastModel,
      toolCalls,
      tokensInput,
      tokensOutput,
      iterations: this.maxIterations,
    };
  }
}

function extractText(content: any[]): string {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text as string)
    .join('\n')
    .trim();
}
```

- [ ] **Step 3: Run tests** — expect PASS

```bash
npx vitest run tests/unit/orchestrator/orchestrator.test.ts
```

Expected: 3 passed.

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/orchestrator.ts tests/unit/orchestrator/orchestrator.test.ts
git commit -m "feat(orchestrator): Claude tool-use loop with iteration cap"
```

---

## Task 18: Orchestrator — markdown → Slack Blocks formatter

**Files:**
- Create: `src/orchestrator/formatter.ts`
- Create: `tests/unit/orchestrator/formatter.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/unit/orchestrator/formatter.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { markdownToSlackBlocks } from '../../../src/orchestrator/formatter.js';

describe('markdownToSlackBlocks', () => {
  it('wraps plain paragraphs in section blocks', () => {
    const blocks = markdownToSlackBlocks('Hello world.\n\nSecond line.');
    expect(blocks).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: 'Hello world.' } },
      { type: 'section', text: { type: 'mrkdwn', text: 'Second line.' } },
    ]);
  });

  it('converts bullet lists to a single section with bullets preserved', () => {
    const blocks = markdownToSlackBlocks('- a\n- b\n- c');
    expect(blocks[0].text.text).toBe('• a\n• b\n• c');
  });

  it('keeps fenced code blocks intact inside a section (Slack renders them)', () => {
    const md = '```\nrow1\nrow2\n```';
    const blocks = markdownToSlackBlocks(md);
    expect(blocks[0].text.text).toContain('```\nrow1\nrow2\n```');
  });

  it('appends a context footer when provided', () => {
    const blocks = markdownToSlackBlocks('Hi.', { footer: 'Source: Northbeam' });
    const last = blocks[blocks.length - 1];
    expect(last.type).toBe('context');
    expect(last.elements[0].text).toBe('Source: Northbeam');
  });
});
```

- [ ] **Step 2: Implement `src/orchestrator/formatter.ts`**

```ts
export interface FormatterOptions {
  footer?: string;
}

type Block =
  | { type: 'section'; text: { type: 'mrkdwn'; text: string } }
  | { type: 'context'; elements: Array<{ type: 'mrkdwn'; text: string }> };

export function markdownToSlackBlocks(markdown: string, opts: FormatterOptions = {}): Block[] {
  // Split into paragraphs, preserving fenced code blocks as a single unit.
  const paragraphs = splitParagraphs(markdown);
  const blocks: Block[] = paragraphs.map((p) => ({
    type: 'section',
    text: { type: 'mrkdwn', text: transformBulletChars(p) },
  }));
  if (opts.footer) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: opts.footer }] });
  }
  return blocks;
}

function splitParagraphs(md: string): string[] {
  const out: string[] = [];
  const lines = md.split('\n');
  let buf: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (line.startsWith('```')) inFence = !inFence;
    if (!inFence && line.trim() === '') {
      if (buf.length) { out.push(buf.join('\n')); buf = []; }
    } else {
      buf.push(line);
    }
  }
  if (buf.length) out.push(buf.join('\n'));
  return out;
}

function transformBulletChars(block: string): string {
  return block
    .split('\n')
    .map((l) => (l.startsWith('- ') ? `• ${l.slice(2)}` : l))
    .join('\n');
}
```

- [ ] **Step 3: Run tests** — expect PASS

```bash
npx vitest run tests/unit/orchestrator/formatter.test.ts
```

Expected: 4 passed.

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/formatter.ts tests/unit/orchestrator/formatter.test.ts
git commit -m "feat(orchestrator): markdown → Slack Blocks formatter"
```

---

## Task 19: Slack app + DM handler

**Files:**
- Create: `src/slack/app.ts`
- Create: `src/slack/handlers.ts`
- Create: `tests/unit/slack/handlers.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/unit/slack/handlers.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest';
import { createDmHandler } from '../../../src/slack/handlers.js';

function makeContext(isAuthorized: boolean) {
  const runSpy = vi.fn(async () => ({
    response: 'You spent $700.',
    model: 'claude-sonnet-4-6',
    toolCalls: [],
    tokensInput: 100,
    tokensOutput: 10,
    iterations: 1,
  }));
  const insertSpy = vi.fn(async () => 'conv-1');
  const loadSpy = vi.fn(async () => []);
  const postMessage = vi.fn(async () => ({ ts: '1234.5678' }));
  const update = vi.fn(async () => ({}));
  return {
    spies: { runSpy, insertSpy, postMessage, update, loadSpy },
    deps: {
      orchestrator: { run: runSpy },
      usersRepo: { isAuthorized: vi.fn(async () => isAuthorized) },
      conversationsRepo: { insert: insertSpy, loadRecentByThread: loadSpy },
    },
    event: {
      channel_type: 'im',
      channel: 'D1',
      user: 'U1',
      text: 'how much did we spend',
      ts: '1000.0001',
      thread_ts: undefined,
    },
    say: vi.fn(async () => ({})),
    client: { chat: { postMessage, update } } as any,
  };
}

describe('createDmHandler', () => {
  it('replies with the orchestrator response in the thread', async () => {
    const ctx = makeContext(true);
    const handler = createDmHandler(ctx.deps as any);
    await handler({ event: ctx.event as any, client: ctx.client, say: ctx.say } as any);
    expect(ctx.spies.postMessage).toHaveBeenCalledTimes(1); // placeholder
    expect(ctx.spies.update).toHaveBeenCalledTimes(1); // final answer
    expect(ctx.spies.runSpy).toHaveBeenCalledOnce();
    expect(ctx.spies.insertSpy).toHaveBeenCalledOnce();
  });

  it('declines politely for unauthorized users', async () => {
    const ctx = makeContext(false);
    const handler = createDmHandler(ctx.deps as any);
    await handler({ event: ctx.event as any, client: ctx.client, say: ctx.say } as any);
    expect(ctx.spies.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/not authorized/i),
    }));
    expect(ctx.spies.runSpy).not.toHaveBeenCalled();
  });

  it('ignores events from the bot itself (no bot_id loops)', async () => {
    const ctx = makeContext(true);
    const handler = createDmHandler(ctx.deps as any);
    const e = { ...ctx.event, bot_id: 'B1' };
    await handler({ event: e as any, client: ctx.client, say: ctx.say } as any);
    expect(ctx.spies.postMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement `src/slack/handlers.ts`**

```ts
import type { AuthorizedUsersRepo } from '../storage/repositories/authorized-users.js';
import type { ConversationsRepo } from '../storage/repositories/conversations.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { markdownToSlackBlocks } from '../orchestrator/formatter.js';
import { logger } from '../logger.js';

export interface HandlerDeps {
  orchestrator: Orchestrator;
  usersRepo: AuthorizedUsersRepo;
  conversationsRepo: ConversationsRepo;
}

export function createDmHandler(deps: HandlerDeps) {
  return async ({ event, client }: any) => {
    // Only handle DMs
    if (event.channel_type !== 'im') return;
    // Ignore bot messages
    if (event.bot_id) return;
    if (!event.text || !event.user) return;

    const threadTs = event.thread_ts ?? event.ts;

    if (!(await deps.usersRepo.isAuthorized(event.user))) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: "You are not authorized to use this bot. Please ask Danny for access.",
      });
      return;
    }

    const placeholder = await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: "🔍 Consultando datos…",
    });

    const threadHistory = await deps.conversationsRepo.loadRecentByThread(threadTs, 10);
    const started = Date.now();
    try {
      const out = await deps.orchestrator.run({ question: event.text, threadHistory });
      const blocks = markdownToSlackBlocks(out.response, {
        footer: `Fuente: Northbeam • Modelo: ${out.model} • ${out.iterations} iteración${out.iterations === 1 ? '' : 'es'}`,
      });
      await client.chat.update({
        channel: event.channel,
        ts: placeholder.ts,
        text: out.response.slice(0, 200),
        blocks,
      });
      await deps.conversationsRepo.insert({
        slack_thread_ts: threadTs,
        slack_channel_id: event.channel,
        slack_user_id: event.user,
        question: event.text,
        tool_calls: out.toolCalls,
        response: out.response,
        model: out.model,
        tokens_input: out.tokensInput,
        tokens_output: out.tokensOutput,
        duration_ms: Date.now() - started,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'orchestrator failed');
      await client.chat.update({
        channel: event.channel,
        ts: placeholder.ts,
        text: `⚠️ Something went wrong: ${msg}`,
      });
      await deps.conversationsRepo.insert({
        slack_thread_ts: threadTs,
        slack_channel_id: event.channel,
        slack_user_id: event.user,
        question: event.text,
        error: msg,
        duration_ms: Date.now() - started,
      });
    }
  };
}

export function createMentionHandler() {
  return async ({ event, say }: any) => {
    await say({
      channel: event.channel,
      thread_ts: event.ts,
      text:
        "Hi! For privacy, I only answer in DMs. Open a direct message with me and ask there.",
    });
  };
}
```

- [ ] **Step 3: Implement `src/slack/app.ts`**

```ts
import pkg from '@slack/bolt';
import type { HandlerDeps } from './handlers.js';
import { createDmHandler, createMentionHandler } from './handlers.js';
import { loadEnv } from '../config/env.js';

const { App, ExpressReceiver } = pkg;

export function buildSlackApp(deps: HandlerDeps) {
  const env = loadEnv();
  const receiver = new ExpressReceiver({
    signingSecret: env.SLACK_SIGNING_SECRET,
    endpoints: '/slack/events',
  });
  const app = new App({
    token: env.SLACK_BOT_TOKEN,
    receiver,
  });

  app.event('message', createDmHandler(deps));
  app.event('app_mention', createMentionHandler());

  return { app, receiver };
}
```

- [ ] **Step 4: Run tests** — expect PASS

```bash
npx vitest run tests/unit/slack/handlers.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/slack tests/unit/slack
git commit -m "feat(slack): DM handler + @mention redirect to DM"
```

---

## Task 20: Entry point and full wiring

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Implement `src/index.ts`**

```ts
import Anthropic from '@anthropic-ai/sdk';
import { loadEnv } from './config/env.js';
import { logger } from './logger.js';
import { getSupabase, readVaultSecret } from './storage/supabase.js';
import { AuthorizedUsersRepo } from './storage/repositories/authorized-users.js';
import { ConversationsRepo } from './storage/repositories/conversations.js';
import { ConnectorRegistry } from './connectors/base/registry.js';
import { NorthbeamConnector } from './connectors/northbeam/northbeam-connector.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { buildSlackApp } from './slack/app.js';

async function main() {
  const env = loadEnv();
  const supabase = getSupabase();

  // Secrets from Vault
  const [email, password, dashboardId] = await Promise.all([
    readVaultSecret(supabase, 'NORTHBEAM_EMAIL'),
    readVaultSecret(supabase, 'NORTHBEAM_PASSWORD'),
    readVaultSecret(supabase, 'NORTHBEAM_DASHBOARD_ID'),
  ]);

  // Connectors
  const registry = new ConnectorRegistry();
  const northbeam = new NorthbeamConnector({
    supabase,
    credentials: { email, password, dashboardId },
  });
  registry.register(northbeam);

  // Orchestrator
  const claude = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const orchestrator = new Orchestrator({
    registry,
    claude,
    model: 'claude-sonnet-4-6',
    maxIterations: 5,
    maxOutputTokens: 4096,
  });

  // Repositories
  const usersRepo = new AuthorizedUsersRepo(supabase);
  const conversationsRepo = new ConversationsRepo(supabase);

  // Slack app
  const { app, receiver } = buildSlackApp({ orchestrator, usersRepo, conversationsRepo });

  // Health endpoint
  receiver.router.get('/healthz', async (_req, res) => {
    const nb = await northbeam.healthCheck();
    res.status(nb.ok ? 200 : 503).json({ ok: nb.ok, northbeam: nb });
  });

  await app.start(env.PORT);
  logger.info({ port: env.PORT }, 'gantri-ai-bot listening');
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.stack : String(err) }, 'fatal');
  process.exit(1);
});
```

- [ ] **Step 2: Build and typecheck**

```bash
npm run typecheck
npm run build
```

Expected: 0 type errors; `dist/` produced.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire entry point (supabase + northbeam + orchestrator + slack)"
```

---

## Task 21: Dockerfile & fly.toml

**Files:**
- Create: `Dockerfile`
- Create: `fly.toml`
- Create: `.dockerignore`

- [ ] **Step 1: Create `Dockerfile`**

```dockerfile
# Based on Playwright's official image for Node 20 + Chromium preinstalled
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

# Install deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source & build
COPY tsconfig.json ./
COPY src ./src
RUN npm install --no-save typescript@5 && npx tsc && npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Create `.dockerignore`**

```
node_modules
dist
tests
coverage
.git
.env
.env.*
docs
*.log
```

- [ ] **Step 3: Create `fly.toml`**

```toml
app = "gantri-ai-bot"
primary_region = "iad"

[build]

[env]
  PORT = "3000"
  LOG_LEVEL = "info"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1

[[http_service.checks]]
  interval = "30s"
  timeout = "5s"
  grace_period = "10s"
  method = "GET"
  path = "/healthz"
```

- [ ] **Step 4: Local Docker smoke test**

```bash
docker build -t gantri-ai-bot:local .
docker run --rm --env-file .env -p 3000:3000 gantri-ai-bot:local
```

Expected (in another terminal): `curl localhost:3000/healthz` returns `{"ok":true,"northbeam":{"ok":true}}` within ~20s of startup.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile fly.toml .dockerignore
git commit -m "deploy: Dockerfile + fly.toml"
```

---

## Task 22: README with setup + operations

**Files:**
- Create: `README.md`

- [ ] **Step 1: Create `README.md`**

````markdown
# gantri-ai-bot

Slack DM bot that answers Gantri business questions in natural language, grounded in Northbeam data. Built with Claude tool-use.

See the design spec: `docs/superpowers/specs/2026-04-24-gantri-ai-slack-bot-design.md`.

## Local development

```bash
cp .env.example .env    # fill in your values
npm install
npm run dev
```

## Tests

```bash
npm run test              # unit + integration
npm run test:watch
```

## Database

Apply migrations in order against your Supabase project's SQL editor:

```bash
# Paste migrations/0001_initial.sql into SQL Editor and Run
```

Create the Vault secrets (one-time):

```sql
select vault.create_secret('<email>',        'NORTHBEAM_EMAIL');
select vault.create_secret('<password>',     'NORTHBEAM_PASSWORD');
select vault.create_secret('<workspace>',    'NORTHBEAM_DASHBOARD_ID');
```

Add authorized users:

```sql
insert into authorized_users (slack_user_id, slack_workspace_id, email, role)
values ('U03ABC123', 'T0WORKSPACE', 'danny@gantri.com', 'admin');
```

## Deploy to Fly

```bash
fly auth login
fly launch --no-deploy     # only once; accept the generated fly.toml
fly secrets set \
  SUPABASE_URL=... \
  SUPABASE_SERVICE_ROLE_KEY=... \
  ANTHROPIC_API_KEY=... \
  SLACK_BOT_TOKEN=... \
  SLACK_SIGNING_SECRET=...
fly deploy
```

Update the Slack app's Event Subscriptions URL to `https://<app>.fly.dev/slack/events` and re-verify.

## Architecture

See `docs/superpowers/specs/2026-04-24-gantri-ai-slack-bot-design.md` and the plan in `docs/superpowers/plans/`.
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README with setup + deploy instructions"
```

---

## Task 23: Post-deploy smoke test

**Files:**
- Create: `tests/integration/smoke.md`

This is a manual checklist rather than an automated test, because it requires a live Slack workspace.

- [ ] **Step 1: Create `tests/integration/smoke.md`**

```markdown
# Post-deploy smoke checklist

Run once after every deploy to staging.

1. `curl https://<app>.fly.dev/healthz` → `{"ok":true,...}`
2. Open DM with the bot; send "healthcheck".
3. Expect a reply within 15s acknowledging and listing the tools (sanity check against prompt).
4. Send: "How much did we spend in Google Ads last week?"
5. Expect a reply within 30s containing:
   - A numeric spend figure
   - The period stated explicitly
   - The attribution model ("Linear", "1d", "Accrual")
6. Follow up in the same thread: "And what was the ROAS?"
7. Expect a coherent follow-up that reuses the prior period and adds a ROAS number.
8. In Supabase Studio, open `conversations`; verify the last 2 rows contain the questions, `tool_calls` populated, and non-null `response`.
9. In Supabase Studio, open `northbeam_tokens`; verify the row has a recent `refreshed_at`.

Log the result of the run (pass/fail per step) in the deploy PR.
```

- [ ] **Step 2: Commit**

```bash
git add tests/integration/smoke.md
git commit -m "docs: post-deploy smoke checklist"
```

---

## Self-Review

### Spec coverage

| Spec requirement | Task |
|---|---|
| Slack DM-only surface | Task 19, 20 |
| Claude tool-use orchestrator | Task 17 |
| NorthbeamConnector (Auth0 + GraphQL) | Tasks 9, 10, 11, 12, 15 |
| 5 tools: overview, sales, list_breakdowns, list_metrics, connected_partners | Task 14 |
| System prompt with catalog grounding | Task 13, 16 |
| Thread follow-ups | Task 19 (`loadRecentByThread`) |
| Allowlist enforcement | Task 19 (`isAuthorized`) |
| 4 DB tables + Vault helper | Task 2, 5 |
| TTL cache with tiered expiry | Task 7, 14 (tier logic in `cacheTtl`) |
| Secrets via Supabase Vault | Task 2, 5, 20 |
| Pino logger with redaction | Task 4 |
| Deploy on Fly.io with Chromium | Task 21 |
| Health endpoint | Task 20 |
| Rollout phase 0 (Danny-only staging) | Task 22 (allowlist manual insert in README) |
| Log depth (summary default + DEBUG flag) | Partial — DEBUG_FULL_LOGS flag plumbed via env but not yet consumed in orchestrator. See note below. |

**Gap:** the spec's resolved decision "Log depth: summary-by-default + `DEBUG_FULL_LOGS=true` captures full prompt + raw tool responses" is only partially wired — the flag is parsed in `env.ts` (Task 3) but the orchestrator always stores summaries only. This is acceptable for v1 because the summaries are sufficient for current needs and `DEBUG_FULL_LOGS` will be honored in a small follow-up when someone actually needs it. **Noted as Task 24 below.**

### Placeholder scan

Searched for TBD / TODO / "implement later" / "handle edge cases" style placeholders. None found. Every code step includes the actual code. Schema types are concrete. Test steps have expected outputs.

### Type consistency

Traced types across tasks:
- `Connector` / `ToolDef` / `ToolResult` defined in Task 6 and used consistently in Tasks 14, 15, 17.
- `Credentials` defined in Task 10, used in Task 11 and Task 15.
- `NorthbeamAuthManager.getAccessToken()` signature consistent between Task 10 and its consumer in Task 15.
- `Orchestrator.run(input)` input type and output type used consistently between Task 17 and Task 19.
- `ConversationsRepo.insert` and `.loadRecentByThread` signatures match between Task 8 (definition) and Task 19 (consumer).
- `TtlCache.key` signature in Task 7 matches its (not yet used) call sites; Task 14 uses `JSON.stringify(variables)` directly instead of the helper — acceptable but a nit. Not a bug since both produce a stable string for cache keys.

No cross-task naming inconsistencies found.

---

## Task 24 (small follow-up): Honor DEBUG_FULL_LOGS

**Files:**
- Modify: `src/slack/handlers.ts`
- Modify: `tests/unit/slack/handlers.test.ts`

- [ ] **Step 1: Modify the DM handler** to persist the full prompt + raw tool results when `DEBUG_FULL_LOGS=true`.

In `src/slack/handlers.ts`, in `createDmHandler`, after computing `out`, change the `conversationsRepo.insert` call to include raw data only when the flag is on:

```ts
import { loadEnv } from '../config/env.js';

// Inside createDmHandler, before insert:
const env = loadEnv();
const toolCallsForDb = env.DEBUG_FULL_LOGS
  ? out.toolCalls.map((tc) => ({ ...tc, argsRaw: tc.args }))
  : out.toolCalls.map(({ name, ok, errorMessage }) => ({ name, ok, errorMessage }));
```

Then pass `toolCallsForDb` to `tool_calls` in the insert.

- [ ] **Step 2: Extend the test** to verify summary-vs-full behavior.

Add to `tests/unit/slack/handlers.test.ts`:

```ts
it('stores summary-only tool_calls when DEBUG_FULL_LOGS is off', async () => {
  process.env.DEBUG_FULL_LOGS = 'false';
  const ctx = makeContext(true);
  ctx.spies.runSpy.mockResolvedValueOnce({
    response: 'ok', model: 'm', toolCalls: [{ name: 'x', args: { secret: 1 }, ok: true }],
    tokensInput: 0, tokensOutput: 0, iterations: 1,
  });
  const handler = createDmHandler(ctx.deps as any);
  await handler({ event: ctx.event as any, client: ctx.client, say: ctx.say } as any);
  const call = ctx.spies.insertSpy.mock.calls[0][0];
  expect(call.tool_calls[0]).not.toHaveProperty('args');
});
```

- [ ] **Step 3: Run tests** — expect PASS

```bash
npx vitest run tests/unit/slack/handlers.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/slack/handlers.ts tests/unit/slack/handlers.test.ts
git commit -m "feat(slack): honor DEBUG_FULL_LOGS for conversation tool_call payloads"
```

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-24-gantri-ai-slack-bot.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using `executing-plans`, batch execution with checkpoints.
