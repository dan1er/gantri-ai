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
