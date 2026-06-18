// E2E smoke test: instantiate every tool the SendGrid connector exposes and
// call `tool.execute(...)` against the LIVE SendGrid account. Reports per-tool
// pass/fail with output snippet so we catch param/shape errors the unit tests
// can't (because they stub fetch).
//
// IMPORTANT: the Email Activity API requires the paid "Email Activity History"
// add-on on the SendGrid account. Without it every call returns
// { ok: false, error: { code: 'SENDGRID_ADDON_REQUIRED' } } and this script
// reports failures — that is an account billing setting, not a connector bug.
//
// Usage (the stub env vars are because the bot's logger loads env validation;
// they don't need real values):
//   SUPABASE_URL=https://x.supabase.co SUPABASE_SERVICE_ROLE_KEY=x \
//   ANTHROPIC_API_KEY=sk-ant-x SLACK_BOT_TOKEN=xoxb-x SLACK_SIGNING_SECRET=x \
//   SENDGRID_API_KEY=<key> node scripts/smoke-sendgrid-tools.mjs
//
// Pass a real-ish recipient as arg 1 to make email_activity return rows:
//   ... node scripts/smoke-sendgrid-tools.mjs customer@example.com
//
// Exits 0 if all tools succeed. 1 if any fails.

import { SendgridApiClient } from '../dist/connectors/sendgrid/client.js';
import { SendgridConnector } from '../dist/connectors/sendgrid/connector.js';

const KEY = process.env.SENDGRID_API_KEY;
if (!KEY) { console.error('SENDGRID_API_KEY env var required'); process.exit(2); }

const TO_EMAIL = process.argv[2] || 'support@gantri.com';

const client = new SendgridApiClient({ apiKey: KEY });
const conn = new SendgridConnector({ client });
const tools = new Map(conn.tools.map((t) => [t.name, t]));

let pass = 0;
let fail = 0;
let discoveredMsgId = null;

async function run(name, toolName, args) {
  const t = tools.get(toolName);
  if (!t) { console.log(`  ✗ ${name}  TOOL NOT FOUND`); fail++; return null; }
  try {
    const out = await t.execute(args);
    if (out && typeof out === 'object' && 'ok' in out && out.ok === false) {
      console.log(`  ✗ ${name}  ERROR  ${JSON.stringify(out.error).slice(0, 180)}`);
      fail++;
      return null;
    }
    console.log(`  ✓ ${name}  ${JSON.stringify(out).slice(0, 160)}...`);
    pass++;
    return out;
  } catch (err) {
    console.log(`  ✗ ${name}  THREW  ${(err && err.message ? err.message : String(err)).slice(0, 180)}`);
    fail++;
    return null;
  }
}

const a = await run(`sendgrid.email_activity (${TO_EMAIL})`, 'sendgrid.email_activity', { toEmail: TO_EMAIL, limit: 10 });
if (a && Array.isArray(a.rows) && a.rows.length > 0) discoveredMsgId = a.rows[0].msgId;

// Date-range variant (exercises the BETWEEN TIMESTAMP DSL clause).
await run(`sendgrid.email_activity (${TO_EMAIL}, last_30_days)`, 'sendgrid.email_activity', { toEmail: TO_EMAIL, limit: 10, dateRange: 'last_30_days' });

if (discoveredMsgId) {
  await run(`sendgrid.message_detail (${discoveredMsgId})`, 'sendgrid.message_detail', { msgId: discoveredMsgId });
} else {
  console.log('  (skipping sendgrid.message_detail — email_activity returned no msgId to drill into)');
}

console.log(`\n  ${pass} passed, ${fail} failed (of ${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
