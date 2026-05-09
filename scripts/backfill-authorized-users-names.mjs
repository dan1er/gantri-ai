// One-shot backfill: populate authorized_users.name from Slack for every row
// where name IS NULL. Uses display_name -> profile.real_name -> top-level
// real_name precedence (display_name and real_name diverge for some users on
// our team — e.g. brooklyn@gantri.com has display_name "Zuzanna (Brooklyn S.)"
// while real_name is "Brooklyn S.").
//
// Run on Fly so it inherits SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars
// and reads SLACK_BOT_TOKEN from the Supabase vault, just like the bot does:
//
//   fly ssh console -a gantri-ai-bot -C 'cd /app && node scripts/backfill-authorized-users-names.mjs'
//
// Note: scripts/ is NOT copied into the production image by the Dockerfile.
// Either (a) `scp` this file into the running machine first
// (`fly ssh sftp shell -a gantri-ai-bot` then `put scripts/backfill-authorized-users-names.mjs /app/scripts/`),
// or (b) run it locally with `SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/backfill-authorized-users-names.mjs`
// after `npm run build` (which produces dist/).

import { WebClient } from '@slack/web-api';
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';

const supabase = getSupabase();
const slackBotToken = await readVaultSecret(supabase, 'SLACK_BOT_TOKEN');
const slack = new WebClient(slackBotToken);

const { data: rows, error } = await supabase
  .from('authorized_users')
  .select('slack_user_id, email, name')
  .is('name', null);
if (error) throw new Error(`authorized_users read failed: ${error.message}`);

console.log(`found ${rows.length} authorized_users rows with name IS NULL`);

let updated = 0;
let skipped = 0;
const failed = [];
for (const row of rows) {
  const slackUserId = row.slack_user_id;
  try {
    const info = await slack.users.info({ user: slackUserId });
    const user = info.user ?? {};
    const profile = user.profile ?? {};
    const name =
      (profile.display_name && profile.display_name.trim()) ||
      (profile.real_name && profile.real_name.trim()) ||
      (user.real_name && user.real_name.trim()) ||
      null;
    if (!name) {
      console.log(`  ${slackUserId} (${row.email ?? 'no email'}): no name in Slack profile; skipping`);
      skipped += 1;
      continue;
    }
    const upd = await supabase
      .from('authorized_users')
      .update({ name })
      .eq('slack_user_id', slackUserId);
    if (upd.error) {
      console.error(`  ${slackUserId}: update failed: ${upd.error.message}`);
      failed.push({ slackUserId, error: upd.error.message });
      continue;
    }
    console.log(`  ${slackUserId} (${row.email ?? 'no email'}) -> "${name}"`);
    updated += 1;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ${slackUserId}: users.info failed: ${msg}`);
    failed.push({ slackUserId, error: msg });
  }
}

console.log(`done. updated=${updated} skipped=${skipped} failed=${failed.length}`);
if (failed.length) {
  console.log('failed rows:', JSON.stringify(failed, null, 2));
  process.exit(1);
}
