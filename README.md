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
