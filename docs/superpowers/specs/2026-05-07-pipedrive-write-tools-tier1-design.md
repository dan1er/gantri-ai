# Pipedrive Write Tools — Tier 1 Design Spec

**Date**: 2026-05-07
**Author**: Danny + Claude
**Status**: Approved — ready for plan
**Document status**: Approved
**Feature status**: Planned
**Owner**: Danny
**Team / Pod**: Functional (gantri-ai-bot)
**Related links**:
- Pipedrive API — `POST /api/v1/leads` (create lead, requires pre-existing person/org id)
- Pipedrive API — `POST /api/v1/notes` (attach note to lead/deal/person/org/project/task)
- Pipedrive API — `POST /api/v1/activities` (calls/meetings/tasks)
- Pipedrive API — `GET /api/v1/persons/search` (find by email)
- Pipedrive API — `GET /api/v1/organizations/search` (find by name)
- Sibling spec: `2026-05-05-klaviyo-import-design.md` (analogous role gate + audit pattern)
- Existing connector: `src/connectors/pipedrive/connector.ts` (11 read-only tools)

---

## Functional Specification

### Overview

Marketing (Lana, Jennifer, Stephanie) currently uses Pipedrive's web UI for any write operation: capturing leads after a trade show, logging conversation notes, scheduling follow-up tasks. They already get Pipedrive *reads* through the bot (11 read-only tools), but every write means context-switching to the browser, which is friction-heavy when the marketing team is on the floor at BDNY/ICFF/Design Miami or processing inbound emails on mobile.

This spec adds three write tools, gated by the existing `marketing` / `admin` roles, that cover ~80% of what marketing actually does in Pipedrive:

- **`pipedrive.create_lead`** — capture a new lead (with embedded find-or-create person + organization).
- **`pipedrive.add_note`** — attach a note to any existing entity (lead, deal, person, organization).
- **`pipedrive.create_activity`** — schedule a follow-up call/meeting/task.

The trio composes naturally for the conversational flow marketing actually uses: *"I had a great call with Foo Studio; they're interested in the wave line. Add them as a lead, note that they want a custom finish, and remind me to follow up Tuesday at 3pm."* — three sequential tool calls from one Slack message.

Higher-tier write tools (deal stage transitions, file uploads, bulk-CSV lead import) are deliberately deferred to a Tier 2 spec; this Tier 1 sets the foundation (write client, audit row, role gate) the next iteration extends.

### Conceptual

**What it does.** Lets a `marketing` or `admin` Slack user, in a DM thread with the bot, create a lead in Pipedrive (with auto-resolved or auto-created person + organization), pin a note onto any existing Pipedrive entity, or schedule a follow-up activity. Each operation persists an audit row tying the Slack caller to the Pipedrive resource id, so we can answer "who created this lead?" / "which Slack user logged that note?" without leaving Slack.

**Glossary.**

| Term | Definition |
|---|---|
| **Lead** | Pipedrive's pre-deal record — an unqualified contact intent. Lives in the "Leads Inbox" view, separate from deals/pipelines. Targeted by id `lead_id` (UUID). |
| **Person** | A Pipedrive contact record (a human), keyed by email when we search. Lead must reference at least one (or an org). Targeted by integer `person_id`. |
| **Organization** | A Pipedrive company record (a B2B account). Optional on a lead but useful for filtering / reporting. Integer `org_id`. |
| **Activity** | Pipedrive's calendar entity — a call, meeting, task, lunch, or custom type, with optional due date/time + assignee. Activities can attach to a deal, lead, person, or org. |
| **Note** | A free-form text annotation pinned to one of: deal, lead, person, organization, project, task. Stored as HTML on Pipedrive's side. |
| **Find-or-create** | The internal pattern `pipedrive.create_lead` uses to resolve an email → existing person id (preferred) before creating a new person. Also for org name → existing org id. Reduces duplicate proliferation. |
| **Marketing role** | Same `authorized_users.role = 'marketing'` value Klaviyo writes already use. Pipedrive writes inherit this gate (no separate role). |
| **Audit row** | A row in `pipedrive_writes` recording `{caller_slack_id, action, pipedrive_resource_type, pipedrive_resource_id, request_payload, response_payload, status}`. One row per successful write; failures also recorded with `status='failure'` for post-mortem visibility. |

