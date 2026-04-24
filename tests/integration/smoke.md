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
