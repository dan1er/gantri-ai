// One-shot: scan the ops channel for OLD-format bot messages that are NOT a
// job's canonical message (teardown copies left on idle pings / reuse notes)
// and delete them — their canonical counterpart already shows the state.
// Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SLACK_BOT_TOKEN, OPS_CHANNEL_ID.
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SLACK_BOT_TOKEN, OPS_CHANNEL_ID } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SLACK_BOT_TOKEN || !OPS_CHANNEL_ID) {
  console.error('missing env');
  process.exit(1);
}

async function slack(method, payload) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const { data: jobs, error } = await supabase.from('devops_jobs').select('message_ts').not('message_ts', 'is', null);
if (error) throw new Error(error.message);
const canonical = new Set(jobs.map((j) => j.message_ts));

// Who am I (only touch my own messages).
const auth = await slack('auth.test', {});
if (!auth.ok) throw new Error(`auth.test: ${auth.error}`);
const botUserId = auth.user_id;

let cursor;
let deleted = 0, kept = 0, scanned = 0;
do {
  const page = await slack('conversations.history', { channel: OPS_CHANNEL_ID, limit: 200, ...(cursor ? { cursor } : {}) });
  if (!page.ok) throw new Error(`history: ${page.error}`);
  for (const m of page.messages ?? []) {
    if (m.user !== botUserId && m.bot_id == null) continue; // not ours
    scanned += 1;
    if (canonical.has(m.ts)) continue; // the job's main message — already re-rendered
    const flat = JSON.stringify(m.blocks ?? []) + (m.text ?? '');
    // Old-format duplicates: a teardown render copied onto a ping/reuse note.
    const isStrayTeardown = flat.includes('tore down this preview');
    if (isStrayTeardown) {
      const res = await slack('chat.delete', { channel: OPS_CHANNEL_ID, ts: m.ts });
      if (res.ok) deleted += 1;
      else { kept += 1; console.error(`delete failed ${m.ts}: ${res.error}`); }
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  cursor = page.response_metadata?.next_cursor || undefined;
} while (cursor);
console.log(`scanned=${scanned} deleted=${deleted} kept=${kept}`);