### Goals

1. Marketing can capture a lead, log a note, and schedule a follow-up — entirely from a Slack DM, in one conversational turn.
2. The duplicate-person problem (Pipedrive accepts duplicate persons silently) is mitigated by find-by-email before creating.
3. Every write produces an audit row that ties the Slack caller to the Pipedrive resource. Pipedrive's own creator/timestamp tracks the API-token user; our audit is the only place that records the actual Slack user.
4. The same role-gate pattern as Klaviyo writes (admin / marketing) applies — no new role values, no separate authz logic.
5. The write tools are exposed alongside the existing read tools; no new connector, no new API token, no schema change to existing tables.

### Non-goals

- Bulk CSV lead import. Postponed to Tier 2 (will reuse the LLM header-mapper from `2026-05-06-csv-import-reply-routing-design.md`).
- Deal creation, deal stage transitions, deal value updates. These are sales-rep workflows, not marketing.
- File uploads. Multipart + Supabase Storage forensic copy adds surface area beyond Tier 1's scope.
- Lead deletion / archiving. No destructive ops in Tier 1; if marketing needs to delete a wrongly-created lead, they use Pipedrive's UI (rare, low cost).
- Custom-field setting on leads/persons/orgs. Pipedrive's custom field surface is large and volatile; Tier 1 covers the standard fields only.
- Pipedrive-user → Slack-user mapping for owner_id assignment. Tier 1 leaves `owner_id` to Pipedrive's default (the API token's user); marketing can re-assign in the UI later if needed. Tier 2 may add `assigneeEmail` resolution via `pipedrive.list_directory(kind='users')`.

### User-visible behavior

| Slack message | Resulting tool calls | Bot reply |
|---|---|---|
| `"Add Foo Studio as a lead — contact is jane@foostudio.com (Jane Doe), value $5k"` | `create_lead({title:"Foo Studio", personEmail:"jane@foostudio.com", personName:"Jane Doe", orgName:"Foo Studio", value:5000, currency:"USD"})` | `"Created lead 'Foo Studio' (id: <uuid>) with new person Jane Doe + new organization Foo Studio. Pipedrive: <link>"` |
| `"Note on the Foo Studio lead: they want a custom matte black finish"` | `add_note({targetType:"lead", targetId:"<uuid from earlier>", content:"They want a custom matte black finish"})` | `"Note added to lead Foo Studio."` |
| `"Remind me to follow up with Foo Studio next Tuesday at 3pm"` | `create_activity({subject:"Follow up with Foo Studio", type:"call", dueDate:"2026-05-12", dueTime:"15:00", attachToType:"lead", attachToId:"<uuid>"})` | `"Activity scheduled: 'Follow up with Foo Studio' on 2026-05-12 at 15:00."` |
| `"Add jane@foostudio.com as a lead"` (person already exists) | `create_lead({title:"Lead — Jane Doe", personEmail:"jane@foostudio.com"})` → finds existing person, reuses | `"Created lead 'Lead — Jane Doe' (id: <uuid>) with existing person Jane Doe (id: 4521)."` |
| `"Add jane@foostudio.com as a lead"` (NO person, no orgName given, just email) | `create_lead({title:"Jane Doe", personEmail:"jane@foostudio.com"})` → creates person with email-as-name | `"Created lead 'Jane Doe' (id: <uuid>) with new person (email: jane@foostudio.com). Add a person name later in Pipedrive if you want."` |
| Caller has `role='user'` | Tool returns `{error:{code:"FORBIDDEN"}}` | `"Sorry — Pipedrive write tools require the admin or marketing role. Ping Danny if you need it."` |
| User says `"create a lead for someone, no email or org"` | `create_lead({title:"…"})` returns `INVALID_ARGS` (need at least one of `personEmail` / `personName` / `orgName`) | `"I need at least a person email, a person name, or an organization name to create a lead — Pipedrive requires the lead to attach to one of them."` |

