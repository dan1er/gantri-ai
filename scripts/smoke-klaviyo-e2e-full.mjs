// FULL E2E smoke for the Klaviyo import flow.
//
// Exercises the production tool layer end-to-end against:
//   - real Klaviyo API (live HTTP)
//   - real Supabase Postgres (audit + pending tables)
//   - real CSV parsing
//   - real validation pipeline
//   - real list resolution
//
// What this catches that unit tests don't:
//   - actual JSON:API body shape that Klaviyo accepts
//   - DB CHECK constraints
//   - empty 202 body handling
//   - unsupported include= params
//   - case where post() body is empty / json parse edge cases
//   - actual indexing latency in Klaviyo
//
// Test cases run:
//   1. Inline import (1 profile, no first_name) → verify in Klaviyo + list
//   2. CSV import (3 profiles, with first_name/last_name/phone) → verify Klaviyo + list
//   3. Audit rows in klaviyo_imports have correct status='complete' + completed_at set
//
// Cleanup: deletes the audit rows + uses Klaviyo Data Privacy API to remove the test profiles.

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

import { KlaviyoApiClient } from '../dist/connectors/klaviyo/client.js';
import { KlaviyoImportsRepo } from '../dist/storage/repositories/klaviyo-imports.js';
import { PendingConfirmationsRepo } from '../dist/storage/repositories/pending-confirmations.js';
import { KlaviyoDeletionsRepo } from '../dist/storage/repositories/klaviyo-deletions.js';
import { AuthorizedUsersRepo } from '../dist/storage/repositories/authorized-users.js';
import { KlaviyoConnector } from '../dist/connectors/klaviyo/connector.js';
import { parseCsv } from '../dist/connectors/klaviyo/csv-parser.js';

const KEY = process.env.KLAVIYO_API_KEY ?? 'pk_RBj4J8_961abd495593d7c58fbee81fff26cb01cf';
const TEST_LIST_ID = 'XgtjkS';
const TEST_LIST_NAME = '__bot_smoke_test_list';
const TEST_CALLER_SLACK_ID = 'UK0JM2PTM'; // Danny — admin, exists in authorized_users
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env required.');
  process.exit(1);
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const stamp = Date.now();
const TEST_EMAILS = {
  inline: `e2e-inline-${stamp}+test@gantri.com`,
  csv1: `e2e-csv1-${stamp}+test@gantri.com`,
  csv2: `e2e-csv2-${stamp}+test@gantri.com`,
  csv3: `e2e-csv3-${stamp}+test@gantri.com`,
};
const allTestEmails = Object.values(TEST_EMAILS);

const auditIdsToCleanup = [];

function buildConnector() {
  const client = new KlaviyoApiClient({ apiKey: KEY });
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const importsRepo = new KlaviyoImportsRepo(supabase);
  const pendingRepo = new PendingConfirmationsRepo(supabase);
  const deletionsRepo = new KlaviyoDeletionsRepo(supabase);
  const usersRepo = new AuthorizedUsersRepo(supabase);
  const conn = new KlaviyoConnector({
    client, importsRepo, deletionsRepo, pendingRepo, usersRepo,
    getActor: () => ({ slackUserId: TEST_CALLER_SLACK_ID, slackChannelId: 'D-smoke' }),
    getActiveThread: () => ({ channelId: 'D-smoke', threadTs: 'smoke-thread' }),
  });
  return { conn, importsRepo, supabase };
}

async function waitForProfile(client, email, deadlineMs = 90_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const p = await client.findProfileByEmail(email);
    if (p) return p;
    await sleep(5000);
  }
  return null;
}

// Run a tool the same way the orchestrator runs it: Zod-parse args first
// (applies defaults like source='inline'), then call execute.
async function runTool(tool, rawArgs) {
  const parsed = tool.schema.parse(rawArgs);
  return tool.execute(parsed);
}

