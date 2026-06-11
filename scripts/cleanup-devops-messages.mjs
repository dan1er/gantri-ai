// One-shot: re-render every existing devops job message with the new compact
// format (verbose detail moved to threads going forward). Idempotent — safe to
// re-run. Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SLACK_BOT_TOKEN.
// Run: node scripts/cleanup-devops-messages.mjs   (after `npx tsc`)
import { createClient } from '@supabase/supabase-js';
import { renderJobBlocks } from '../dist/devops/messages.js';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SLACK_BOT_TOKEN } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SLACK_BOT_TOKEN) {
  console.error('missing env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SLACK_BOT_TOKEN');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const toJob = (r) => ({
  id: r.id, kind: r.kind, target: r.target, status: r.status, spec: r.spec ?? {},
  requestedBy: r.requested_by, channelId: r.channel_id, messageTs: r.message_ts,
  runId: r.run_id, error: r.error, createdAt: r.created_at, updatedAt: r.updated_at,
  idlePingedAt: r.idle_pinged_at ?? null,
});

async function slack(method, payload) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

// Only preview + deploy renders changed; cron/e2e messages were already compact.
const { data, error } = await supabase
  .from('devops_jobs')
  .select('*')
  .in('kind', ['preview', 'deploy'])
  .not('message_ts', 'is', null)
  .order('created_at', { ascending: true });
if (error) throw new Error(error.message);

let ok = 0, skipped = 0, failed = 0;
for (const row of data) {
  const job = toJob(row);
  const blocks = renderJobBlocks(job);
  const res = await slack('chat.update', {
    channel: job.channelId, ts: job.messageTs,
    text: `${job.kind} ${job.status}`, blocks,
    unfurl_links: false, unfurl_media: false,
  });
  if (res.ok) ok += 1;
  else if (res.error === 'message_not_found' || res.error === 'cant_update_message' || res.error === 'channel_not_found') {
    skipped += 1; // deleted / too old / foreign — nothing to clean
  } else {
    failed += 1;
    console.error(`update failed for ${job.id} (${job.kind}/${job.status}): ${res.error}`);
  }
  await new Promise((r) => setTimeout(r, 350)); // stay well under Slack's rate limit
}
console.log(`updated=${ok} skipped=${skipped} failed=${failed} of ${data.length}`);