### Out of scope (clarifications)

- Searching for an existing lead before creating a new one. If the user says "add Foo Studio as a lead" twice, two leads will be created. The find-or-create dedup applies to *persons* (by email) and *organizations* (by exact-name match), not to leads themselves. Reasoning: marketing might intentionally create multiple leads for the same org (different campaigns / different products / different time windows), so dedup-by-org-on-leads would surprise users.
- Reading the lead/person/org back via this connector. The read tools (`pipedrive.list_directory`, `pipedrive.search`, `pipedrive.list_deals`, `pipedrive.organization_detail`) already cover that; the response of `create_lead` returns enough fields that callers don't need a follow-up read.
- Idempotency tokens. Pipedrive's API doesn't support them; if the bot retries on a transient network failure we may double-create. Mitigation: short retry budget (1 retry, 1s delay) + audit-row `request_payload` for forensic dedup.

---

## Technical Specification

### Architecture

```
Slack message in DM with role=marketing/admin
        │
        ▼
DM handler → orchestrator.run() → LLM dispatches tool
        │
        ├─ pipedrive.create_lead ──► find-or-create person/org → POST /v1/leads → audit row
        ├─ pipedrive.add_note ─────► POST /v1/notes ─────────────────────────────► audit row
        └─ pipedrive.create_activity ► POST /v1/activities ────────────────────────► audit row
                                                       │
                                                       ▼
                                            pipedrive_writes table (Supabase)
                                            { caller_slack_id, action, resource_type,
                                              resource_id, request, response, status }
```

### Components affected

#### 1. `src/connectors/pipedrive/client.ts` — write methods

Currently the client is read-only. Add:

- `findPersonByEmail(email): Promise<{id:number; name:string} | null>` — uses `GET /v1/persons/search?term={email}&fields=email&exact_match=true&limit=5`. Returns the first hit (Pipedrive sorts by relevance). Returns null if zero hits.
- `findOrganizationByName(name): Promise<{id:number; name:string} | null>` — `GET /v1/organizations/search?term={name}&exact_match=true&limit=5`. Returns null if zero hits.
- `createPerson(input: { name: string; email?: string; phone?: string; orgId?: number }): Promise<{id:number; name:string}>` — `POST /v1/persons` with `{name, email: [{value, primary:true, label:'work'}], phone: [{value, primary:true, label:'work'}], org_id}`.
- `createOrganization(input: { name: string }): Promise<{id:number; name:string}>` — `POST /v1/organizations`.
- `createLead(input: { title: string; personId?: number; orgId?: number; ownerId?: number; value?: { amount: number; currency: string }; expectedCloseDate?: string; labelIds?: string[] }): Promise<PipedriveLead>` — `POST /v1/leads`. Lead id is a UUID.
- `createNote(input: { content: string; leadId?: string; dealId?: number; personId?: number; orgId?: number }): Promise<PipedriveNote>` — `POST /v1/notes`. Exactly one target id.
- `createActivity(input: { subject: string; type: string; dueDate?: string; dueTime?: string; durationMinutes?: number; note?: string; leadId?: string; dealId?: number; personId?: number; orgId?: number; userId?: number }): Promise<PipedriveActivity>` — `POST /v1/activities`.

All write methods reuse the existing rate-limit + retry helper if present; otherwise wrap with a 1-retry / 1-second-delay handler that's local to the new write surface.

A new file `src/connectors/pipedrive/client-write.ts` keeps the write surface separate from the read client, both for grep-ability and to keep the read client's bundle small. The existing `PipedriveApiClient` constructor accepts an optional `write: PipedriveWriteClient` parameter; if not provided, the client is read-only and write tools fail with `WRITE_CLIENT_NOT_CONFIGURED`.

