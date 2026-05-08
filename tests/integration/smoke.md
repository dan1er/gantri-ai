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

## CSV-import reply routing (added 2026-05-06)

Run after deploys that touch `confirmation-handler.ts`, `orchestrator.ts`, the slack handler's pending-context wiring, or the klaviyo `runImport` resolver. Use a throwaway list named `e2e-test-throwaway` (and `e2e-throwaway-2`); clean up afterwards.

10. Upload a 5-row CSV in DM with the bot. Expect "Got 5 rows… Which Klaviyo list?".
11. Reply `cancel`. Expect "Cancelled. CSV import not submitted." Verify no Klaviyo write happened.
12. Re-upload the CSV. Reply `e2e-test-throwaway` (assumes the list exists). Expect "Submitted 5 profiles to Klaviyo (list: e2e-test-throwaway)…"; verify a `klaviyo_imports` audit row appears in Supabase.
13. Re-upload. Reply `e2e-throwaway-2, créala si no existe` (list does NOT exist). Expect a "Created list 'e2e-throwaway-2'. Submitted 5 profiles…" reply. Verify both the new list in Klaviyo AND the audit row.
14. Re-upload. Reply with a list name that does not exist and no create instruction (e.g. `lista que no existe`). Expect "There's no list called 'lista que no existe'. Want me to create it?". Reply `yes`. Expect list creation + import.
15. Re-upload. Reply `no list`. Expect import success without list-membership (`list: null` in audit).
16. Re-upload. Wait 31 minutes (or manually expire the pending row in Supabase). Reply with anything. Expect the bot to behave as if no pending exists (no auto-import).
17. Logs: `fly logs -a gantri-ai-bot | grep -E "klaviyo_csv_(cancelled|routed_to_orchestrator|listLists_failed)|klaviyo_import_submitted"` should show `klaviyo_csv_cancelled` from step 11, `klaviyo_csv_routed_to_orchestrator` from steps 12–15, and `klaviyo_import_submitted` from steps 12–15.

Cleanup: archive the throwaway lists in Klaviyo and bulk-delete imported test profiles via `klaviyo.delete_profiles`.

## Pipedrive write tools — Tier 1 (added 2026-05-07)

Run after deploys that touch `src/connectors/pipedrive/connector.ts`, `src/connectors/pipedrive/client.ts`, or `migrations/0018_pipedrive_writes.sql`. Use a throwaway organization name (`E2E Test Co`) and a throwaway email (`e2e-test@example.com`); clean up afterwards.

18. As role=admin in DM with the bot: _"Add e2e-test@example.com as a lead with org E2E Test Co"_. Expect a "Created lead" reply with `personCreated:true`, `orgCreated:true`. Verify a `pipedrive_writes` row appears in Supabase with `status='success'`.
19. _"Note on lead <uuid from step 18>: smoke test note"_. Expect "Note added". Verify the note appears in Pipedrive's UI under that lead.
20. _"Schedule a task to follow up with E2E Test Co next week"_. Expect activity created with `dueDate ≈ today+7`. Verify the activity in Pipedrive.
21. _"Add e2e-test@example.com as a lead again"_ (same email). Expect `personCreated:false` (re-used the existing person). New lead is created.
22. As role=user (a temporarily-demoted admin or a test user): _"Add a lead"_. Expect "Pipedrive write tools require the admin or marketing role" reply.
23. Logs: `fly logs -a gantri-ai-bot | grep -E "pipedrive_(lead|note|activity)_created|pipedrive_write_failed"` should show 3 success log lines from steps 18-21 and zero failures.

Cleanup: archive/delete the test leads, the E2E Test Co organization, and the test person in the Pipedrive UI.

## CX customer-email flow — Tier 1 (added 2026-05-08)

Run after deploys that touch `gantri-porter-connector.ts`,
`klaviyo/client.ts`, or `migrations/0023_gantri_writes.sql`.
Defaults to staging (`PORTER_WRITE_TARGET=staging`).

24. Confirm bot startup log line: `fly logs -a gantri-ai-bot | grep
    gantri_porter_write_target` — should show
    `porter_write_target=staging` (or `prod` after Danny flips it).
25. Run the staging smoke: `fly ssh console -a gantri-ai-bot -C
    'cd /app && node scripts/smoke-update-customer-email-staging.mjs'`.
    Expect "✅ STAGING SMOKE PASSED".
26. From Slack DM with the bot, as Zuzanna (role=cx) or Danny
    (role=admin): _"modify email on order 43785 to test-cx@gantri.com"_
    against a real staging order if one exists, or skip this step
    until staging seed data is present.
27. Reply *yes* to the preview. Verify reply prefix says
    "_(staging mode)_". Verify a row appears in `gantri_writes` with
    `write_target='staging'`, `status='success'`.
28. As role=user (e.g. Lana): same prompt → expect FORBIDDEN reply
    text including "cx or admin".
29. Logs: `fly logs -a gantri-ai-bot | grep -E
    "gantri_customer_email_(porter_updated|klaviyo_synced|klaviyo_skipped|klaviyo_failed|failed)"` — expect 1 success
    log per smoke run, zero failures.

When ready to flip to prod:
- `fly secrets set PORTER_WRITE_TARGET=prod -a gantri-ai-bot`
- Re-run step 24 to confirm the env reflects `prod`.
- Run a real CX ticket (e.g. Zuzanna's pending request) end-to-end and
  verify the audit row shows `write_target='prod'`.

Log the result of the run (pass/fail per step) in the deploy PR.