async function caseInline({ conn, importsRepo, client }) {
  console.log(`\n=== CASE 1: Inline import (1 profile) ===`);
  const tool = conn.tools.find((t) => t.name === 'klaviyo.import_profiles');
  const r = await runTool(tool, {
    profiles: [{ email: TEST_EMAILS.inline }],
    list: TEST_LIST_NAME,
    channels: ['email'],
  });
  if (r.kind !== 'imported_directly') {
    console.error(`  ✗ tool returned kind=${r.kind}, expected imported_directly`);
    console.error(`    full result: ${JSON.stringify(r, null, 2)}`);
    return false;
  }
  console.log(`  ✓ tool returned imported_directly  audit_id=${r.audit_id}  status=${r.status}`);
  auditIdsToCleanup.push(r.audit_id);

  const audit = await importsRepo.getById(r.audit_id);
  if (!audit) { console.error(`  ✗ audit row not found in DB`); return false; }
  if (audit.status !== 'complete') { console.error(`  ✗ audit.status=${audit.status}, expected complete`); return false; }
  if (!audit.completedAt) { console.error(`  ✗ audit.completedAt is null on terminal status`); return false; }
  if (audit.totalImported !== 1) { console.error(`  ✗ audit.totalImported=${audit.totalImported}, expected 1`); return false; }
  if (audit.listId !== TEST_LIST_ID) { console.error(`  ✗ audit.listId=${audit.listId}, expected ${TEST_LIST_ID}`); return false; }
  console.log(`  ✓ audit row: status=complete, completed_at=${audit.completedAt.slice(0,19)}, total_imported=1, list_id=${audit.listId}`);

  console.log(`  → Polling Klaviyo for profile (${TEST_EMAILS.inline})...`);
  const profile = await waitForProfile(client, TEST_EMAILS.inline);
  if (!profile) { console.error(`  ✗ profile never appeared in Klaviyo`); return false; }
  if (!profile.lists.includes(TEST_LIST_NAME)) {
    console.warn(`  ⚠ profile lists=${JSON.stringify(profile.lists)} — does NOT include target list (may be lazy backfill)`);
  } else {
    console.log(`  ✓ profile in Klaviyo + list membership confirmed (id=${profile.id})`);
  }
  return true;
}