Alternatively (and simpler): add the write methods directly to the existing `PipedriveApiClient` class. **Decision: extend the existing class.** The read/write split is artificial — both use the same auth + base URL + rate limit. A single class is what the Klaviyo connector does, so we follow that pattern.

#### 2. `src/connectors/pipedrive/connector.ts` — three new tool definitions

Add after the existing 11 tools, before `return [...]`:

**`pipedrive.create_lead`**
- Schema: `{title: string; personEmail?: string; personName?: string; personPhone?: string; orgName?: string; value?: number; currency?: string; labelIds?: string[]; expectedCloseDate?: string; note?: string}`.
- At least one of `personEmail`, `personName`, `orgName` must be set (zod `.refine(...)`).
- Behavior:
  1. Role check: `marketing | admin` else `FORBIDDEN`.
  2. Resolve person:
     - If `personEmail`: `findPersonByEmail`. If found: `personId = existing.id`. If not: create person with `{name: personName ?? personEmail, email: personEmail, phone: personPhone}`.
     - Else if `personName`: create person with `{name: personName, phone: personPhone}` (no dedup — name-only collisions are noisy).
     - Else: skip (lead will attach to org only).
  3. Resolve org:
     - If `orgName`: `findOrganizationByName`. If found: `orgId = existing.id`. If not: create org with `{name: orgName}`.
     - Else: skip.
  4. Create lead with `{title, personId, orgId, value: {amount, currency: currency ?? 'USD'}, labelIds, expectedCloseDate}`.
  5. If `note` provided: create note with `{content: note, leadId: lead.id}` (best-effort — note failure does NOT roll back the lead).
  6. Audit row: `{action: 'create_lead', resource_type: 'lead', resource_id: lead.id, request_payload: args, response_payload: {leadId, personId, orgId, personCreated, orgCreated}, status: 'success'}`.
  7. Return `{leadId, leadTitle, personId, personName, orgId, orgName, personCreated, orgCreated, pipedriveUrl}`.
- On any Pipedrive error: audit row with `status: 'failure'` and the error body, return `{error:{code, message}}`.

**`pipedrive.add_note`**
- Schema: `{targetType: 'lead'|'deal'|'person'|'org'; targetId: string; content: string (min 1, max 5000)}`. `targetId` is string because lead ids are UUIDs; we cast to number for deal/person/org before the API call.
- Behavior:
  1. Role check.
  2. Validate `targetId` shape: UUID for `lead`, integer for others. Else `INVALID_ARGS`.
  3. Call `createNote` with the right field. Pipedrive accepts plain text or HTML; we send plain text and let Pipedrive sanitize.
  4. Audit row with `action: 'add_note'`, `resource_type: 'note'`, `resource_id: note.id`.
  5. Return `{noteId, targetType, targetId}`.

**`pipedrive.create_activity`**
- Schema: `{subject: string; type: 'call'|'meeting'|'task'|'email'|'lunch' (default 'task'); dueDate?: string (YYYY-MM-DD); dueTime?: string (HH:MM); durationMinutes?: number (1..480); note?: string; attachToType?: 'lead'|'deal'|'person'|'org'; attachToId?: string; assigneeUserId?: number}`.
- Behavior:
  1. Role check.
  2. Map `attachToType`+`attachToId` → the right id field on the API payload (`lead_id` UUID, others integer).
  3. Call `createActivity`. Server defaults: if no `dueDate`, activity is open-ended (no calendar entry).
  4. Audit row.
  5. Return `{activityId, subject, dueDate, dueTime, attachToType, attachToId}`.

All three tools use the existing `getActor()` / `getActiveThread()` helpers; the actor's `slackUserId` is what populates `caller_slack_id` on the audit row.

#### 3. `src/storage/repositories/pipedrive-writes.ts` — NEW

