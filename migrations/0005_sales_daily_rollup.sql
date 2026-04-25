create table if not exists sales_daily_rollup (
  date date primary key,
  total_orders int not null default 0,
  total_revenue_cents bigint not null default 0,
  by_type jsonb not null default '{}'::jsonb,
  by_status jsonb not null default '{}'::jsonb,
  by_organization jsonb not null default '{}'::jsonb,
  refreshed_at timestamptz not null default now()
);

create index if not exists sales_daily_rollup_refreshed_idx
  on sales_daily_rollup (refreshed_at);
