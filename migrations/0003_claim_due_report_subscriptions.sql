-- Atomically pick up to `p_limit` enabled subscriptions whose next_run_at <= p_now
-- and bump their next_run_at by 1 minute (a sentinel; the runner will overwrite
-- with the cron-computed next fire after a successful or failed run). Uses
-- FOR UPDATE SKIP LOCKED so multiple runners can be safely attempted in parallel.
create or replace function claim_due_report_subscriptions(
  p_now timestamptz,
  p_limit int
) returns setof report_subscriptions
language plpgsql as $$
begin
  return query
  with due as (
    select id from report_subscriptions
    where enabled and next_run_at <= p_now
    order by next_run_at
    limit p_limit
    for update skip locked
  )
  update report_subscriptions r
    set next_run_at = p_now + interval '1 minute'
    from due
    where r.id = due.id
    returning r.*;
end $$;

grant execute on function claim_due_report_subscriptions(timestamptz, int) to service_role;