```ts
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

export class PipedriveWritesRepo {
  constructor(private readonly client: SupabaseClient) {}
  async insert(input: Omit<PipedriveWriteRow, 'id' | 'createdAt'>): Promise<PipedriveWriteRow>;
  async listForCaller(slackUserId: string, limit?: number): Promise<PipedriveWriteRow[]>;
}
```

#### 4. Database migration — `migrations/0018_pipedrive_writes.sql`

```sql
CREATE TABLE IF NOT EXISTS pipedrive_writes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_slack_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('create_lead', 'add_note', 'create_activity')),
  pipedrive_resource_type text CHECK (pipedrive_resource_type IS NULL OR pipedrive_resource_type IN ('lead', 'note', 'activity', 'person', 'organization')),
  pipedrive_resource_id text,
  request_payload jsonb NOT NULL,
  response_payload jsonb,
  status text NOT NULL CHECK (status IN ('success', 'failure')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pipedrive_writes_caller_idx ON pipedrive_writes (caller_slack_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pipedrive_writes_resource_idx ON pipedrive_writes (pipedrive_resource_type, pipedrive_resource_id);
```

Apply via `mcp__supabase__apply_migration` against project `ykjjwszoxazzlcovhlgd` per the connector-adding process doc.

#### 5. `src/connectors/pipedrive/connector.ts` — `PipedriveConnectorDeps`

Add `writesRepo: PipedriveWritesRepo` to the constructor deps. Keep all other existing deps unchanged.

#### 6. `src/index.ts` — wiring

After `const pipedriveClient = new PipedriveApiClient({ apiToken: pipedriveApiToken });`, instantiate the repo and pass it:

```ts
const pipedriveWritesRepo = new PipedriveWritesRepo(supabase);
registry.register(new PipedriveConnector({
  client: pipedriveClient,
  writesRepo: pipedriveWritesRepo,
  getActor,
  getActiveThread,
}));
```

#### 7. `src/orchestrator/prompts.ts` — bullets

Add three bullets in the Pipedrive section (after the existing 11), with explicit trigger words:

```
• **`pipedrive.create_lead`** — capture a new B2B lead. Auto-finds the person by email and the org by name (creates them if absent). MARKETING/ADMIN only. Trigger words: "add X as a lead", "captura un lead", "create a lead for…", "new prospect from BDNY". Args: title, personEmail?, personName?, orgName?, value?, currency?, expectedCloseDate?, note?. At least one of personEmail/personName/orgName required.
• **`pipedrive.add_note`** — pin a note to an existing lead/deal/person/organization. MARKETING/ADMIN only. Trigger words: "note on the X lead", "log that…", "anota que…", "agrega una nota a…". Args: targetType ('lead'|'deal'|'person'|'org'), targetId (UUID for lead, integer for others), content.
• **`pipedrive.create_activity`** — schedule a Pipedrive activity (call/meeting/task/etc.). MARKETING/ADMIN only. Trigger words: "remind me to follow up with X", "schedule a call with…", "agendame seguimiento con…", "follow up next Tuesday at 3pm". Args: subject, type, dueDate?, dueTime?, durationMinutes?, note?, attachToType?, attachToId?, assigneeUserId?.
• All three tools require role=admin or role=marketing. Non-marketing/admin gets FORBIDDEN.
```

#### 8. `src/connectors/broadcast/intro-message.ts` — Pipedrive write callout

The intro already has a *💼 Sales Pipeline — Pipedrive* section listing read examples. After that section, add a sub-block analogous to the existing Klaviyo profile-management one:

```
*✏️ Pipedrive lead capture* — _admin / marketing roles only_

Marketing can write to Pipedrive from Slack — useful right after a trade show or a sales call:
• _"Add Foo Studio as a lead — contact is jane@foostudio.com (Jane Doe), value $5k"_ — creates the lead with auto-resolved person + organization (reuses if they already exist).
• _"Note on the Foo Studio lead: they want a custom matte black finish"_ — pin a free-form note to any lead/deal/person/org.
• _"Remind me to follow up with Foo Studio next Tuesday at 3pm"_ — schedule a call/meeting/task with optional due date+time and assignee.

Every write is audited with the Slack user who triggered it.
```

