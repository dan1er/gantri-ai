# Slack dev-ops orchestrator — on-demand previews & deploys

**Status:** design approved, ready for implementation plan
**Phase 1 = dumb GitHub Actions — no AWS, nothing real is created.** The bot really dispatches workflows and polls them; the workflows just validate inputs, sleep, and echo a deterministic URL. So the whole **bot → GitHub → Slack** path is real from day 1 — only the workflow body is stubbed. Going live = filling the workflows in.
**Owner:** Danny
**Repo:** `gantri-ai-bot` (Node + Slack Bolt, Fly.io, secrets in Supabase Vault)
**Related:** the *Preview Environments & Continuous Delivery* process doc (Notion). This is the **on-demand front door + reporter** for the preview/release engine that doc designs (§5 frontend coupling, §6 Porter previews, §4 release model). It does **not** re-implement orchestration.

---

## 1. Goal & shape

Give developers a small **command framework** living in **one dev-ops Slack channel**. Everything the bot does for dev-ops appears there, so the whole team is aware.

Two kinds of action, each offering the same three-way choice — **Backend / Frontend / Full stack**:

| Action | What it does | Teardown action |
|---|---|---|
| **Preview** | Spin up a preview environment **on demand** (not auto per PR — saves cost) | **Tear down** |
| **Deploy** | Ship the merged build to **production** | **Roll back** |

Each action can be triggered two ways:

- **A slash command** the dev types: `/preview`, `/deploy`.
- **A GitHub event:** when a PR merges to `master`, the bot posts a prompt asking whether to deploy it to production (**Yes / No**).

Both kinds of trigger funnel into the **same job pipeline** (§6–7): dispatch a GitHub workflow → poll → report progress + result in the channel.

**Shared substrate** (built once, reused by every command): channel binding, the Backend/Frontend/Full-stack selector, the `jobs` table + poller, the channel reporting, and the dumb-action dispatch. Adding a future command = define its workflows + labels.

## 2. The dev-ops channel

Everything runs in **the bot's dev-ops channel** (`OPS_CHANNEL_ID` = `C0B8XD4LSLC`, workspace `T03KJCV1P`) — shared by every bot command (previews, deploys, and future integrations). It's **private** for now (just Danny) and opens to the team later; **the gantri-ai-bot app must be invited to the channel** before the commands are wired up. A command is **bound to that channel**: invoked elsewhere, the bot replies ephemerally — *"run this in the dev-ops channel"* — and does nothing. All progress and results post **only** there.

## 3. Triggers (entry points)

- **`/preview`** → 3 buttons (**Backend · Frontend · Full stack**) → a type-specific modal → a **preview** job.
- **`/deploy`** → 3 buttons → a type-specific modal → a **deploy** job.
- **PR merged to `master`** → a GitHub webhook hits the bot → it posts *"`#1234` (AS-2215) merged to master — deploy to production? **[Yes] [No]**"*. **Yes** starts a **deploy** job (same as `/deploy`); **No** dismisses.

