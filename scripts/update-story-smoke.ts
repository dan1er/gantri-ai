/**
 * Real-API smoke of AsanaApiClient.updateStory (PUT /stories/{gid}) — the new
 * write path used by the authoritative pass to refresh an unchanged verdict.
 *
 * Strictly scoped to ONE disposable task it creates and, unconditionally, deletes:
 *   1. Create a throwaway task on the Software Board.
 *   2. createStory on it, then updateStory with new text — both through the REAL
 *      AsanaApiClient, so the URL shape / content-type / PAT permissions are the
 *      real thing.
 *   3. Assert the story text changed AND the task still carries exactly ONE
 *      comment (updated in place, not duplicated).
 *   4. finally: DELETE the task and verify it is gone.
 *
 * Run: `npx tsx scripts/update-story-smoke.ts`
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
try {
  process.loadEnvFile(path.join(repoRoot, '.env'));
} catch {
  try {
    process.loadEnvFile();
  } catch {
    /* env may already be populated by the shell */
  }
}
process.env.SLACK_BOT_TOKEN ??= 'smoke-unused';
process.env.SLACK_SIGNING_SECRET ??= 'smoke-unused';

const { readVaultSecret } = await import('../src/storage/supabase.js');
const { AsanaApiClient } = await import('../src/connectors/asana/client.js');
const { ASANA_API_BASE, SOFTWARE_BOARD_PROJECT_GID } = await import('../src/connectors/asana/board-config.js');

const TASK_NAME = '[TIER-BOT SMOKE] updateStory — ignore, auto-deleted in seconds';
const TEXT_V1 = '🤖 smoke: original comment (will be edited in place)';
const TEXT_V2 = '🤖 smoke: edited comment — updateStory works';

async function createTask(token: string): Promise<string> {
  const res = await fetch(`${ASANA_API_BASE}/tasks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { name: TASK_NAME, projects: [SOFTWARE_BOARD_PROJECT_GID] } }),
  });
  if (!res.ok) throw new Error(`createTask ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data: { gid: string } };
  return json.data.gid;
}

async function deleteTask(token: string, gid: string): Promise<number> {
  const res = await fetch(`${ASANA_API_BASE}/tasks/${gid}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.status;
}

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const asanaToken = await readVaultSecret(supabase, 'ASANA_ACCESS_TOKEN');
console.log('[smoke] vault: ASANA_ACCESS_TOKEN read OK');
const asana = new AsanaApiClient({ accessToken: asanaToken });

let taskGid: string | null = null;
try {
  taskGid = await createTask(asanaToken);
  console.log(`[smoke] task created: ${taskGid}`);

  const story = await asana.createStory(taskGid, TEXT_V1);
  console.log(`[smoke] story created: ${story.gid}`);

  const updated = await asana.updateStory(story.gid, TEXT_V2);
  console.log(`[smoke] updateStory returned gid=${updated?.gid ?? '(none)'}`);

  const stories = await asana.getTaskStories(taskGid, 'text,resource_subtype');
  const comments = stories.filter((s) => (s as { resource_subtype?: string }).resource_subtype === 'comment_added');
  if (comments.length !== 1) throw new Error(`expected exactly 1 comment, found ${comments.length}`);
  if (comments[0].text !== TEXT_V2) throw new Error(`comment text is "${comments[0].text}", expected "${TEXT_V2}"`);
  console.log('[smoke] PASS — single comment, edited in place');
} finally {
  if (taskGid) {
    const status = await deleteTask(asanaToken, taskGid);
    console.log(`[smoke] cleanup: DELETE task → ${status}`);
  }
}
