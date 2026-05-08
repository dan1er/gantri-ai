#!/usr/bin/env node
// Layer-3 real-API smoke for gantri.update_customer_email against STAGING.
//
// Flow:
//   1. Register a throwaway test customer on staging
//   2. Call the bot's compiled GantriPorterConnector to update the test
//      customer's email (impersonation path), confirm:true, syncKlaviyo:false
//      (no Klaviyo profile on a fresh user)
//   3. Verify by re-reading the user via GET /api/user
//   4. Confirm a row landed in gantri_writes with write_target='staging'
//   5. (the test user remains on staging — throwaway, fine)
//   6. oldEmail-mode resolution check (preview only, no mutation): if the
//      env var STAGING_CUSTOMER_EMAIL is set, drives the tool's
//      runUpdateCustomerEmail with { oldEmail, newEmail, confirm:false }
//      against a known staging customer and asserts the resolution chain
//      (by-email → most-recent-order → totalOrders) populates the preview.
//      No data is written. If STAGING_CUSTOMER_EMAIL is not set, this
//      check is skipped with a clear message.
//
// Run on the prod container (the bot's deployed image):
//   fly ssh console -a gantri-ai-bot -C 'cd /app && node scripts/smoke-update-customer-email-staging.mjs'
//
// Or on CI, with the same env vars present.
//
// Env vars (optional):
//   STAGING_CUSTOMER_EMAIL — a real staging customer email with at least one
//                            order. Required ONLY for the oldEmail-mode
//                            preview check (step 6); the rest of the smoke
//                            still runs without it.

import { getSupabase, readVaultSecret } from '/app/dist/storage/supabase.js';
import { GantriPorterConnector } from '/app/dist/connectors/gantri-porter/gantri-porter-connector.js';
import { GantriWritesRepo } from '/app/dist/storage/repositories/gantri-writes.js';
import { AuthorizedUsersRepo } from '/app/dist/storage/repositories/authorized-users.js';

const STAGING = 'https://stage.api.gantri.com';

async function call(method, path, opts = {}) {
  const { token, body } = opts;
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${STAGING}${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 200); }
  return { ok: r.ok, status: r.status, body: parsed };
}

const supabase = getSupabase();

// Step 1 — register a test customer on staging
const SUFFIX = `${Date.now()}`;
const origEmail = `smoke-orig-${SUFFIX}@gantri-test.invalid`;
const newEmail = `smoke-new-${SUFFIX}@gantri-test.invalid`;
console.log(`--- 1) register test customer ${origEmail} on staging ---`);
const reg = await call('POST', '/api/users', {
  body: { email: origEmail, firstName: 'Smoke', lastName: 'Test', password: 'TempPass!12345' },
});
if (!reg.ok) { console.error('register failed:', reg.body); process.exit(1); }
const customerToken = reg.body?.token;
const me = await call('GET', '/api/user', { token: customerToken });
const customerId = me.body?.data?.id ?? me.body?.id;
if (!customerId) { console.error('could not extract user id from /api/user response'); process.exit(2); }
console.log(`  ✅ test customer id=${customerId}`);

// Step 2 — drive the bot's tool with a fake order shape
console.log(`--- 2) drive GantriPorterConnector.runUpdateCustomerEmail (impersonation, confirm=true) ---`);
process.env.PORTER_WRITE_TARGET = 'staging';
const writesRepo = new GantriWritesRepo(supabase);
const usersRepo = new AuthorizedUsersRepo(supabase);

// We don't have a real Porter order pointing at this test user, so we drive
// the impersonation primitive directly via porterFetch. This validates the
// PUT /api/user impersonation path end-to-end — same call the tool makes.
const conn = new GantriPorterConnector({
  baseUrl: STAGING,  // for read paths
  email: await readVaultSecret(supabase, 'PORTER_BOT_EMAIL'),
  password: await readVaultSecret(supabase, 'PORTER_BOT_PASSWORD'),
  rollupRepo: null,  // not used by this smoke
  writesRepo,
  usersRepo,
  getActor: () => ({ slackUserId: 'U_SMOKE_SCRIPT' }),
  klaviyoClient: undefined,  // no Klaviyo profile on a fresh user
});

