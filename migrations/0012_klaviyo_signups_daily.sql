-- One row per Pacific-Time calendar day. `signups_total` is profiles whose
-- `created` timestamp falls in that PT day. `signups_consented_email` is the
-- subset whose subscriptions.email.marketing.consent equals 'SUBSCRIBED' at
-- the moment the rollup ran (drift-tolerant by design).
create table if not exists klaviyo_signups_daily (
  day date primary key,
  signups_total integer not null default 0,
  signups_consented_email integer not null default 0,
  computed_at timestamptz not null default now()
);

create index if not exists klaviyo_signups_daily_computed_at_idx
  on klaviyo_signups_daily (computed_at);