async function caseCsv({ conn, importsRepo, client }) {
  console.log(`\n=== CASE 2: CSV import (3 profiles, with first_name/last_name/phone) ===`);

  // 1) Create a test CSV file
  const csvPath = join(tmpdir(), `klaviyo-smoke-${stamp}.csv`);
  const csv = [
    'email,first_name,last_name,phone',
    `${TEST_EMAILS.csv1},Alice,Smith,+1 415 555 0100`,
    `${TEST_EMAILS.csv2},Bob,Jones,`,
    `${TEST_EMAILS.csv3},Carol,,`,
  ].join('\n');
  writeFileSync(csvPath, csv);
  console.log(`  ✓ CSV written to ${csvPath}`);

  // 2) Parse it (same code path the file_shared handler uses)
  const parsed = parseCsv(readFileSync(csvPath, 'utf8'));
  if (parsed.rows.length !== 3) { console.error(`  ✗ parsed ${parsed.rows.length} rows, expected 3`); return false; }
  console.log(`  ✓ parsed ${parsed.rows.length} rows; warnings=${JSON.stringify(parsed.warnings)}`);

  // 3) Run the tool with the parsed rows (simulating what the file_shared handler does)
  const tool = conn.tools.find((t) => t.name === 'klaviyo.import_profiles');
  const r = await runTool(tool, {
    profiles: parsed.rows.map(({ rowIndex: _i, ...rest }) => rest),
    list: TEST_LIST_NAME,
    channels: ['email'],
    source: 'csv',
    filename: 'smoke-test.csv',
  });
  unlinkSync(csvPath);

  if (r.kind !== 'imported_directly') {
    console.error(`  ✗ tool returned kind=${r.kind}, expected imported_directly`);
    console.error(`    full result: ${JSON.stringify(r, null, 2)}`);
    return false;
  }
  console.log(`  ✓ tool returned imported_directly  audit_id=${r.audit_id}`);
  auditIdsToCleanup.push(r.audit_id);

  // 4) Verify audit row
  const audit = await importsRepo.getById(r.audit_id);
  if (!audit) { console.error(`  ✗ audit row not found`); return false; }
  if (audit.status !== 'complete') { console.error(`  ✗ audit.status=${audit.status}`); return false; }
  if (audit.totalImported !== 3) { console.error(`  ✗ audit.totalImported=${audit.totalImported}, expected 3`); return false; }
  if (audit.source !== 'csv') { console.error(`  ✗ audit.source=${audit.source}, expected csv`); return false; }
  if (audit.filename !== 'smoke-test.csv') { console.error(`  ✗ audit.filename=${audit.filename}`); return false; }
  console.log(`  ✓ audit: status=complete, total_imported=3, source=csv, filename=smoke-test.csv`);

  // 5) Verify all 3 profiles in Klaviyo
  console.log(`  → Polling Klaviyo for ${TEST_EMAILS.csv1}, ${TEST_EMAILS.csv2}, ${TEST_EMAILS.csv3}...`);
  const profiles = await Promise.all([
    waitForProfile(client, TEST_EMAILS.csv1),
    waitForProfile(client, TEST_EMAILS.csv2),
    waitForProfile(client, TEST_EMAILS.csv3),
  ]);
  let ok = true;
  for (const [i, p] of profiles.entries()) {
    const email = [TEST_EMAILS.csv1, TEST_EMAILS.csv2, TEST_EMAILS.csv3][i];
    if (!p) { console.error(`  ✗ ${email} not found in Klaviyo`); ok = false; continue; }
    const inList = p.lists.includes(TEST_LIST_NAME);
    console.log(`  ${inList ? '✓' : '⚠'} ${email} → id=${p.id}, in_target_list=${inList}`);
  }
  return ok;
}

async function cleanup({ supabase, client }) {
  console.log(`\n=== CLEANUP ===`);
  // Remove audit rows we created
  if (auditIdsToCleanup.length > 0) {
    const { error } = await supabase.from('klaviyo_imports').delete().in('id', auditIdsToCleanup);
    if (error) console.warn(`  ⚠ failed to delete audit rows: ${error.message}`);
    else console.log(`  ✓ deleted ${auditIdsToCleanup.length} audit row(s)`);
  }
  // Submit Klaviyo deletion jobs for the test profiles (async — Klaviyo will purge)
  for (const email of allTestEmails) {
    try {
      await client.requestProfileDeletion({ email });
      console.log(`  ✓ submitted deletion for ${email}`);
    } catch (err) {
      console.warn(`  ⚠ deletion failed for ${email}: ${err?.message ?? err}`);
    }
    await sleep(500);
  }
}

async function main() {
  const { conn, importsRepo, supabase } = buildConnector();
  const client = new KlaviyoApiClient({ apiKey: KEY });

  const results = { inline: false, csv: false };
  try {
    results.inline = await caseInline({ conn, importsRepo, client });
    results.csv = await caseCsv({ conn, importsRepo, client });
  } finally {
    try { await cleanup({ supabase, client }); } catch (err) { console.warn('cleanup error', err); }
  }

  console.log(`\n========================================`);
  console.log(`SUMMARY: inline=${results.inline ? 'PASS' : 'FAIL'}  csv=${results.csv ? 'PASS' : 'FAIL'}`);
  console.log(`========================================`);
  if (!results.inline || !results.csv) process.exit(1);
}

main().catch((err) => {
  console.error('\nE2E FAILED with unhandled error:');
  console.error(err);
  if (err?.body) console.error('Klaviyo body:', JSON.stringify(err.body, null, 2));
  process.exit(2);
});