### Data flow — happy path (create_lead with new person + new org)

User: *"Add Foo Studio as a lead — contact jane@foostudio.com (Jane Doe), value $5k"* →
LLM (with role gate met) calls `pipedrive.create_lead({title:"Foo Studio", personEmail:"jane@foostudio.com", personName:"Jane Doe", orgName:"Foo Studio", value:5000, currency:"USD"})` →
Connector: role check passes →
Connector: `findPersonByEmail("jane@foostudio.com")` → null →
Connector: `createPerson({name:"Jane Doe", email:"jane@foostudio.com"})` → `{id: 9012}` →
Connector: `findOrganizationByName("Foo Studio")` → null →
Connector: `createOrganization({name:"Foo Studio"})` → `{id: 7843}` →
Connector: `createLead({title:"Foo Studio", personId:9012, orgId:7843, value:{amount:5000, currency:"USD"}})` → `{id:"lead-uuid", title:"Foo Studio", ...}` →
Connector: insert `pipedrive_writes` row with `status='success'` →
Connector: return `{leadId, leadTitle, personId, personName:"Jane Doe", orgId, orgName:"Foo Studio", personCreated:true, orgCreated:true, pipedriveUrl}` →
LLM composes user-facing reply.

### Error paths

| Scenario | Connector behavior |
|---|---|
| `personEmail` exists in Pipedrive (email matches existing person) | Reuse existing personId; `personCreated:false` in response. |
| `orgName` exact-match exists | Reuse existing orgId; `orgCreated:false`. |
| Pipedrive returns 4xx on `createPerson` | Audit `status='failure'` with the body. Return `{error:{code:'PIPEDRIVE_ERROR', status, message, body}}`. Lead NOT created. |
| Pipedrive returns 4xx on `createLead` AFTER person/org were created | Audit `status='failure'` with `partial: true` flag noting orphaned person/org ids. Return error. The orphaned person/org rows stay in Pipedrive (acceptable — they're not destructive) and can be cleaned up by Danny if needed. |
| `createNote` fails inside `create_lead`'s post-step | Lead succeeds; note failure logged; response has `noteSubmitted:false, noteError:msg`. |
| `targetType='lead'` but `targetId` isn't a UUID | Schema-level rejection: `INVALID_ARGS`. |
| Pipedrive 429 (rate limit) | Single retry after 1s. If still 429, return error. |
| Caller role is `user` | `FORBIDDEN`. |

### Configuration / feature flag

No flag. Same deploy pattern as Klaviyo writes — direct to `main` + `fly deploy`.

### Performance / cost

- `create_lead` worst case: 1 person-search + 1 org-search + 1 person-create + 1 org-create + 1 lead-create + 1 note-create = 6 sequential Pipedrive API calls. Each ~150ms; total ~900ms. Acceptable for an interactive Slack reply.
- `create_lead` best case (existing person + existing org, no note): 1 person-search + 1 org-search + 1 lead-create = ~450ms.
- `add_note` and `create_activity`: single API call each, ~150ms.
- Pipedrive rate limit: 100 requests / 2 seconds per token. Very safe at our volume.
- DB: one extra `pipedrive_writes` insert per tool call. Negligible.

---

## Testing Specification

### Layer 1 — unit tests (no API)

`tests/unit/connectors/pipedrive/client-write.test.ts` (NEW):
- ✅ `findPersonByEmail` returns `{id, name}` when search hits, null when empty.
- ✅ `findOrganizationByName` mirrors above.
- ✅ `createPerson` posts the right body, returns the parsed result.
- ✅ `createLead` mocks the underlying fetch; verifies the JSON payload shape, including `value: {amount, currency}` and `label_ids`.
- ✅ `createNote` with `lead_id` (UUID), `deal_id` (integer), `person_id`, `org_id` — verifies the right field is set per `targetType`.
- ✅ `createActivity` with subject + type + due fields.
- ✅ One retry on 429, then surface error.

`tests/unit/connectors/pipedrive/lead-tool.test.ts` (NEW):
- ✅ Role check: `user` → FORBIDDEN, no Pipedrive call made.
- ✅ Schema rejects `{title:"X"}` (no person/org info) with INVALID_ARGS.
- ✅ Happy path: `personEmail` not in Pipedrive, `orgName` not in Pipedrive → 4 client calls (find person, create person, find org, create org) + 1 lead create. Audit row inserted with `status='success'`.
- ✅ Email match found: 3 client calls (find person hit, find org, create org) + 1 lead create. `personCreated:false`.
- ✅ Note attached: extra `createNote` call after lead create. Note failure surfaces in response but doesn't roll back the lead.
- ✅ Lead create 4xx: returns error, audit row `status='failure'` with `partial:true` flag when person/org were created.

`tests/unit/connectors/pipedrive/note-tool.test.ts` (NEW):
- ✅ Lead UUID accepted, deal/person/org integer accepted.
- ✅ Lead with non-UUID targetId → INVALID_ARGS.
- ✅ Empty content → schema rejection.
- ✅ Pipedrive error → audit row `status='failure'`, error returned.

`tests/unit/connectors/pipedrive/activity-tool.test.ts` (NEW):
- ✅ Minimal `{subject, type:"task"}` succeeds.
- ✅ Full `{subject, type:"meeting", dueDate, dueTime, durationMinutes, attachToType:"lead", attachToId:"<uuid>"}` succeeds.
- ✅ Schema rejects unknown `type` value.
- ✅ Audit row inserted.

`tests/unit/storage/pipedrive-writes-repo.test.ts` (NEW):
- ✅ `insert` round-trips the row.
- ✅ `listForCaller` returns recent rows desc by createdAt with limit honored.

### Layer 2 — orchestrator integration tests with mocked LLM

Extend `tests/unit/orchestrator/csv-pending-routing.test.ts` pattern in a new file `tests/unit/orchestrator/pipedrive-write-routing.test.ts`:

- **A. Single-tool happy path.** User: *"Add jane@foo.com as a lead"*. Expected: `[pipedrive.create_lead]` → success.
- **B. Compound conversational turn.** User: *"I had a great call with Foo Studio (jane@foostudio.com). Add them as a lead, note that they want a matte black finish, and remind me to follow up Tuesday at 3pm"*. Expected: `[pipedrive.create_lead, pipedrive.add_note, pipedrive.create_activity]` in order, with the note + activity referencing the lead id from step 1.
- **C. Role gate.** Caller is role=`user`. Expected: zero tool calls; LLM's text response explains the gate.
- **D. Off-topic mid-flow.** Pending Pipedrive context isn't a thing here (no pending state for these tools), so this is just a normal conversation; the LLM should not auto-call writes from a question like *"how many leads were created last week?"* — that's a read tool.

### Layer 3 — E2E smoke checklist (manual, pre-deploy)

In a Slack DM with the bot, role=admin:
1. *"Add e2e-test@example.com as a lead with org E2E Test Co"* → expect lead created, person + org created, audit row in Supabase.
2. *"Note on lead <uuid from step 1>: smoke test note"* → expect note attached, visible in Pipedrive UI.
3. *"Schedule a task to follow up with E2E Test Co next week"* → expect activity created with `dueDate ≈ today+7`.
4. *"Add e2e-test@example.com as a lead again"* (same email) → expect person reused (`personCreated:false` in response), org reused, new lead.
5. As role=user (Lana before her role change, or a test user temporarily set to `user`): *"Add a lead"* → expect FORBIDDEN reply.
6. Cleanup: archive/delete the test leads + the E2E Test Co organization in Pipedrive UI; delete the test person if desired.

Audit verification: `SELECT * FROM pipedrive_writes ORDER BY created_at DESC LIMIT 10;` should show all 4 successful writes from the smoke run with `caller_slack_id = U_DANNY`.

### Coverage gate

Layers 1+2 must pass in CI. Layer 3 is a pre-deploy manual checklist; failure on any item blocks deploy.

---

## Operational Specification

### Deploy

1. Apply migration `0018_pipedrive_writes.sql` to the Supabase project (manual via `mcp__supabase__apply_migration`).
2. `git push origin main` + `fly deploy`.
3. Verify `/healthz` + `/readyz`, then run the Layer 3 smoke checklist.

### Rollback

If the new tools misbehave: revert the merge commit + redeploy. The migration is additive (only adds `pipedrive_writes`) so no schema rollback is needed; the table just goes unused.

### Observability

New log lines (pino, info level):
- `pipedrive_lead_created`: `{caller, lead_id, person_id, org_id, person_created, org_created}`.
- `pipedrive_note_created`: `{caller, note_id, target_type, target_id}`.
- `pipedrive_activity_created`: `{caller, activity_id, attach_to_type, attach_to_id}`.
- `pipedrive_write_failed`: `{caller, action, error_code, status}` at warn level.

### Alerting

No new alerts. Standard error rate dashboards already cover `pipedrive_write_failed` patterns by virtue of the `error` field in the conversation logs.

---

## Security Specification

- All three tools call `usersRepo.getRole(actor.slackUserId)` and short-circuit `FORBIDDEN` for anything other than `admin` / `marketing`. Same gate as Klaviyo writes.
- `caller_slack_id` is logged on every audit row, providing a forensic trail Pipedrive's own logs lack.
- No PII flows through the LLM context beyond what the user themselves typed (the prompt-side note about pending CSV state, used in the CSV reply routing, has no analog here).
- The Pipedrive API token is read from the existing vault entry `PIPEDRIVE_API_TOKEN`. No new secret.
- Failure audit rows include the request payload (which may contain personal info — emails, names, phones — that the user just dictated). This is acceptable since the same data is already in `conversations.tool_calls` for the same Slack message.

---

## Related Work

- `2026-05-05-klaviyo-import-design.md` — same role-gate + audit pattern, conceptually parallel.
- `2026-05-06-csv-import-reply-routing-design.md` — sets the precedent for LLM-driven tool dispatch in marketing flows; Tier 2 of this Pipedrive plan will reuse the LLM header-mapper from there.
- The 11 existing read tools in `pipedrive/connector.ts` — unchanged.

---

## Open Questions

1. **Should `pipedrive.create_lead` also accept a comma-separated list of contacts for batch creation?** Decision: no, defer to Tier 2's bulk-CSV. Marketing's "batch" flow is a CSV from a trade-show export, not a hand-typed list.
2. **Should the `note` parameter on `create_lead` be its own follow-up tool call from the LLM (so it's auditable separately) instead of an embedded post-step?** Decision: keep it embedded for the conversational flow ("create lead with note X" is one user intent); the LLM is free to also call `pipedrive.add_note` separately when it's a true second action.
3. **Should we map Slack user → Pipedrive user for `owner_id` assignment?** Decision: defer to Tier 2 with an explicit `bot.set_pipedrive_user_id` admin tool. Tier 1 leaves owner = API-token user.

---

## Future Work

- **Tier 2:** `pipedrive.bulk_create_leads_from_csv` (LLM header mapper, same pattern as Klaviyo CSV).
- **Tier 2:** `pipedrive.update_lead` (qualify / archive / change labels).
- **Tier 2:** Slack→Pipedrive user mapping for `owner_id`.
- **Tier 3:** `pipedrive.attach_file` (multipart + Supabase Storage forensic copy).
- **Tier 3:** Custom-field setter (`pipedrive.set_lead_field`).