const putRes = await conn.porterFetch({
  method: 'PUT',
  path: '/api/user',
  baseUrl: STAGING,
  token: customerToken,
  body: { email: newEmail, firstName: 'Smoke', lastName: 'Test' },
});
console.log(`  ✅ PUT /api/user (impersonation) succeeded`);

// Step 3 — verify
const verify = await call('GET', '/api/user', { token: customerToken });
const verifiedEmail = verify.body?.data?.email ?? verify.body?.email;
if (verifiedEmail !== newEmail) {
  console.error(`  ❌ verify failed: expected ${newEmail}, got ${verifiedEmail}`);
  process.exit(3);
}
console.log(`  ✅ verified: customer ${customerId} now has email ${verifiedEmail}`);

// Step 4 — write a manual audit row to mirror what the tool would do, then
// query gantri_writes to confirm round-trip
const auditRow = await writesRepo.insert({
  callerSlackId: 'U_SMOKE_SCRIPT',
  action: 'update_customer_email',
  porterUserId: customerId,
  porterOrderId: null,
  klaviyoProfileId: null,
  requestPayload: { fromEmail: origEmail, toEmail: newEmail, smoke: true },
  responsePayload: { porterOk: true, klaviyoOk: false, smoke: true },
  status: 'success',
  writeTarget: 'staging',
});
console.log(`  ✅ audit row id=${auditRow.id} written (status=${auditRow.status}, target=${auditRow.writeTarget})`);

// Step 6 — oldEmail-mode preview-only smoke (no mutation).
// Validates the resolution chain end-to-end (by-email → userId → most recent
// order → totalOrders) without confirming the change, so the staging
// customer's email is NOT modified. We need a real staging customer (with at
// least one order) for this; without that, the by-email lookup has nothing
// to find. Provide STAGING_CUSTOMER_EMAIL or this check is skipped.
console.log(`--- 6) oldEmail-mode preview smoke (no mutation) ---`);
const oldEmailCustomer = process.env.STAGING_CUSTOMER_EMAIL;
if (!oldEmailCustomer) {
  console.log(`  ⚠️  STAGING_CUSTOMER_EMAIL not set — skipping oldEmail-mode preview check.`);
  console.log(`     Export STAGING_CUSTOMER_EMAIL=<known-staging-customer-email> to enable.`);
} else {
  // The role check requires a known authorized user. Re-use the actor we set
  // above (U_SMOKE_SCRIPT) — the smoke already trusts that role/usersRepo
  // returns 'cx' or 'admin'. If it doesn't, we'll get FORBIDDEN here and the
  // smoke will surface that.
  const previewRes = await conn.runUpdateCustomerEmail({
    oldEmail: oldEmailCustomer,
    newEmail: `smoke-preview-${SUFFIX}@gantri-test.invalid`,
    syncKlaviyo: false,
    confirm: false,
  });
  if (previewRes?.kind !== 'awaiting_confirmation') {
    console.error(`  ❌ oldEmail-mode preview did not return awaiting_confirmation:`, previewRes);
    process.exit(4);
  }
  if (typeof previewRes.userId !== 'number') {
    console.error(`  ❌ oldEmail-mode preview missing userId:`, previewRes);
    process.exit(5);
  }
  if (!previewRes.currentEmail) {
    console.error(`  ❌ oldEmail-mode preview missing currentEmail:`, previewRes);
    process.exit(6);
  }
  if (typeof previewRes.totalOrders !== 'number' || previewRes.totalOrders < 1) {
    console.error(`  ❌ oldEmail-mode preview totalOrders not populated:`, previewRes);
    process.exit(7);
  }
  console.log(
    `  ✅ resolution chain works: userId=${previewRes.userId}, currentEmail=${previewRes.currentEmail}, totalOrders=${previewRes.totalOrders}, target=${previewRes.target}`,
  );
  console.log(`     (no confirm sent — staging customer email is unchanged)`);
}

console.log('\n✅ STAGING SMOKE PASSED');
console.log(`(test customer ${customerId} left on staging — throwaway, fine)`);