> The merge-prompt makes production a **human-gated** step: merge auto-deploys to staging, and a Slack button promotes to prod. (This is the process doc's "release now" gate, made the default.)

The webhook is a signed `POST /github/webhook` endpoint on the bot's existing Express receiver, filtered to `pull_request` `closed` + `merged` on `master`.

## 4. Preview jobs (`/preview`)

The three cases are **independent**; linking only happens in Full stack, and it is **explicit** (the human picks both halves — frontend and backend do **not** necessarily share a ticket).

**Modals / inputs:**
- **Backend:** `porter` PR# or branch. The URL **slug** derives from the branch (`feat/as-2215-…` → `as-2215`; else a sanitized branch slug). URL = `https://<slug>.api.preview.gantri.com`.
- **Frontend:** repo dropdown (**mantle / core / made**) + PR#/branch → **always staging**.
- **Full stack:** `porter` PR#/branch + frontend repo + frontend PR#/branch.

**What each does:**
- **Backend:** dispatch Porter `preview-create` `{ ref, slug }`; ready = backend up.
- **Frontend (staging):** Vercel already builds the PR's preview against staging — the bot just reads + posts that deployment URL (trivial path).
- **Full stack:** backend flow → when the backend is ready, set the frontend's **API-URL build var, scoped to that branch**, to the backend URL — `NEXT_PUBLIC_API_URL` (mantle) / `VITE_API_URL` (made) / `REACT_APP_API_URL` (core). Vercel bakes it into that branch's build; branch scope = no collision, no effect on staging/prod or other branches. → redeploy → poll until `READY` → post both URLs.

**Teardown:** a **Tear down** button on the result + `/preview down <slug>` → dispatch Porter `preview-teardown` `{ slug }` (delete namespace + `DROP DATABASE pr_<slug>` + Mongo db; ephemeral Redis dies with the namespace) + remove the branch-scoped Vercel var. Plus a **nightly reaper** (tear down previews older than `N` hours, default 12). Pause-to-zero in AWS = later.

## 5. Deploy jobs (`/deploy` and the merge-prompt)

- **Backend** → deploy `porter` to production. **Frontend** → deploy a frontend app to production. **Full stack** → both.
- A deploy **promotes the already-validated build** (process doc §4) — no rebuild. *(No version tags: "the associated release" = the build of that `master` commit; the deployment record is the release.)*
- The result message carries a **Roll back** button (`vercel rollback` for frontends / `kubectl rollout undo` for Porter) instead of **Tear down**.

### Pre-deploy drift check

Before a deploy runs, the bot compares **what's in production** to the **commit being deployed**, per project (GitHub compare: `base = prod SHA`, `head = target SHA`). If the gap includes merges **not made by the requester**, it surfaces them — so you never silently ship someone else's un-deployed work:

> ⚠️ Deploying `mantle` will also ship 2 changes that aren't yours:
> • `#1240` AS-2301 — @ana
> • `#1242` AS-2305 — @luis
> **[ Proceed anyway ]  [ Ping authors ]  [ Cancel ]**

- **Proceed anyway** → the deploy runs (commits are cumulative on `master` — a later one always contains the earlier ones, so this ships everything up to the target).
- **Ping authors** → the bot @-mentions the listed devs in the channel so they decide: OK to ship, or **revert** their change first.
- **Cancel** → nothing.

This is the cumulative-history guard made visible: the only safe options are *ship the extra changes knowingly* or *get them out of the way (revert)* — the process doc's "if it can't ship, revert" rule, enforced at the gate. ("What's in production" = the last successful production deployment's ref, from GitHub Deployments; in Phase 1 it's simulated.)

## 6. Orchestration (model A — dumb actions now)

The bot never blocks; it advances a persisted job from a background poller. **It always `workflow_dispatch`es a GitHub workflow and polls — that integration is real from day 1.** In Phase 1 the workflows are **dumb** (validate inputs, sleep, echo the deterministic URL — no AWS). Readiness in Phase 1 = the run completed; the `health/live` 200 gate (backend) and Vercel `READY` gate (frontend) are added when the workflows do real work. Going live is filling in workflow bodies — **no bot change**.

## 7. Jobs table + poller

One Supabase table makes jobs durable across bot restarts and drives the live Slack updates — same pattern as the existing reports-runner / Klaviyo poller.

**`jobs`**
| column | notes |
|---|---|
| `id` | uuid |
| `kind` | `preview` \| `deploy` |
| `target` | `backend` \| `frontend` \| `fullstack` |
| `status` | `pending` → `backend_running` → `frontend_running` → `ready` \| `failed` \| `torn_down` |
| `spec` | jsonb: repos, refs, slug, urls, backend_url |
| `requested_by` | Slack user id |
| `trigger` | `command` \| `merge_prompt` |
| `channel_id`, `message_ts` | the message to update |
| `error`, `created_at`, `updated_at` | |

**Poller** (~10s interval): for each non-terminal job, advance by `kind`+`target`+`status` (check the workflow run / health URL / Vercel deployment), persist, and `chat.update` the Slack message (steps with ⏳/✓/✗, then final summary + URLs + the Tear-down/Roll-back button). On error → `failed`, message shows what failed + the run link.

## 8. Where the code goes (`gantri-ai-bot`)

- `src/slack/devops/commands.ts` — registers `/preview` + `/deploy` (`app.command`), the buttons (`block_actions`), the modals (`view_submission`), and the Tear-down / Roll-back / merge-prompt Yes-No buttons. **First interactive components in the bot** — Bolt supports them directly.
- `src/slack/devops/webhook.ts` — `POST /github/webhook` (signature-verified) → on PR-merged-to-master, post the deploy prompt.
- `src/devops/` — substrate, isolated from Slack:
  - `github.ts` — `workflow_dispatch` + poll runs (Octokit).
  - `vercel.ts` — read deployments, set branch-scoped env vars, redeploy, poll `readyState`, rollback.
  - `jobs.ts` — the `jobs` store + the poller that advances jobs and updates Slack.
  - `slug.ts` — derive the slug from a branch/PR.
- `src/index.ts` — wire commands + webhook, start the poller after the Slack client is up.
- **New Vault secrets / config:** a GitHub token (`workflow` scope on `porter` + the frontends) + the webhook signing secret; a Vercel token (read deployments, set env vars, redeploy, rollback); **`OPS_CHANNEL_ID`** — the dev-ops channel every command binds to.

## 9. Build order (phases — bot code is identical across all of them)

1. **Phase 1 — dumb workflows (build now).** Full `/preview` + `/deploy` + the merge-prompt + modals + `jobs` lifecycle + channel reporting + teardown/rollback, dispatching **dumb** GitHub Actions that sleep + echo — **no AWS**. The bot → GitHub → Slack path is fully real and demoable in the channel.
2. **Phase 2 — real backend.** Fill Porter's `preview-create` / `preview-teardown` and the deploy workflows with the real §6/§4 steps; add the `health/live` 200 gate. **No bot change.**
3. **Phase 3 — real frontend.** Switch the frontend half to the real Vercel calls (read deployment, set the branch-scoped API-URL var, redeploy, rollback).

The Full-stack frontend wiring needs **no** §5 / `resolve-backend.js` work — the bot sets each app's existing API-URL build var directly (§4).

## 10. Out of scope (MVP)

- Pause-to-zero / AWS scale-down (full teardown only).
- Permission gating (any channel member may run any command).
- Concurrency caps (rely on §6's namespace quota).
- Pointing a frontend at another dev's live backend (Frontend → staging; only Full stack links).
- Mongo/Redis/secret-allowlist internals (owned by the §6 workflow).

## 11. Naming

- Channel config: **`OPS_CHANNEL_ID`** (the dev-ops channel — pick a broad name, see below).
- Commands: **`/preview`**, **`/deploy`**. Actions: **Backend · Frontend · Full stack**. Teardown: **`/preview down <slug>`** + the **Tear down** / **Roll back** buttons.
